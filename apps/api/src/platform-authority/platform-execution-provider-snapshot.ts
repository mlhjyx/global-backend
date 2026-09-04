import { types } from "node:util";

import {
  PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  PlatformExecutionContractError,
  type PlatformExecutionProviderSnapshotEntryV1,
  type PlatformExecutionProviderSnapshotV1,
  type PlatformExecutionScheduleId,
} from "./platform-execution-contract";

const SHA256 = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SNAPSHOT_KEYS = ["schemaVersion", "scheduleId", "providers"] as const;
const SNAPSHOT_PROVIDER_KEYS = [
  "providerId",
  "providerVersion",
  "enablement",
  "bytePriceCatalogRevision",
] as const;
const CODE_OWNED_PROVIDER_SNAPSHOTS = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownDataSnapshot(
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !==
        [...expected].sort().join("\0")
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function exactArraySnapshot(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      lengthDescriptor.enumerable ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < minimumLength ||
      lengthDescriptor.value > maximumLength ||
      ownKeys.length !== lengthDescriptor.value + 1
    ) {
      return null;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

export function createPlatformExecutionProviderSnapshotV1(
  input: unknown,
): PlatformExecutionProviderSnapshotV1 {
  const snapshot = ownDataSnapshot(input, SNAPSHOT_KEYS);
  if (!snapshot) throw new PlatformExecutionContractError();
  const providerInputs = exactArraySnapshot(snapshot.providers, 1, 4);
  if (
    snapshot.schemaVersion !== "platform-execution-provider-snapshot/v1" ||
    !PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows.some(
      (row) => row.scheduleId === snapshot.scheduleId,
    ) ||
    !providerInputs
  ) {
    throw new PlatformExecutionContractError();
  }
  const providers: PlatformExecutionProviderSnapshotEntryV1[] = [];
  for (const raw of providerInputs) {
    const provider = ownDataSnapshot(raw, SNAPSHOT_PROVIDER_KEYS);
    if (
      !provider ||
      typeof provider.providerId !== "string" ||
      !PROVIDER_ID.test(provider.providerId) ||
      typeof provider.providerVersion !== "string" ||
      !VERSION.test(provider.providerVersion) ||
      (provider.enablement !== "ENABLED" &&
        provider.enablement !== "DISABLED") ||
      (provider.bytePriceCatalogRevision !== null &&
        (typeof provider.bytePriceCatalogRevision !== "string" ||
          !SHA256.test(provider.bytePriceCatalogRevision)))
    ) {
      throw new PlatformExecutionContractError();
    }
    providers.push({
      providerId: provider.providerId,
      providerVersion: provider.providerVersion,
      enablement: provider.enablement,
      bytePriceCatalogRevision: provider.bytePriceCatalogRevision,
    } as PlatformExecutionProviderSnapshotEntryV1);
  }
  for (let left = 0; left < providers.length; left += 1) {
    for (let right = left + 1; right < providers.length; right += 1) {
      if (providers[left]!.providerId === providers[right]!.providerId) {
        throw new PlatformExecutionContractError();
      }
    }
  }
  const result = deepFreeze({
    schemaVersion: "platform-execution-provider-snapshot/v1" as const,
    scheduleId: snapshot.scheduleId as PlatformExecutionScheduleId,
    providers,
  });
  CODE_OWNED_PROVIDER_SNAPSHOTS.add(result);
  return result;
}

export function isCodeOwnedPlatformExecutionProviderSnapshotV1(
  input: unknown,
): input is PlatformExecutionProviderSnapshotV1 {
  return Boolean(
    input !== null &&
      typeof input === "object" &&
      CODE_OWNED_PROVIDER_SNAPSHOTS.has(input),
  );
}
