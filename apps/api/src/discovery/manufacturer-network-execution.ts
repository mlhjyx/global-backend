/** Workflow-safe request marker. It authorizes no source, publisher or URL by itself. */
export const MANUFACTURER_NETWORK_REVISION = "manufacturer-network/v1" as const;
export const MANUFACTURER_NETWORK_PROFILE_REVISION =
  "manufacturer-network/v2" as const;
export type ManufacturerNetworkRevision =
  | typeof MANUFACTURER_NETWORK_REVISION
  | typeof MANUFACTURER_NETWORK_PROFILE_REVISION;
export function isManufacturerNetworkRevision(
  value: unknown,
): value is ManufacturerNetworkRevision {
  return (
    value === MANUFACTURER_NETWORK_REVISION ||
    value === MANUFACTURER_NETWORK_PROFILE_REVISION
  );
}
const SNAPSHOT_VERSION = "manufacturer-network-execution/v1" as const;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export interface ManufacturerNetworkExecuteBody {
  readonly attemptId?: string;
  readonly manufacturerNetworkRevision?: ManufacturerNetworkRevision;
}

export interface ManufacturerNetworkExecutionSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_VERSION;
  readonly planId: string;
  readonly body: Readonly<
    ManufacturerNetworkExecuteBody & {
      manufacturerNetworkRevision: ManufacturerNetworkRevision;
    }
  >;
}

function invalid(): never {
  throw new Error("MANUFACTURER_NETWORK_EXECUTION_INVALID");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some((entry) => !Object.hasOwn(entry, "value"))
  )
    return invalid();
  return value as Record<string, unknown>;
}

/** Strictly normalizes only plan-execute fields; no generic ICP/plan generation options. */
export function readManufacturerNetworkExecutionBody(
  value: unknown,
): Readonly<ManufacturerNetworkExecuteBody> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  const keys = Object.keys(input);
  if (
    !keys.length ||
    keys.some(
      (key) => key !== "attemptId" && key !== "manufacturerNetworkRevision",
    )
  )
    return invalid();
  const hasAttempt = Object.hasOwn(input, "attemptId");
  const hasRevision = Object.hasOwn(input, "manufacturerNetworkRevision");
  if (
    hasAttempt &&
    (typeof input.attemptId !== "string" || !UUID.test(input.attemptId))
  )
    return invalid();
  if (
    hasRevision &&
    !isManufacturerNetworkRevision(input.manufacturerNetworkRevision)
  )
    return invalid();
  return Object.freeze({
    ...(hasAttempt ? { attemptId: input.attemptId as string } : {}),
    ...(hasRevision
      ? {
          manufacturerNetworkRevision:
            input.manufacturerNetworkRevision as ManufacturerNetworkRevision,
        }
      : {}),
  });
}

/** Missing marker leaves legacy histories byte-compatible: no new snapshot or tool calls. */
export function manufacturerNetworkExecutionSnapshot(
  planId: string,
  value: unknown,
): ManufacturerNetworkExecutionSnapshot | undefined {
  const body = readManufacturerNetworkExecutionBody(value);
  const revision = body?.manufacturerNetworkRevision;
  if (!isManufacturerNetworkRevision(revision)) return undefined;
  if (!UUID.test(planId)) return invalid();
  return Object.freeze({
    schemaVersion: SNAPSHOT_VERSION,
    planId,
    body: Object.freeze({
      ...body,
      manufacturerNetworkRevision: revision,
    }),
  });
}

/** Reading a frozen history marker is structure validation, never a substitute for Grant hash validation. */
export function readManufacturerNetworkExecutionSnapshot(
  value: unknown,
): ManufacturerNetworkExecutionSnapshot | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    keys.some((key) => !["schemaVersion", "planId", "body"].includes(key)) ||
    input.schemaVersion !== SNAPSHOT_VERSION ||
    typeof input.planId !== "string"
  )
    return invalid();
  const snapshot = manufacturerNetworkExecutionSnapshot(
    input.planId,
    input.body,
  );
  return snapshot ?? invalid();
}
