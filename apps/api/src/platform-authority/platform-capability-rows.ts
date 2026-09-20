import { capabilityValidUntil } from "./platform-capability-freshness";

export interface CapabilityScheduleBinding {
  readonly scheduleId: string;
  readonly workflowType: string;
  readonly taskQueue: string;
  readonly mode: "ENABLED" | "INTENTIONALLY_DISABLED_NO_EGRESS";
}
export interface ValidatedCapabilityRow {
  readonly scheduleId: string;
  readonly mode: CapabilityScheduleBinding["mode"];
  readonly validUntil: number;
}
const ROW_KEYS = [
  "scheduleId",
  "workflowType",
  "taskQueue",
  "mode",
  "temporalPermission",
  "issuer",
  "revocationConsumer",
  "undeliveredCount",
  "oldestUndeliveredCreatedAt",
];
function fail(): never {
  throw new Error("PLATFORM_CAPABILITY_INVALID");
}
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
// JWT iat has second precision; a fact may fall within that same second.
// capabilityValidUntil separately rejects facts later than the actual clock.
function fact(value: unknown, issuedAt: number) {
  if (
    !exact(value, ["status", "observedAt", "validUntil"]) ||
    value.status !== "ok" ||
    typeof value.observedAt !== "number" ||
    value.observedAt - issuedAt >= 1000
  )
    fail();
  return { observedAt: value.observedAt, validUntil: value.validUntil };
}
/** Accepts rows only after signature/context verification. Structural success
 * still cannot issue Grants or prove one particular Workflow execution. */
export function validateCapabilityRows(
  rows: unknown,
  expected: readonly CapabilityScheduleBinding[],
  issuedAt: number,
  expiresAt: number,
  now: number,
): readonly ValidatedCapabilityRow[] {
  try {
    if (
      !Array.isArray(rows) ||
      expected.length === 0 ||
      expected.length > 4 ||
      rows.length !== expected.length ||
      new Set(expected.map((x) => x.scheduleId)).size !== expected.length ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < 0 ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(now) ||
      issuedAt > now ||
      expiresAt <= now ||
      expiresAt - issuedAt > 30_000
    )
      fail();
    const seen = new Set<string>();
    const result = rows.map((row: unknown) => {
      if (
        !exact(row, ROW_KEYS) ||
        typeof row.scheduleId !== "string" ||
        seen.has(row.scheduleId)
      )
        fail();
      seen.add(row.scheduleId);
      const binding = expected.find((x) => x.scheduleId === row.scheduleId);
      if (
        !binding ||
        row.workflowType !== binding.workflowType ||
        row.taskQueue !== binding.taskQueue ||
        row.mode !== binding.mode
      )
        fail();
      if (binding.mode === "INTENTIONALLY_DISABLED_NO_EGRESS") {
        // Policy determines disabled status. No external health fact can enable it.
        if (
          row.undeliveredCount !== 0 ||
          row.oldestUndeliveredCreatedAt !== null
        )
          fail();
        return Object.freeze({
          scheduleId: binding.scheduleId,
          mode: binding.mode,
          validUntil: expiresAt,
        });
      }
      const deadline = capabilityValidUntil(
        {
          issuedAt,
          expiresAt,
          temporalPermission: fact(row.temporalPermission, issuedAt),
          issuer: fact(row.issuer, issuedAt),
          revocationConsumer: fact(row.revocationConsumer, issuedAt),
          undeliveredCount: row.undeliveredCount,
          oldestUndeliveredCreatedAt: row.oldestUndeliveredCreatedAt,
        },
        now,
      );
      if (deadline === null) fail();
      return Object.freeze({
        scheduleId: binding.scheduleId,
        mode: binding.mode,
        validUntil: deadline,
      });
    });
    return Object.freeze(result);
  } catch {
    return fail();
  }
}
