/**
 * Reading the Falcon host inventory.
 *
 * Split from sensor-health.ts so the collection rules (paging, batching,
 * reconciliation) can be read and tested without the health logic, and to keep
 * both files inside the repo's 300-line ceiling.
 */

import type { CheckContext } from '../../../types';
import { toHttpReadFailure, type ReadFailure } from '../../http-read-failure';
import type { FalconDevice, FalconEnvelope } from '../types';

/** Falcon caps `ids` lookups; 100 per request keeps the GET URL well inside limits. */
export const DEVICE_DETAIL_BATCH_SIZE = 100;

/** Page size for the device id scroll. */
export const DEVICE_QUERY_LIMIT = 500;

/**
 * Hard stop on pagination, mirroring MAX_PAGES_DEFAULT in
 * runtime/check-context.ts. Without a cap, an endpoint that ignores the cursor
 * loops forever accumulating ids.
 *
 * 500 ids x 100 pages is a 50,000-device ceiling. That is far above any tenant
 * this integration currently serves; a larger one hits the truncation finding
 * rather than silently reporting a partial fleet, which is the property that
 * matters.
 */
export const MAX_DEVICE_PAGES = 100;

export interface EnrolledDevices {
  ids: string[];
  /** Set when the id sweep could not be completed; ids may be partial. */
  readFailure?: ReadFailure;
  /** True when the page cap stopped the sweep, so coverage is known-partial. */
  truncated: boolean;
}

/** A batch Falcon would not serve at all, kept with why it failed. */
export interface UnreadableBatch {
  ids: string[];
  failure: ReadFailure;
}

export interface DeviceDetails {
  devices: FalconDevice[];
  /**
   * Ids absent from an otherwise successful response — a record that genuinely
   * did not come back, which is what a device decommissioned mid-run looks like.
   *
   * Deliberately separate from `unreadable`: collapsing the two reported a
   * revoked scope as "device decommissioned?" with re-run advice that could
   * never fix it.
   */
  unreturned: string[];
  /** Per-id errors Falcon reported alongside an HTTP 200. */
  envelopeErrors: Array<{ code: number; message: string }>;
  /** Batches that could not be read at all, each with its own classification. */
  unreadable: UnreadableBatch[];
}

/** Read the scroll cursor, which Falcon returns as a string in either field. */
export function readCursor(meta: FalconEnvelope<string[]>['meta']): string | undefined {
  const pagination = meta?.pagination;
  if (!pagination) return undefined;
  if (typeof pagination.offset_string === 'string' && pagination.offset_string) {
    return pagination.offset_string;
  }
  // The scroll endpoint returns an opaque string here; the offset endpoint
  // returns a number, which is not a cursor and must not be treated as one.
  if (typeof pagination.offset === 'string' && pagination.offset) {
    return pagination.offset;
  }
  return undefined;
}

/**
 * A non-empty `errors` array on an HTTP 200.
 *
 * Returned as data rather than thrown: for a *detail* response this arrives
 * alongside perfectly good `resources` (Falcon reports one decommissioned host
 * as a per-id error next to 99 live ones), so the caller must record it without
 * discarding the batch.
 */
export function envelopeErrors(
  envelope: FalconEnvelope<unknown>,
): Array<{ code: number; message: string }> {
  // `errors?.length` alone is truthy for a string, which then yields
  // "Falcon returned an error: undefined" and loses the 401/403 classification.
  const errors = envelope.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((e): e is { code: number; message: string } => typeof e === 'object' && e !== null)
    .map((e) => ({
      code: typeof e.code === 'number' ? e.code : 0,
      message: typeof e.message === 'string' ? e.message : 'unspecified error',
    }));
}

function describeErrors(errors: Array<{ code: number; message: string }>): string {
  const first = errors[0]!;
  const extra = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  return `Falcon returned an error: ${first.message}${extra}`;
}

function asError(errors: Array<{ code: number; message: string }>): Error {
  const error = new Error(describeErrors(errors));
  (error as Error & { status: number }).status = errors[0]!.code;
  return error;
}

/**
 * A malformed success body must not throw outside a guarded boundary: that
 * surfaces as `status: 'error'` with zero findings, which the scheduler records
 * as a *successful* run.
 */
function readArray<T>(envelope: FalconEnvelope<T[]>, what: string): T[] {
  const resources = envelope.resources;
  // `undefined` is a legitimately absent key; `null` is a malformed body, and
  // reading it as [] turned a broken response into the high-severity
  // "No devices are enrolled" finding.
  if (resources === undefined) return [];
  if (!Array.isArray(resources)) {
    throw new Error(`Falcon returned a malformed ${what} response (resources was not a list).`);
  }
  return resources;
}

