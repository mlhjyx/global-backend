import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
  canonicalizePlatformAuthorityRequestBodyV1,
} from "../../../../packages/contracts/src/platform-authority/canonical-request";

type SchemaVector = Readonly<{
  schema_version: string;
  quote_schema_id: string;
  hash_preimage_schema_id: string;
  scope_notice: string;
  positive_body: Readonly<{
    content_type: string;
    raw_body_utf8: string;
    expected_canonical_utf8: string;
    expected_quote_sha256: string;
  }>;
}>;

const VECTOR = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../packages/contracts/fixtures/platform-authority/platform-execution-technical-quote-schema-v1.json",
    ),
    "utf8",
  ),
) as SchemaVector;

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("platform-execution-technical-quote/v1 body contract", () => {
  it("uses product-specific code-owned schemas rather than the codec reference schema", () => {
    expect(PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1.schemaId).toBe(
      VECTOR.quote_schema_id,
    );
    expect(
      PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1.schemaId,
    ).toBe(VECTOR.hash_preimage_schema_id);
    expect(VECTOR.scope_notice).toContain("product quote body contract");
    expectDeepFrozen(PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1);
    expectDeepFrozen(
      PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
    );
  });

  it("canonicalizes the literal product quote body and independently verifies its quote hash", () => {
    const quote = canonicalizePlatformAuthorityRequestBodyV1({
      contentType: VECTOR.positive_body.content_type,
      rawBody: Buffer.from(VECTOR.positive_body.raw_body_utf8, "utf8"),
      schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
    });
    expect(quote.canonicalBodyUtf8).toBe(
      VECTOR.positive_body.expected_canonical_utf8,
    );

    const values = JSON.parse(VECTOR.positive_body.raw_body_utf8) as Record<
      string,
      string
    >;
    const { quote_sha256: declaredQuoteSha256, ...preimage } = values;
    const preimageBody = canonicalizePlatformAuthorityRequestBodyV1({
      contentType: "application/json",
      rawBody: Buffer.from(JSON.stringify(preimage), "utf8"),
      schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1,
    });
    const observedQuoteSha256 = createHash("sha256")
      .update(preimageBody.canonicalBodyUtf8, "utf8")
      .digest("hex");
    expect(observedQuoteSha256).toBe(
      VECTOR.positive_body.expected_quote_sha256,
    );
    expect(declaredQuoteSha256).toBe(observedQuoteSha256);
  });

  it("rejects a cloned schema and any omitted policy, provider, price or hard-bound field", () => {
    const values = JSON.parse(VECTOR.positive_body.raw_body_utf8) as Record<
      string,
      string
    >;
    expect(() =>
      canonicalizePlatformAuthorityRequestBodyV1({
        contentType: "application/json",
        rawBody: Buffer.from(VECTOR.positive_body.raw_body_utf8, "utf8"),
        schema: structuredClone(
          PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
        ),
      }),
    ).toThrow("PLATFORM_AUTHORITY_CANONICAL_SCHEMA_INVALID");

    for (const field of [
      "policy_revision",
      "provider_snapshot_sha256",
      "price_catalog_revision",
      "maximum_physical_invocations",
      "maximum_repair_wires",
      "maximum_fallback_wires",
      "maximum_input_tokens",
      "maximum_output_tokens",
      "maximum_output_bytes_per_wire",
    ]) {
      const changed = { ...values };
      delete changed[field];
      expect(() =>
        canonicalizePlatformAuthorityRequestBodyV1({
          contentType: "application/json",
          rawBody: Buffer.from(JSON.stringify(changed), "utf8"),
          schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1,
        }),
      ).toThrow("PLATFORM_AUTHORITY_CANONICAL_REQUEST_INVALID");
    }
  });
});
