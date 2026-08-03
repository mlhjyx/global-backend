import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertV2FixedSourceReachability,
  assertV2ManifestForPublicPriceRead,
  decodeBoundedCatalogResponse,
  validateV2EvidenceOutputPath,
} from "./prepare-site-builder-design-spec-v2-native-fee-card.mts";

describe("design_spec v2 native fee-card CLI guards", () => {
  it("allows only a new repository-relative Site Builder evidence JSON path", () => {
    expect(
      validateV2EvidenceOutputPath(
        "docs/evidence/site-builder/m1-g-design-spec-v2-native-fee-card-v1.json",
      ),
    ).toBe(
      "docs/evidence/site-builder/m1-g-design-spec-v2-native-fee-card-v1.json",
    );
    for (const value of [
      null,
      "/tmp/fee-card.json",
      "docs/evidence/site-builder/../fee-card.json",
      "docs/evidence/site-builder//fee-card.json",
      "docs/evidence/site-builder\\fee-card.json",
      "docs/evidence/other/fee-card.json",
      "docs/evidence/site-builder/fee-card.txt",
    ]) {
      expect(() => validateV2EvidenceOutputPath(value)).toThrow(
        "--output must be a new repository-relative evidence JSON path",
      );
    }
  });

  it("rejects an invalid or historical source before a public-price read", () => {
    expect(() =>
      assertV2FixedSourceReachability({ fixedCommitSha: "f".repeat(40) }),
    ).toThrow("design_spec v2 fixed source commit must be reachable from HEAD");
    expect(() => assertV2FixedSourceReachability({})).toThrow(
      "design_spec v2 manifest fixed source commit is invalid",
    );
    const historical = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json",
        ),
        "utf8",
      ),
    );
    expect(() => assertV2ManifestForPublicPriceRead(historical)).toThrow(
      "design_spec v2 manifest identity or envelope is invalid",
    );
  });

  it("decodes and hashes a bounded public catalog response without fetching", async () => {
    const payload = JSON.stringify({ success: true, data: { models: [] } });
    const card = await decodeBoundedCatalogResponse(
      new Response(payload, {
        headers: { "content-length": String(Buffer.byteLength(payload)) },
      }),
    );

    expect(card.catalog).toEqual({ success: true, data: { models: [] } });
    expect(card.responseSha256).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
  });

  it("rejects unavailable, oversized, bodyless, and malformed public responses", async () => {
    await expect(
      decodeBoundedCatalogResponse(
        new Response("unavailable", { status: 503 }),
      ),
    ).rejects.toThrow("OpenOx pricing catalog request failed: HTTP 503");
    await expect(
      decodeBoundedCatalogResponse(
        new Response("{}", {
          headers: { "content-length": String(1_048_577) },
        }),
      ),
    ).rejects.toThrow("OpenOx pricing catalog exceeds the byte limit");
    await expect(
      decodeBoundedCatalogResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(1_048_577));
              controller.close();
            },
          }),
        ),
      ),
    ).rejects.toThrow("OpenOx pricing catalog exceeds the byte limit");
    await expect(
      decodeBoundedCatalogResponse(new Response(null)),
    ).rejects.toThrow("OpenOx pricing catalog body is unavailable");
    await expect(
      decodeBoundedCatalogResponse(new Response("{not-json")),
    ).rejects.toThrow();
  });
});
