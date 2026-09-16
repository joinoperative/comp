/**
 * Reading Falcon's response envelope safely.
 *
 * Falcon wraps everything in `{ resources, errors, meta }`, and every one of
 * those fields has been observed in a shape the naive read did not expect. Kept
 * separate from collect.ts so the paging logic stays readable, and for the
 * repo's 300-line ceiling.
 */

import type { FalconEnvelope } from '../types';

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

export function describeErrors(errors: Array<{ code: number; message: string }>): string {
  const first = errors[0]!;
  const extra = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
  return `Falcon returned an error: ${first.message}${extra}`;
}

export function asError(errors: Array<{ code: number; message: string }>): Error {
  const error = new Error(describeErrors(errors));
  (error as Error & { status: number }).status = errors[0]!.code;
  return error;
}

/**
 * A malformed success body must not throw outside a guarded boundary: that
 * surfaces as `status: 'error'` with zero findings, which the scheduler records
 * as a *successful* run.
 */
export function readArray<T>(envelope: FalconEnvelope<T[]>, what: string): T[] {
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
