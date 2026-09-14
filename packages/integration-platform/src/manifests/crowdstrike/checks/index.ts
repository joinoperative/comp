/**
 * Check Exports
 *
 * Add each new check here and to `checks` in ../index.ts.
 *
 * Still to build (these are the checks Comp AI's hosted version ships):
 * - prevention-policy: prevention policies exist and are enabled
 * - vulnerability-management: open Spotlight vulnerabilities
 * - employee-access: who can log into the Falcon console
 */

export { sensorCoverageCheck } from './sensor-coverage';
