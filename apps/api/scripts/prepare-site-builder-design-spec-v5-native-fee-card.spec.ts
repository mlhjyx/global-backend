import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertV5FixedSourceReachability,
  assertV5ManifestForPublicPriceRead,
  decodeBoundedCatalogResponse,
  validateV5EvidenceOutputPath,
} from "./prepare-site-builder-design-spec-v5-native-fee-card.mts";

describe("design_spec v5 native fee-card CLI guards", () => {
  it("allows only a new repository-relative Site Builder evidence JSON path", () => {
    expect(
      validateV5EvidenceOutputPath(
        "docs/evidence/site-builder/m1-g-design-spec-v5-native-fee-card-v1.json",
      ),
    ).toBe(
      "docs/evidence/site-builder/m1-g-design-spec-v5-native-fee-card-v1.json",
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
      expect(() => validateV5EvidenceOutputPath(value)).toThrow(
        "--output must be a new repository-relative evidence JSON path",
      );
    }
  });

  it("rejects invalid and historical manifests before a public-price read", () => {
    expect(() =>
      assertV5FixedSourceReachability({ fixedCommitSha: "f".repeat(40) }),
    ).toThrow("design_spec v5 fixed source commit must be reachable from HEAD");
    expect(() => assertV5FixedSourceReachability({})).toThrow(
      "design_spec v5 manifest fixed source commit is invalid",
    );
    const historical = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v4.json",
        ),
        "utf8",
      ),
    );
    expect(() => assertV5ManifestForPublicPriceRead(historical)).toThrow(
      "design_spec v5 manifest identity or envelope is invalid",
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
});
