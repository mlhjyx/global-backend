import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildRemainingTextEvaluationPrepManifest } from "./remaining-text-evaluation-manifest-prep";
import { sha256CanonicalJson } from "./eval-provenance";

const FIXED_COMMIT = "a".repeat(40);

const COMMITTED_MANIFEST_PATH = join(
  __dirname,
  "../../../../../docs/evidence/site-builder/m1-g-remaining-text-evaluation-manifest-v1.json",
);

describe("remaining Site Builder text-task zero-cost manifest preparation", () => {
  it("freezes the five task-specific matrices without retired, legacy, or media aliases", () => {
    const manifest = buildRemainingTextEvaluationPrepManifest(FIXED_COMMIT);

    expect(manifest).toMatchObject({
      taskIds: [
        "site_builder.copy",
        "site_builder.assemble",
        "site_builder.assembly_fix",
        "site_builder.qa_summarize",
        "site_builder.seo_review",
      ],
      fixedCommitSha: FIXED_COMMIT,
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      actualNetworkCalls: 0,
      actualModelCostCents: 0,
      executionCount: 183,
      maximumWireCallCount: 366,
      planningHardUpperBound: {
        perWireCallCents: 20,
        maximumWireCalls: 366,
        amountCents: 7320,
        authorization: "NOT_GRANTED",
      },
    });
    expect(
      manifest.tasks.map(({ taskId, executionCount, maximumWireCallCount }) => [
        taskId,
        executionCount,
        maximumWireCallCount,
      ]),
    ).toEqual([
      ["site_builder.copy", 13, 26],
      ["site_builder.assemble", 73, 146],
      ["site_builder.assembly_fix", 73, 146],
      ["site_builder.qa_summarize", 12, 24],
      ["site_builder.seo_review", 12, 24],
    ]);
    expect(
      manifest.tasks.every(
        ({ legacyComparatorAliases, deterministicComparator }) =>
          legacyComparatorAliases.length === 0 &&
          deterministicComparator.applicable === false &&
          deterministicComparator.caseCount === 0,
      ),
    ).toBe(true);
    expect(
      manifest.tasks.flatMap(({ candidates }) =>
        candidates.map(({ alias }) => alias),
      ),
    ).not.toEqual(
      expect.arrayContaining([
        "minimax-m3",
        "doubao-seed-2.0-pro",
        "doubao-seed-2.0-lite",
      ]),
    );
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records the current mainline source as a zero-call audit artifact", () => {
    const manifest = JSON.parse(readFileSync(COMMITTED_MANIFEST_PATH, "utf8"));
    const { manifestSha256, ...withoutDigest } = manifest;

    expect(manifest).toMatchObject({
      fixedCommitSha: "0891b374321961b8aad13c8b215985ca623a4c0c",
      dispatchAuthorization: "NOT_AUTHORIZED",
      actualNetworkCalls: 0,
      actualModelCostCents: 0,
      executionCount: 183,
      maximumWireCallCount: 366,
    });
    expect(manifestSha256).toBeTypeOf("string");
    expect(manifestSha256).toHaveLength(64);
    expect(manifestSha256).toBe(sha256CanonicalJson(withoutDigest));
  });
});
