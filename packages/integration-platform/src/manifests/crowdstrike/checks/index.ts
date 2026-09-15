/**
 * Check Exports
 *
 * Add each new check here and to `checks` in ../index.ts.
 *
 * Still to build (these are the checks Comp AI's hosted version ships):
 * - prevention-policy: prevention policies exist and are enabled
 * - vulnerability-management: open Spotlight vulnerabilities
 * - employee-access: who can log into the Falcon console
 *
 * Each of those needs its own Falcon scope. Add the scope to
 * `setupInstructions` in ../index.ts when the check that needs it lands, not
 * before — asking for scopes nothing uses is how a read-only integration ends
 * up over-permissioned.
 */

export { sensorHealthCheck } from './sensor-health';
