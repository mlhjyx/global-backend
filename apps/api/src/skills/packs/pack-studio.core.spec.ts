import { describe, expect, it } from "vitest";
import { diffBriefs, publishBlockers, validateDraft, type PublishReceipt } from "./pack-studio.core";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packKey: "growth_motion.demo",
    packType: "growth_motion",
    version: "1.0.0",
    title: "演示动作包",
    description: "演示",
    priorityClass: "growth_motion",
    owner: "OWN",
    license: "Proprietary",
    rules: [],
    sources: [{ label: "internal" }],
    exitPlan: "review",
    ...overrides,
  };
}

const DIGEST = "a".repeat(64);
const EVAL_DIGEST = "b".repeat(64);

function receipt(overrides: Partial<PublishReceipt> = {}): PublishReceipt {
  return {
    subjectDigest: DIGEST,
    evalManifestDigest: EVAL_DIGEST,
    tier: "deterministic",
    passed: true,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

describe("validateDraft", () => {
  it("returns the manifest digest and no errors for a valid draft", () => {
    const report = validateDraft("growth_motion.demo", manifest());
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(report.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a manifest whose key does not match the package", () => {
    const report = validateDraft("growth_motion.demo", manifest({ packKey: "growth_motion.other" }));
    expect(report.issues.map((issue) => issue.code)).toContain("PACK_KEY_DIRECTORY_MISMATCH");
  });

  it("rejects an unknown pack type prefix", () => {
    expect(() => validateDraft("mystery.demo", manifest())).toThrow(/PACK_KEY_INVALID/u);
  });
});

describe("publishBlockers", () => {
  const now = new Date("2026-11-08T00:00:00Z");

  it("requires an eval manifest and a matching passing receipt", () => {
    expect(
      publishBlockers({ manifestDigest: DIGEST, evalManifestDigest: null, receipts: [], now }),
    ).toEqual(["EVAL_MANIFEST_REQUIRED"]);
    expect(
      publishBlockers({ manifestDigest: DIGEST, evalManifestDigest: EVAL_DIGEST, receipts: [], now }),
    ).toEqual(["EVAL_RECEIPT_MISSING"]);
    expect(
      publishBlockers({
        manifestDigest: DIGEST,
        evalManifestDigest: EVAL_DIGEST,
        receipts: [receipt({ passed: false })],
        now,
      }),
    ).toEqual(["EVAL_RECEIPT_FAILED"]);
  });

  it("accepts a fresh passing receipt bound to both digests", () => {
    expect(
      publishBlockers({
        manifestDigest: DIGEST,
        evalManifestDigest: EVAL_DIGEST,
        receipts: [receipt()],
        now,
      }),
    ).toEqual([]);
  });

  it("rejects stale, mismatched or differently-tiered receipts", () => {
    expect(
      publishBlockers({
        manifestDigest: DIGEST,
        evalManifestDigest: EVAL_DIGEST,
        receipts: [receipt({ createdAt: new Date("2026-09-01T00:00:00Z") })],
        now,
      }),
    ).toEqual(["EVAL_RECEIPT_STALE"]);
    expect(
      publishBlockers({
        manifestDigest: DIGEST,
        evalManifestDigest: EVAL_DIGEST,
        receipts: [receipt({ subjectDigest: "c".repeat(64) })],
        now,
      }),
    ).toEqual(["EVAL_RECEIPT_MISSING"]);
    expect(
      publishBlockers({
        manifestDigest: DIGEST,
        evalManifestDigest: EVAL_DIGEST,
        receipts: [receipt({ evalManifestDigest: "d".repeat(64) })],
        now,
      }),
    ).toEqual(["EVAL_RECEIPT_MISSING"]);
  });
});

describe("diffBriefs", () => {
  it("reports added and removed lines deterministically", () => {
    expect(diffBriefs("a\nb\nc", "a\nc\nd")).toEqual({ added: ["d"], removed: ["b"] });
    expect(diffBriefs("", "x")).toEqual({ added: ["x"], removed: [""] });
  });
});
