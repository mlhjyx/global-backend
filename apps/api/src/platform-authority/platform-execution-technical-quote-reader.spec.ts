import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_SCHEMA_V1,
  canonicalizePlatformAuthorityRequestBodyV1,
} from "@global/contracts/platform-authority";

import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "./platform-execution-contract";
import { resolveCurrentPlatformExecutionProviderSnapshotV1 } from "./platform-execution-provider-snapshot";
import {
  PlatformExecutionTechnicalQuoteService,
  type PlatformExecutionTechnicalQuoteV1,
} from "./platform-execution-technical-quote";
import { PlatformExecutionTechnicalQuoteReaderService } from "./platform-execution-technical-quote-reader";

type QuoteVector = Readonly<{
  id: string;
  input: Readonly<{ now_epoch_seconds: string }>;
  expected_quote: PlatformExecutionTechnicalQuoteV1;
}>;

type RequestVector = Readonly<{
  id: string;
  raw_body_utf8: string;
  expected_sha256: string;
}>;

const VECTORS = (
  JSON.parse(
    await readFile(
      resolve(
        import.meta.dirname,
        "../../../../packages/contracts/fixtures/platform-authority/platform-execution-technical-quote-v1.json",
      ),
      "utf8",
    ),
  ) as Readonly<{ vectors: readonly QuoteVector[] }>
).vectors;

const REQUEST_VECTORS = (
  JSON.parse(
    await readFile(
      resolve(
        import.meta.dirname,
        "../../../../packages/contracts/fixtures/platform-authority/platform-execution-technical-quote-request-v1.json",
      ),
      "utf8",
    ),
  ) as Readonly<{ vectors: readonly RequestVector[] }>
).vectors;

function requestBody(quote: PlatformExecutionTechnicalQuoteV1): string {
  return REQUEST_VECTORS.find((vector) => vector.id === quote.schedule_id)!
    .raw_body_utf8;
}

function reader(nowEpochSeconds = VECTORS[0]!.input.now_epoch_seconds) {
  return new PlatformExecutionTechnicalQuoteReaderService({
    quoteService: new PlatformExecutionTechnicalQuoteService({
      policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
      technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
    }),
    now: () => new Date(Number(nowEpochSeconds) * 1_000),
    providerSnapshot: resolveCurrentPlatformExecutionProviderSnapshotV1,
  });
}

describe("PlatformExecutionTechnicalQuoteReaderService", () => {
  it.each(VECTORS)(
    "returns the exact pure quote for the closed $id binding",
    (vector) => {
      const rawBody = Buffer.from(requestBody(vector.expected_quote), "utf8");
      const parsed = canonicalizePlatformAuthorityRequestBodyV1({
        contentType: "application/json",
        rawBody,
        schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_SCHEMA_V1,
      });

      expect(parsed.values).toEqual(JSON.parse(rawBody.toString("utf8")));
      expect(parsed.canonicalBodyUtf8).toBe(rawBody.toString("utf8"));
      expect(
        createHash("sha256")
          .update(parsed.canonicalBodyUtf8, "utf8")
          .digest("hex"),
      ).toBe(
        REQUEST_VECTORS.find((candidate) => candidate.id === vector.id)!
          .expected_sha256,
      );
      expect(
        reader(vector.input.now_epoch_seconds).read({
          contentType: "application/json",
          rawBody,
        }),
      ).toEqual(vector.expected_quote);
    },
  );

  it("makes zero external calls and returns a bounded non-commercial response", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const quote = reader().read({
      contentType: "application/json",
      rawBody: Buffer.from(requestBody(VECTORS[0]!.expected_quote), "utf8"),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(Buffer.byteLength(JSON.stringify({ data: quote }), "utf8")).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(Object.keys(quote).join(" ")).not.toMatch(
      /customer|workspace|account|subscription|credit|balance/i,
    );
    fetch.mockRestore();
  });

  it.each([
    ["content type parameters", "application/json; charset=utf-8", undefined],
    ["duplicate fields", "application/json", (body: string) =>
      body.replace(
        '"purpose":"platform.acquisition"',
        '"purpose":"platform.sanctions","purpose":"platform.acquisition"',
      )],
    ["unknown amount", "application/json", (body: string) =>
      body.replace(/}$/, ',"cap_microusd":"1"}')],
    ["oversized body", "application/json", (body: string) =>
      body.replace(/}$/, `,"padding":"${"x".repeat(16_384)}"}`)],
  ])("rejects %s with one stable request error", (_label, contentType, mutate) => {
    const clean = requestBody(VECTORS[0]!.expected_quote);
    const rawBody = Buffer.from(mutate ? mutate(clean) : clean, "utf8");

    expect(() => reader().read({ contentType, rawBody })).toThrow(
      "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
    );
  });

  it("treats an unknown schedule as invalid input rather than dependency outage", () => {
    const rawBody = Buffer.from(
      requestBody(VECTORS[0]!.expected_quote).replace(
        '"schedule_id":"acq-sweep"',
        '"schedule_id":"unknown-schedule"',
      ),
      "utf8",
    );

    expect(() =>
      reader().read({ contentType: "application/json", rawBody }),
    ).toThrow("PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID");
  });

  it("has no persistence, Temporal, Provider transport or billing dependency", async () => {
    const [readerSource, snapshotSource] = await Promise.all([
      readFile(
        new URL("./platform-execution-technical-quote-reader.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("./platform-execution-provider-snapshot.ts", import.meta.url),
        "utf8",
      ),
    ]);
    const productSource = `${readerSource}\n${snapshotSource}`;
    expect(productSource).not.toMatch(
      /Prisma|Temporal|ToolBroker|ModelGateway|Storage|Billing|Credits|fetch\s*\(|https?:\/\//,
    );
    expect(productSource).not.toMatch(/process\.env|fallback|stub|sandbox/i);
  });
});
