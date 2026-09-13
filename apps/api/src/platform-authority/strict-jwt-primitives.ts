import { importJWK, type JWK } from "jose";

export interface VerifiedJwksDocument {
  readonly keys: readonly JWK[];
}

interface StrictJwtPrimitives {
  canonicalBase64urlBytes(value: string): Buffer;
  strictUtf8(bytes: Uint8Array): string;
  ClosedJwtObjectParser: new (source: string) => {
    parse(
      expectedKeys: readonly string[],
    ): Readonly<Record<string, string | number>>;
    parseJwks(): { keys: readonly Readonly<Record<string, string | number>>[] };
  };
  validJwksDocument(value: unknown): Promise<VerifiedJwksDocument>;
}

/** Extracted unchanged quote parsing/key validation; callers retain purpose and transport policy. */
export function createStrictJwtPrimitives(
  DeniedError: new () => Error,
  UnavailableError: new () => Error,
): StrictJwtPrimitives {
  const ALGORITHM = "RS256" as const;
  const MAX_JWKS_KEYS = 3;
  const BOUNDED_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const BASE64URL = /^[A-Za-z0-9_-]+$/u;
  const PRIVATE_JWK_MEMBERS = new Set([
    "d",
    "p",
    "q",
    "dp",
    "dq",
    "qi",
    "oth",
    "k",
  ]);
  function plainRecord(value: unknown): value is Record<string, unknown> {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }

  function sameKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
  ): boolean {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return (
      actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index])
    );
  }

  function canonicalBase64urlBytes(value: string): Buffer {
    if (!BASE64URL.test(value)) {
      throw new DeniedError();
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== value) {
      throw new DeniedError();
    }
    return bytes;
  }

  function strictUtf8(bytes: Uint8Array): string {
    try {
      const decoded = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (decoded.charCodeAt(0) === 0xfeff) {
        throw new Error("BOM is forbidden");
      }
      return decoded;
    } catch {
      throw new DeniedError();
    }
  }

  function containsUnpairedSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  type FlatJsonValue = string | number;

  /** Rejects duplicate decoded members before JOSE can overwrite them. */
  class ClosedJwtObjectParser {
    private index = 0;

    constructor(private readonly source: string) {}

    /** Closed JWKS envelope using the same decoded-string/flat-member parser.
     * Quote transport keeps its predecessor JSON path; target readers opt in. */
    parseJwks(): { keys: readonly Readonly<Record<string, FlatJsonValue>>[] } {
      const take = (character: string) => {
        this.skipWhitespace();
        if (this.source[this.index] !== character) return this.invalid();
        this.index += 1;
      };
      take("{");
      this.skipWhitespace();
      if (this.string() !== "keys") return this.invalid();
      take(":");
      take("[");
      this.skipWhitespace();
      const keys: Readonly<Record<string, FlatJsonValue>>[] = [];
      for (;;) {
        const start = this.index;
        take("{");
        // Flat parsing rejects nested values. The same string reader prevents
        // escaped quotes or braces inside strings from ending an entry.
        while (
          this.index < this.source.length &&
          this.source[this.index] !== "}"
        ) {
          if (this.source[this.index] === '"') this.string();
          else this.index += 1;
        }
        take("}");
        keys.push(
          new ClosedJwtObjectParser(this.source.slice(start, this.index)).parse(
            ["alg", "e", "kid", "kty", "n", "use"],
          ),
        );
        if (keys.length > 3) return this.invalid();
        this.skipWhitespace();
        if (this.source[this.index] === "]") break;
        take(",");
        this.skipWhitespace();
      }
      take("]");
      take("}");
      this.skipWhitespace();
      if (this.index !== this.source.length) return this.invalid();
      return { keys };
    }

    parse(
      expectedKeys: readonly string[],
    ): Readonly<Record<string, FlatJsonValue>> {
      try {
        this.skipWhitespace();
        if (this.source[this.index] !== "{") return this.invalid();
        this.index += 1;
        this.skipWhitespace();
        const result: Record<string, FlatJsonValue> = Object.create(
          null,
        ) as Record<string, FlatJsonValue>;
        const keys = new Set<string>();
        if (this.source[this.index] === "}") return this.invalid();
        for (;;) {
          const key = this.string();
          if (keys.has(key)) return this.invalid();
          keys.add(key);
          this.skipWhitespace();
          if (this.source[this.index] !== ":") return this.invalid();
          this.index += 1;
          this.skipWhitespace();
          const value =
            this.source[this.index] === '"' ? this.string() : this.integer();
          result[key] = value;
          this.skipWhitespace();
          const separator = this.source[this.index];
          if (separator === "}") {
            this.index += 1;
            break;
          }
          if (separator !== ",") return this.invalid();
          this.index += 1;
          this.skipWhitespace();
        }
        this.skipWhitespace();
        if (
          this.index !== this.source.length ||
          !sameKeys(result, expectedKeys)
        ) {
          return this.invalid();
        }
        return Object.freeze({ ...result });
      } catch (error) {
        if (error instanceof DeniedError) {
          throw error;
        }
        return this.invalid();
      }
    }

    private skipWhitespace(): void {
      while ([" ", "\t", "\n", "\r"].includes(this.source[this.index] ?? "")) {
        this.index += 1;
      }
    }

    private string(): string {
      if (this.source[this.index] !== '"') return this.invalid();
      const start = this.index;
      this.index += 1;
      while (this.index < this.source.length) {
        const code = this.source.charCodeAt(this.index);
        if (code === 0x22) {
          this.index += 1;
          let value: unknown;
          try {
            value = JSON.parse(this.source.slice(start, this.index));
          } catch {
            return this.invalid();
          }
          if (typeof value !== "string" || containsUnpairedSurrogate(value)) {
            return this.invalid();
          }
          return value;
        }
        if (code < 0x20) return this.invalid();
        if (code === 0x5c) {
          this.index += 1;
          const escape = this.source[this.index];
          if (escape === undefined) return this.invalid();
          if ('"\\/bfnrt'.includes(escape)) {
            this.index += 1;
            continue;
          }
          if (
            escape !== "u" ||
            !/^[0-9a-fA-F]{4}$/u.test(
              this.source.slice(this.index + 1, this.index + 5),
            )
          ) {
            return this.invalid();
          }
          this.index += 5;
          continue;
        }
        this.index += 1;
      }
      return this.invalid();
    }

    private integer(): number {
      const start = this.index;
      if (this.source[this.index] === "0") {
        this.index += 1;
      } else {
        if (!/[1-9]/u.test(this.source[this.index] ?? ""))
          return this.invalid();
        while (/[0-9]/u.test(this.source[this.index] ?? "")) this.index += 1;
      }
      const value = Number(this.source.slice(start, this.index));
      if (!Number.isSafeInteger(value) || value < 0) return this.invalid();
      return value;
    }

    private invalid(): never {
      throw new DeniedError();
    }
  }

  function jwkBitLength(modulus: string): number {
    const bytes = canonicalBase64urlBytes(modulus);
    const first = bytes[0]!;
    return (bytes.length - 1) * 8 + (32 - Math.clz32(first));
  }

  async function validJwksDocument(
    value: unknown,
  ): Promise<VerifiedJwksDocument> {
    if (
      !plainRecord(value) ||
      !sameKeys(value, ["keys"]) ||
      !Array.isArray(value.keys)
    ) {
      throw new UnavailableError();
    }
    if (value.keys.length < 1 || value.keys.length > MAX_JWKS_KEYS) {
      throw new UnavailableError();
    }
    const seen = new Set<string>();
    const keys: JWK[] = [];
    for (const candidate of value.keys) {
      if (
        !plainRecord(candidate) ||
        Object.keys(candidate).some((name) => PRIVATE_JWK_MEMBERS.has(name)) ||
        !sameKeys(candidate, ["alg", "e", "kid", "kty", "n", "use"]) ||
        candidate.alg !== ALGORITHM ||
        candidate.kty !== "RSA" ||
        candidate.use !== "sig" ||
        typeof candidate.kid !== "string" ||
        !BOUNDED_KEY_ID.test(candidate.kid) ||
        seen.has(candidate.kid) ||
        typeof candidate.n !== "string" ||
        typeof candidate.e !== "string" ||
        jwkBitLength(candidate.n) < 2_048
      ) {
        throw new UnavailableError();
      }
      seen.add(candidate.kid);
      canonicalBase64urlBytes(candidate.e);
      try {
        const imported = await importJWK(candidate as JWK, ALGORITHM);
        if (imported instanceof Uint8Array || imported.type !== "public") {
          throw new UnavailableError();
        }
      } catch {
        throw new UnavailableError();
      }
      keys.push(Object.freeze({ ...candidate }) as JWK);
    }
    return Object.freeze({ keys: Object.freeze(keys) });
  }

  return {
    canonicalBase64urlBytes,
    strictUtf8,
    ClosedJwtObjectParser,
    validJwksDocument,
  };
}
