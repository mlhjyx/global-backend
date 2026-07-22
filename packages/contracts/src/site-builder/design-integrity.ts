import { createHash } from "node:crypto";

/** Stable JSON for digests that fence catalog and family revisions. */
export function canonicalDesignJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("DESIGN_CONTRACT_NON_JSON_VALUE");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalDesignJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined)
          throw new Error("DESIGN_CONTRACT_NON_JSON_VALUE");
        return `${JSON.stringify(key)}:${canonicalDesignJson(record[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("DESIGN_CONTRACT_NON_JSON_VALUE");
}

export function designSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalDesignJson(value), "utf8")
    .digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonBlankString);
}

/** Machine-readable clean-room descriptor, never retained source prose. */
export function isDesignAbstractionCode(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.length <= 80 &&
    /^[a-z](?:[a-z0-9]*(?:[-_][a-z0-9]+)*)$/.test(value)
  );
}

export function isDesignAbstractionCodeArray(
  value: unknown,
): value is string[] {
  return Array.isArray(value) && value.every(isDesignAbstractionCode);
}

export function isDesignRatioBand(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,2}:\d{1,2}$/.test(value);
}

export function isDesignRatioBandArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isDesignRatioBand);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidTimestamp(value: unknown): value is string {
  return isNonBlankString(value) && Number.isFinite(Date.parse(value));
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
