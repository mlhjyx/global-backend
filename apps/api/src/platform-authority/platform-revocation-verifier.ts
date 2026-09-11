import { createHash } from "node:crypto";
import { compactVerify, type CompactVerifyGetKey } from "jose";
import { PlatformAuthorityRevocationClaimsSchema, PLATFORM_AUTHORITY_REVOCATION_TYPE,
  type PlatformAuthorityRevocationClaims } from "@global/contracts/execution-budget";

const INVALID = "PLATFORM_REVOCATION_INVALID";
const UNAVAILABLE = "PLATFORM_REVOCATION_VERIFICATION_UNAVAILABLE";
// JSON.parse below rejects raw control characters inside the matched string.
const quoted = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

function invalid(): never { throw new Error(INVALID); }

/** Flat, scalar-only JWT contract: reject duplicate keys before ordinary JSON parsing. */
function flatObject(bytes: Uint8Array): Record<string, string | number> {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[offset] ?? "!") && offset < source.length) offset++; };
  const string = (): string => {
    quoted.lastIndex = offset;
    const match = quoted.exec(source);
    if (!match) return invalid();
    offset = quoted.lastIndex;
    const value: string = JSON.parse(match[0]);
    // Reject unpaired UTF-16 surrogate escapes even though JSON.parse allows them.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
      } else if (code >= 0xdc00 && code <= 0xdfff) return invalid();
    }
    return value;
  };
  whitespace(); if (source[offset++] !== "{") return invalid(); whitespace();
  const result: Record<string, string | number> = Object.create(null);
  while (source[offset] !== "}") {
    const key = string();
    if (Object.hasOwn(result, key)) return invalid();
    whitespace(); if (source[offset++] !== ":") return invalid(); whitespace();
    let value: string | number;
    if (source[offset] === '"') value = string();
    else {
      const match = /^(?:0|[1-9][0-9]*)/.exec(source.slice(offset));
      if (!match) return invalid();
      offset += match[0].length;
      value = Number(match[0]);
      if (!Number.isSafeInteger(value)) return invalid();
    }
    result[key] = value;
    whitespace();
    if (source[offset] === "}") break;
    if (source[offset++] !== ",") return invalid(); whitespace();
    if (source[offset] === "}") return invalid();
  }
  if (source[offset++] !== "}") return invalid(); whitespace();
  if (offset !== source.length) return invalid();
  return result;
}

export interface AuthenticatedPlatformRevocation {
  readonly claims: Readonly<PlatformAuthorityRevocationClaims>;
  readonly tokenSha256: string;
  /** Expired signatures authenticate ONLY exact persisted-command replay, never a new fence. */
  readonly expired: boolean;
}

/** No default key, trust fallback or environment-specific verification implementation. */
export class PlatformRevocationVerifier {
  constructor(private readonly dependencies: {
    readonly issuer: string;
    readonly keyResolver: CompactVerifyGetKey;
    readonly now: () => number;
  }) {}

  async inspect(compact: string): Promise<AuthenticatedPlatformRevocation> {
    try {
      if (typeof compact !== "string" || compact.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(compact)) return invalid();
      const segments = compact.split(".");
      for (const segment of segments) {
        if (Buffer.from(segment, "base64url").toString("base64url") !== segment) return invalid();
      }
      const header = flatObject(Buffer.from(segments[0], "base64url"));
      if (Object.keys(header).sort().join(",") !== "alg,kid,typ" || header.alg !== "RS256" ||
          header.typ !== PLATFORM_AUTHORITY_REVOCATION_TYPE || typeof header.kid !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(header.kid)) return invalid();
      let resolverFailed = false;
      const resolver: CompactVerifyGetKey = async (...args) => {
        try { return await this.dependencies.keyResolver(...args); }
        catch { resolverFailed = true; throw new Error(UNAVAILABLE); }
      };
      let payload: Uint8Array;
      try { ({ payload } = await compactVerify(compact, resolver, { algorithms: ["RS256"] })); }
      catch { if (resolverFailed) throw new Error(UNAVAILABLE); return invalid(); }
      const parsed = PlatformAuthorityRevocationClaimsSchema.safeParse(flatObject(payload));
      if (!parsed.success || parsed.data.iss !== this.dependencies.issuer) return invalid();
      const now = this.dependencies.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error(UNAVAILABLE);
      if (parsed.data.iat > now + 60 || parsed.data.nbf > now + 60) return invalid();
      return Object.freeze({ claims: Object.freeze(parsed.data),
        tokenSha256: createHash("sha256").update(compact).digest("hex"), expired: parsed.data.exp <= now });
    } catch (error) {
      // Verifier/parser causes can carry raw signed payloads or credential-provider diagnostics.
      // eslint-disable-next-line preserve-caught-error -- credential boundary deliberately returns bounded codes only
      throw new Error(error instanceof Error && error.message === UNAVAILABLE ? UNAVAILABLE : INVALID);
    }
  }
}
