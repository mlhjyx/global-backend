import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDesignSpecEvaluationSuitePrepManifest,
  writeDesignSpecEvaluationSuitePrepManifestCreateOnly,
} from "./design-spec-evaluation-suite-prep";

const FIXED_COMMIT = "a".repeat(40);

describe("design_spec zero-cost suite preparation", () => {
  it("freezes the paid and deterministic matrices without retired aliases", () => {
    const manifest = buildDesignSpecEvaluationSuitePrepManifest(FIXED_COMMIT);
    expect(manifest).toMatchObject({
      taskId: "site_builder.design_spec",
      fixedCommitSha: FIXED_COMMIT,
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      actualNetworkCalls: 0,
      actualModelCostCents: 0,
      executionCount: 73,
      maximumWireCallCount: 146,
      deterministicComparator: {
        comparatorId: "deterministic-catalog-selection/v1",
        modelAliases: [],
        caseCount: 24,
        wireCallCount: 0,
        costCents: 0,
      },
      planningHardUpperBound: {
        perWireCallCents: 20,
        maximumWireCalls: 146,
        amountCents: 2920,
        authorization: "NOT_GRANTED",
        expectedCost: "NOT_CALCULATED",
      },
      pricingGate: {
        amountBasis: "frozen_openox_public_price_snapshot_required",
        newApiPriceAllowed: false,
        status: "BLOCKED_UNTIL_SEPARATE_EVIDENCE_PR",
      },
    });
    expect(manifest.executions).toHaveLength(73);
    expect(
      manifest.executions.filter(({ kind }) => kind === "capability_probe"),
    ).toEqual([
      expect.objectContaining({
        alias: "gpt-5.5",
        protocol: "openai-responses",
      }),
    ]);
    expect(
      manifest.executions.filter(({ kind }) => kind === "target"),
    ).toHaveLength(72);
    expect(new Set(manifest.executions.map(({ alias }) => alias))).toEqual(
      new Set(["gpt-5.6-terra", "gpt-5.5", "claude-sonnet-5"]),
    );
    expect(
      manifest.executions.some(({ alias }) =>
        ["minimax-m3", "doubao-seed-2.0-pro"].includes(alias),
      ),
    ).toBe(false);
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes once and rejects overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-suite-prep-"));
    const manifest = buildDesignSpecEvaluationSuitePrepManifest(FIXED_COMMIT);
    await writeDesignSpecEvaluationSuitePrepManifestCreateOnly(
      root,
      "evidence/design-spec-suite.json",
      manifest,
    );
    expect(
      JSON.parse(
        await readFile(join(root, "evidence/design-spec-suite.json"), "utf8"),
      ),
    ).toEqual(manifest);
    await expect(
      writeDesignSpecEvaluationSuitePrepManifestCreateOnly(
        root,
        "evidence/design-spec-suite.json",
        manifest,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects output parents that are symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-suite-root-"));
    const outside = await mkdtemp(join(tmpdir(), "design-spec-suite-outside-"));
    await mkdir(join(outside, "sink"));
    await symlink(join(outside, "sink"), join(root, "evidence"));
    await expect(
      writeDesignSpecEvaluationSuitePrepManifestCreateOnly(
        root,
        "evidence/design-spec-suite.json",
        buildDesignSpecEvaluationSuitePrepManifest(FIXED_COMMIT),
      ),
    ).rejects.toThrow("parent must be a real directory");
  });

  it("rejects malformed fixed commits before building a manifest", () => {
    expect(() =>
      buildDesignSpecEvaluationSuitePrepManifest("origin/main"),
    ).toThrow("40-character commit");
  });
});
