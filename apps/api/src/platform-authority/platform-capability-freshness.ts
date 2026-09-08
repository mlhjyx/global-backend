/** Pure structural freshness calculation. A deadline never proves a signature,
 * identity, permission or readiness: callers must separately verify those facts.
 * All instants are integer Unix milliseconds; no coercion is permitted. */
const MAX_AGE_MS = 30_000;
const ROOT_KEYS = [
  "issuedAt",
  "expiresAt",
  "temporalPermission",
  "issuer",
  "revocationConsumer",
  "undeliveredCount",
  "oldestUndeliveredCreatedAt",
] as const;
const FACT_KEYS = ["observedAt", "validUntil"] as const;

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    !keys.every(
      (key) =>
        descriptors[key]?.enumerable === true &&
        Object.hasOwn(descriptors[key], "value"),
    )
  )
    return null;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function factDeadline(
  value: unknown,
  now: number,
  consumer: boolean,
): number | null {
  const fact = record(value, FACT_KEYS);
  if (
    !fact ||
    !instant(fact.observedAt) ||
    !instant(fact.validUntil) ||
    fact.observedAt > now ||
    fact.validUntil <= now ||
    fact.validUntil <= fact.observedAt
  )
    return null;
  if (
    consumer &&
    (now - fact.observedAt >= MAX_AGE_MS ||
      fact.validUntil - fact.observedAt > MAX_AGE_MS)
  )
    return null;
  return fact.validUntil;
}

/** Returns null at the exact expiry boundary and for all invalid inputs. */
export function capabilityValidUntil(
  value: unknown,
  now: number,
): number | null {
  try {
    if (!instant(now)) return null;
    const snapshot = record(value, ROOT_KEYS);
    if (
      !snapshot ||
      !instant(snapshot.issuedAt) ||
      !instant(snapshot.expiresAt) ||
      snapshot.issuedAt > now ||
      snapshot.expiresAt <= now ||
      snapshot.expiresAt <= snapshot.issuedAt ||
      snapshot.expiresAt - snapshot.issuedAt > MAX_AGE_MS
    )
      return null;
    const temporal = factDeadline(snapshot.temporalPermission, now, false);
    const issuer = factDeadline(snapshot.issuer, now, false);
    const consumer = factDeadline(snapshot.revocationConsumer, now, true);
    if (temporal === null || issuer === null || consumer === null) return null;
    const count = snapshot.undeliveredCount;
    if (!instant(count)) return null;
    const oldest = snapshot.oldestUndeliveredCreatedAt;
    let backlogDeadline = snapshot.expiresAt;
    if (count === 0) {
      if (oldest !== null) return null;
    } else {
      if (!instant(oldest) || oldest > now || now - oldest >= MAX_AGE_MS)
        return null;
      backlogDeadline = oldest + MAX_AGE_MS;
      if (!instant(backlogDeadline)) return null;
    }
    return Math.min(
      snapshot.expiresAt,
      temporal,
      issuer,
      consumer,
      backlogDeadline,
    );
  } catch {
    // Hostile object descriptors/proxies cannot escape the bounded parser.
    return null;
  }
}
