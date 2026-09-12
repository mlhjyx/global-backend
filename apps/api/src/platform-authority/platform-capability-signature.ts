import { compactVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import { TextDecoder } from "node:util";

export interface CapabilityEnvelopeBinding {
  readonly issuer: string;
  readonly audience: string;
  readonly nonce: string;
  readonly backendSha: string;
  readonly growthosSha: string;
  readonly policyDigest: string;
}
const HEADER_KEYS = ["alg", "kid", "typ"];
const PAYLOAD_KEYS = [
  "iss",
  "aud",
  "iat",
  "exp",
  "nonce",
  "backendSha",
  "growthosSha",
  "policyDigest",
  "namespace",
  "rows",
];
function fail(): never {
  throw new Error("PLATFORM_CAPABILITY_INVALID");
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.hasOwn(value, k))
  );
}
function compactJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  // Closed wire encoding: compact JSON, without duplicate members or lossy
  // number/escape rewrites. GrowthOS must serialize this same contract.
  if (JSON.stringify(parsed) !== text) fail();
  return parsed;
}
/** Verifies only the envelope and context. Returned rows are untrusted until
 * schedule, fact and freshness validators run; this function cannot grant ready.
 * JWKS and allowedKids must come from the controlled capability trust root,
 * never from the response, caller headers or an ordinary identity-key set. */
export async function verifyCapabilityEnvelope(
  token: unknown,
  expected: CapabilityEnvelopeBinding,
  jwks: JSONWebKeySet,
  allowedKids: readonly string[],
  now: number,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    if (
      typeof token !== "string" ||
      Buffer.byteLength(token, "utf8") > 16384 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      fail();
    const expectedCopy = { ...expected };
    const keyIds = [...allowedKids];
    if (
      keyIds.length === 0 ||
      keyIds.length > 16 ||
      new Set(keyIds).size !== keyIds.length ||
      !keyIds.every((k) => /^[A-Za-z0-9._:-]{1,128}$/.test(k)) ||
      !/^[a-f0-9]{32}$/.test(expectedCopy.nonce) ||
      ![expectedCopy.backendSha, expectedCopy.growthosSha].every((v) =>
        /^[a-f0-9]{40}$/.test(v),
      ) ||
      !/^[a-f0-9]{64}$/.test(expectedCopy.policyDigest) ||
      !expectedCopy.issuer ||
      expectedCopy.audience !== "platform-automation-capability-read"
    )
      fail();
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts.some(
        (p) =>
          !p ||
          !/^[A-Za-z0-9_-]+$/.test(p) ||
          Buffer.from(p, "base64url").toString("base64url") !== p,
      )
    )
      fail();
    const header = compactJson(Buffer.from(parts[0], "base64url"));
    if (
      !exact(header, HEADER_KEYS) ||
      header.alg !== "RS256" ||
      header.typ !== "platform-capability+jwt" ||
      typeof header.kid !== "string" ||
      !keyIds.includes(header.kid)
    )
      fail();
    // Snapshot trusted key data before awaiting verification.
    const keys = JSON.parse(JSON.stringify(jwks)) as JSONWebKeySet;
    if (
      !Array.isArray(keys.keys) ||
      keys.keys.length === 0 ||
      keys.keys.length > 16
    )
      fail();
    const kids = keys.keys.map((k) => k.kid);
    if (new Set(kids).size !== kids.length) fail();
    const key = keys.keys.find((k) => k.kid === header.kid);
    if (
      !key ||
      key.kty !== "RSA" ||
      key.use !== "sig" ||
      key.alg !== "RS256" ||
      key.d !== undefined ||
      (key.key_ops !== undefined &&
        (key.key_ops.length !== 1 || key.key_ops[0] !== "verify"))
    )
      fail();
    const verified = await compactVerify(
      token,
      createLocalJWKSet({ keys: [key] }),
      { algorithms: ["RS256"] },
    );
    const payload = compactJson(verified.payload);
    if (
      !exact(payload, PAYLOAD_KEYS) ||
      payload.iss !== expectedCopy.issuer ||
      payload.aud !== expectedCopy.audience ||
      payload.nonce !== expectedCopy.nonce ||
      payload.backendSha !== expectedCopy.backendSha ||
      payload.growthosSha !== expectedCopy.growthosSha ||
      payload.policyDigest !== expectedCopy.policyDigest ||
      payload.namespace !== "platform-automation" ||
      !Array.isArray(payload.rows) ||
      payload.rows.length > 4 ||
      typeof payload.iat !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      payload.iat < 0 ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 30 ||
      payload.iat > now / 1000 ||
      payload.exp <= now / 1000
    )
      fail();
    return Object.freeze(payload);
  } catch {
    // Do not propagate token, key or transport details into diagnostics.
    return fail();
  }
}
