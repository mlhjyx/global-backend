/**
 * Site Builder provider-billing settlement readback is an opt-in deployment capability
 * (product owner decision 2026-10-29: the acquisition gateway must not read the model
 * proxy's billing log).
 *
 * The readback credential is the capability's identity: when it is absent, every
 * settlement gate reports healthy and paid Site Builder calls fail closed at call time.
 * When it is present, the keyring file and reconciliation catalog are still required
 * and validated, so a half-configured deployment keeps failing closed.
 */

const SETTLEMENT_READBACK_CREDENTIAL_ENV =
  'MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL';
const SETTLEMENT_READBACK_ENABLED_ENV =
  'NEW_API_SETTLEMENT_READBACK_ENABLED';

/**
 * True when the deployment asked for settlement readback and did not explicitly
 * disable it via `NEW_API_SETTLEMENT_READBACK_ENABLED=false|0|off|no`.
 */
export function settlementReadbackConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env[SETTLEMENT_READBACK_ENABLED_ENV]?.trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off' || flag === 'no') {
    return false;
  }
  const value = env[SETTLEMENT_READBACK_CREDENTIAL_ENV];
  return typeof value === 'string' && value.trim().length > 0;
}
