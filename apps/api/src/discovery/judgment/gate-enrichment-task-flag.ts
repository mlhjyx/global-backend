/**
 * Feature flag controlling writes to the currently unconsumed `gate_enrichment_task` table.
 *
 * Defaults to `false` (writes disabled) to prevent dead-queue row accumulation while keeping
 * table schema, Prisma queries, and `GateEvaluation.unknownGates` read compatibility intact.
 * Enable explicitly via `GATE_ENRICHMENT_TASK_WRITE_ENABLED=on|true|1`.
 */
export const GATE_ENRICHMENT_TASK_WRITE_ENV =
  'GATE_ENRICHMENT_TASK_WRITE_ENABLED';

export function isGateEnrichmentTaskWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[GATE_ENRICHMENT_TASK_WRITE_ENV]?.trim().toLowerCase();
  return raw === 'on' || raw === 'true' || raw === '1';
}
