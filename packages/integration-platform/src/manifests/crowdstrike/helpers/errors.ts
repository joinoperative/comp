/**
 * Failure kinds that need their own remediation.
 *
 * Both exist because the generic read-failure text ("re-run the check; if it
 * keeps failing, contact support") is actively wrong for them: re-running never
 * fixes a wrong region or a revoked key.
 */

/** A problem with what is stored on the connection, not with Falcon. */
export class FalconConfigError extends Error {
  readonly isFalconConfigError = true;

  constructor(message: string) {
    super(message);
    this.name = 'FalconConfigError';
  }
}

/**
 * Falcon rejected the credentials themselves (token endpoint 400/401/403).
 *
 * Distinct from a device-API 403, which really does mean a missing scope. No
 * scope change fixes a rejected token exchange, so the two must not share
 * remediation text.
 */
export class FalconAuthError extends Error {
  readonly isFalconAuthError = true;
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'FalconAuthError';
    this.status = status;
  }
}

// instanceof alone is unreliable: this package runs both in the Nest server and
// in Trigger.dev, and a double-bundle gives two distinct class identities. The
// brand check keeps the specific remediation instead of silently falling back
// to "re-run and contact support".
export function isFalconConfigError(err: unknown): err is FalconConfigError {
  return (
    err instanceof FalconConfigError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isFalconConfigError?: boolean }).isFalconConfigError === true)
  );
}

export function isFalconAuthError(err: unknown): err is FalconAuthError {
  return (
    err instanceof FalconAuthError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isFalconAuthError?: boolean }).isFalconAuthError === true)
  );
}
