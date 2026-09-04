import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1,
  buildPlatformAuthorityRequestHmacPreimageV1,
  canonicalizePlatformAuthorityRequestBodyV1,
} from "../../../../packages/contracts/src/platform-authority/canonical-request";

type RepeatBody = Readonly<{
  prefix: string;
  ascii_character: string;
  count: number;
  suffix: string;
}>;
type BodyVector = Readonly<{
  id: string;
  content_type: string;
  raw_body_utf8?: string;
  raw_body_base64?: string;
  raw_body_repeat?: RepeatBody;
  expected_canonical_utf8?: string;
  expected_sha256?: string;
}>;
type HmacInput = Readonly<{
  method: string;
  normalized_path: string;
  growthos_audience: string;
  environment_id: string;
  numeric_date: string;
  key_id: string;
  nonce: string;
  canonical_body_sha256: string;
}>;
type Corpus = Readonly<{
  schema_version: string;
  contract_version: string;
  reference_schema_id: string;
  scope_notice: string;
  positive_bodies: readonly BodyVector[];
  adversarial_bodies: readonly BodyVector[];
  positive_hmac_preimages: readonly Readonly<{
    id: string;
    input: HmacInput;
    expected_utf8: string;
    expected_sha256: string;
  }>[];
  adversarial_hmac_preimages: readonly Readonly<{
    id: string;
    field: keyof HmacInput;
    value: string;
  }>[];
}>;

const CORPUS = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../packages/contracts/fixtures/platform-authority/platform-authority-canonical-request-v1.json",
    ),
    "utf8",
  ),
) as Corpus;
const HMAC_BASE = CORPUS.positive_hmac_preimages[0]!.input;

function rawBody(vector: BodyVector): Buffer {
  if (vector.raw_body_utf8 !== undefined)
    return Buffer.from(vector.raw_body_utf8, "utf8");
  if (vector.raw_body_base64 !== undefined)
    return Buffer.from(vector.raw_body_base64, "base64");
  if (vector.raw_body_repeat !== undefined) {
    const {
      prefix,
      ascii_character: character,
      count,
      suffix,
    } = vector.raw_body_repeat;
    expect(Buffer.byteLength(character, "ascii")).toBe(1);
    return Buffer.from(`${prefix}${character.repeat(count)}${suffix}`, "utf8");
  }
  throw new Error(`invalid conformance vector: ${vector.id}`);
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("platform-authority-canonical-request/v1 shared corpus", () => {
  it("identifies the reference schema as codec-only rather than an issuance contract", () => {
    expect(CORPUS).toMatchObject({
      schema_version: "platform-authority-canonical-request-conformance/v1",
      contract_version: "platform-authority-canonical-request/v1",
      reference_schema_id: "platform-authority-canonical-reference/v1",
    });
    expect(CORPUS.scope_notice).toContain("not an issuance or quote body");
    expectDeepFrozen(PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1);
  });

  it.each(CORPUS.positive_bodies)(
    "accepts literal body vector $id",
    (vector) => {
      const raw = rawBody(vector);
      const result = canonicalizePlatformAuthorityRequestBodyV1({
        contentType: vector.content_type,
        rawBody: raw,
        schema: PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1,
      });

      if (vector.expected_canonical_utf8 !== undefined) {
        expect(result.canonicalBodyUtf8).toBe(vector.expected_canonical_utf8);
      } else {
        expect(Buffer.byteLength(result.canonicalBodyUtf8, "utf8")).toBe(16384);
      }
      expect(result.canonicalBodyByteLength).toBe(
        Buffer.byteLength(result.canonicalBodyUtf8, "utf8"),
      );
      expect(
        createHash("sha256").update(result.canonicalBodyUtf8).digest("hex"),
      ).toBe(vector.expected_sha256);
      expect(result.schemaId).toBe(CORPUS.reference_schema_id);
      expectDeepFrozen(result);
    },
  );

  it.each(CORPUS.adversarial_bodies)(
    "rejects literal body vector $id",
    (vector) => {
      expect(() =>
        canonicalizePlatformAuthorityRequestBodyV1({
          contentType: vector.content_type,
          rawBody: rawBody(vector),
          schema: PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1,
        }),
      ).toThrow("PLATFORM_AUTHORITY_CANONICAL_REQUEST_INVALID");
    },
  );

  it("rejects absent, cloned and request-shaped schemas", () => {
    const raw = rawBody(CORPUS.positive_bodies[0]!);
    for (const schema of [
      undefined,
      structuredClone(PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1),
      { schemaId: "platform-authority-canonical-reference/v1" },
      { schemaId: "unknown-schema/v1", fields: [] },
    ]) {
      expect(() =>
        canonicalizePlatformAuthorityRequestBodyV1({
          contentType: "application/json",
          rawBody: raw,
          schema: schema as never,
        }),
      ).toThrow("PLATFORM_AUTHORITY_CANONICAL_SCHEMA_INVALID");
    }
  });

  it("fails closed with a stable schema error for a non-object codec input", () => {
    expect(() =>
      canonicalizePlatformAuthorityRequestBodyV1(null as never),
    ).toThrow("PLATFORM_AUTHORITY_CANONICAL_SCHEMA_INVALID");
  });

  it.each(CORPUS.positive_hmac_preimages)(
    "builds literal HMAC vector $id without a terminal newline",
    (vector) => {
      const preimage = buildPlatformAuthorityRequestHmacPreimageV1(
        vector.input,
      );

      expect(preimage).toBe(vector.expected_utf8);
      expect(preimage.endsWith("\n")).toBe(false);
      expect(Buffer.byteLength(preimage, "utf8")).toBe(
        Buffer.byteLength(vector.expected_utf8, "utf8"),
      );
      expect(createHash("sha256").update(preimage).digest("hex")).toBe(
        vector.expected_sha256,
      );
    },
  );

  it.each(CORPUS.adversarial_hmac_preimages)(
    "rejects HMAC vector $id",
    (vector) => {
      expect(() =>
        buildPlatformAuthorityRequestHmacPreimageV1({
          ...HMAC_BASE,
          [vector.field]: vector.value,
        }),
      ).toThrow("PLATFORM_AUTHORITY_HMAC_PREIMAGE_INVALID");
    },
  );

  it("rejects non-string and non-plain HMAC input before string coercion", () => {
    expect(() =>
      buildPlatformAuthorityRequestHmacPreimageV1({
        ...HMAC_BASE,
        numeric_date: 1786800000,
      } as never),
    ).toThrow("PLATFORM_AUTHORITY_HMAC_PREIMAGE_INVALID");

    const inherited = Object.assign(
      Object.create({ inherited: "must-not-be-accepted" }) as object,
      HMAC_BASE,
    );
    expect(() =>
      buildPlatformAuthorityRequestHmacPreimageV1(inherited as never),
    ).toThrow("PLATFORM_AUTHORITY_HMAC_PREIMAGE_INVALID");
  });
});
