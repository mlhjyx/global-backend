/**
 * Development-verifier-only workflow entrypoint.
 *
 * Production workers never bundle this file. The verifier guards loopback global_dev/MinIO/
 * Temporal plus ALLOW_DEV_DB_VERIFIER before creating its dedicated worker. Keeping shortened
 * timings here (rather than in the command) means no client or durable Outbox event can weaken
 * the production 15-minute in-flight grace or 5-minute settle window.
 */
import type { AssetCleanupCommand } from '../../src/temporal/asset-cleanup.contract';
import { runAssetObjectCleanup } from '../../src/temporal/asset-cleanup.workflow';

const VERIFIER_IN_FLIGHT_GRACE_MS = 1_000;
const VERIFIER_SETTLE_MS = 2_000;

export async function assetObjectCleanupWorkflow(input: AssetCleanupCommand) {
  return runAssetObjectCleanup(input, {
    inFlightGraceMs: VERIFIER_IN_FLIGHT_GRACE_MS,
    settleMs: VERIFIER_SETTLE_MS,
  });
}