/** Walk the device-id scroll, deduping and capping pages. */
export async function listEnrolledDeviceIds(
  ctx: CheckContext,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<EnrolledDevices> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  while (pages < MAX_DEVICE_PAGES) {
    pages += 1;

    const params: Record<string, string> = { limit: String(DEVICE_QUERY_LIMIT) };
    if (cursor) params.offset = cursor;

    let page: FalconEnvelope<string[]>;
    let pageIds: string[];
    try {
      // devices-scroll rather than devices/v1: the offset endpoint caps out
      // around 10k results, and offset paging over a live inventory can repeat
      // a device across pages.
      page = await ctx.fetch<FalconEnvelope<string[]>>('/devices/queries/devices-scroll/v1', {
        baseUrl,
        headers,
        params,
      });

      const errors = envelopeErrors(page);
      // On the *sweep* a per-id error has no meaning — the whole page is
      // suspect, so this one is fatal, unlike the detail path.
      if (errors.length) throw asError(errors);

      pageIds = readArray(page, 'device list');
    } catch (err) {
      return { ids: [...ids], readFailure: toHttpReadFailure(err), truncated: false };
    }

    for (const id of pageIds) ids.add(id);
    cursor = readCursor(page.meta);

    if (pageIds.length === 0 || !cursor) {
      // A page filled exactly to the limit with no cursor is ambiguous: either
      // the inventory ended on a page boundary, or the response shape changed
      // and the rest of the fleet is silently missing. `total` is what tells
      // them apart, so it is only trusted here — never as the loop's exit
      // condition, which is the bug that reported a partial fleet as clean.
      if (pageIds.length >= DEVICE_QUERY_LIMIT) {
        const total = page.meta?.pagination?.total;
        if (typeof total === 'number' && ids.size >= total) {
          return { ids: [...ids], truncated: false };
        }
        return {
          ids: [...ids],
          readFailure: toHttpReadFailure(
            new Error(
              `Falcon returned a full page of ${pageIds.length} devices with no cursor to continue from, and no device total to confirm the list was complete.`,
            ),
          ),
          truncated: false,
        };
      }
      return { ids: [...ids], truncated: false };
    }
  }

  ctx.warn(`Stopped after ${MAX_DEVICE_PAGES} pages of Falcon devices; results are partial.`);
  return { ids: [...ids], truncated: true };
}

/**
 * Fetch details for every enrolled id, reconciling what comes back.
 *
 * `reauth` is called at most once, when Falcon rejects a batch with 401/403: the
 * cached token may have been revoked or rotated mid-run. If the retry is
 * rejected too, collection stops — every remaining batch would be rejected
 * identically, and sending them is hundreds of pointless unauthorized calls on
 * a large tenant.
 */
export async function fetchDeviceDetails(
  ctx: CheckContext,
  baseUrl: string,
  initialHeaders: Record<string, string>,
  deviceIds: string[],
  reauth?: () => Promise<Record<string, string>>,
): Promise<DeviceDetails> {
  const devices: FalconDevice[] = [];
  const unreturned: string[] = [];
  const collectedErrors: Array<{ code: number; message: string }> = [];
  const unreadable: UnreadableBatch[] = [];

  let headers = initialHeaders;
  let reauthed = false;

  const batches: string[][] = [];
  for (let i = 0; i < deviceIds.length; i += DEVICE_DETAIL_BATCH_SIZE) {
    batches.push(deviceIds.slice(i, i + DEVICE_DETAIL_BATCH_SIZE));
  }

  for (const [index, batch] of batches.entries()) {
    // Falcon expects `ids` repeated once per device (?ids=a&ids=b), not a
    // single comma-joined value — it reads a comma-joined string as one id and
    // rejects it with "invalid device id". ctx.fetch's `params` is a
    // Record<string, string> and so cannot express a repeated key, so the
    // query string is built onto the path instead.
    const path = `/devices/entities/devices/v2?${batch
      .map((id) => `ids=${encodeURIComponent(id)}`)
      .join('&')}`;

    let failure: ReadFailure | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const details = await ctx.fetch<FalconEnvelope<FalconDevice[]>>(path, {
          baseUrl,
          headers,
        });

        // Recorded, NOT fatal. Falcon returns 99 resources plus one per-id error
        // when a host is decommissioned between the sweep and this call; bailing
        // out here threw away 99 devices' evidence and failed the whole run on a
        // routine race.
        collectedErrors.push(...envelopeErrors(details));
        const returned = readArray(details, 'device details');

        devices.push(...returned);
        const returnedIds = new Set(returned.map((d) => d.device_id));
        unreturned.push(...batch.filter((id) => !returnedIds.has(id)));

        failure = undefined;
        break;
      } catch (err) {
        failure = toHttpReadFailure(err);

        // One re-mint, then give up: a second rejection means the credentials
        // themselves are the problem, not a stale token.
        if (failure.denied && reauth && !reauthed && attempt === 0) {
          reauthed = true;
          headers = await reauth();
          continue;
        }
        break;
      }
    }

    if (!failure) continue;

    unreadable.push({ ids: batch, failure });

    if (failure.denied) {
      // Every remaining batch would be rejected the same way.
      const remaining = batches.slice(index + 1).flat();
      if (remaining.length) unreadable.push({ ids: remaining, failure });
      ctx.warn(
        `Falcon rejected a device read; stopped after ${index + 1} of ${batches.length} batches.`,
      );
      break;
    }
  }

  return { devices, unreturned, envelopeErrors: collectedErrors, unreadable };
}
