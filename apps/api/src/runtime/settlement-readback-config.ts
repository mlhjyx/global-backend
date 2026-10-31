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

/** True when the deployment asked for settlement readback. */
export function settlementReadbackConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[SETTLEMENT_READBACK_CREDENTIAL_ENV];
  return typeof value === 'string' && value.trim().length > 0;
}
