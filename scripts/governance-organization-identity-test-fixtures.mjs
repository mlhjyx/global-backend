import { createHash } from "node:crypto";

export const SHA = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const COMMIT = "1".repeat(40);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function sha256Of(value) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalJsonBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
}
