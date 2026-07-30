import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDesignSpecEvaluationSuitePrepManifest,
  writeDesignSpecEvaluationSuitePrepManifestCreateOnly,
} from "./design-spec-evaluation-suite-prep";
import {
  COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION,
  COMPILED_CONTRACTS_BUILD_COMMAND,
  COMPILED_CONTRACTS_BUILD_ID,
  COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
  type CompiledContractsAttestation,
} from "./compiled-contracts-attestation";
import { sha256CanonicalJson } from "./eval-provenance";

const FIXED_COMMIT = "a".repeat(40);

function compiledContracts(): CompiledContractsAttestation {
  const trackedSourceFiles = [
    {
      path: "packages/contracts/src/index.ts",
      sha256: "1".repeat(64),
    },
  ];
  const compiledArtifacts = [
    {
      path: COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
      sha256: "2".repeat(64),
    },
  ];
  return {
    schemaVersion: COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION,
    buildId: COMPILED_CONTRACTS_BUILD_ID,
    buildCommand: COMPILED_CONTRACTS_BUILD_COMMAND,
    fixedCommitSha: FIXED_COMMIT,
    trackedSourceFiles,
    trackedSourceTreeSha256: sha256CanonicalJson(trackedSourceFiles),
    runtimeEntrypoint: COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
    compiledArtifacts,
    compiledArtifactTreeSha256: sha256CanonicalJson(compiledArtifacts),
    staleOutputRemovedBeforeBuild: true,
    suiteImportedAfterBuild: true,
  };
}

describe("design_spec zero-cost suite preparation", () => {
  it("freezes the paid and deterministic matrices without retired aliases", () => {
    const manifest = buildDesignSpecEvaluationSuitePrepManifest(
      FIXED_COMMIT,
      compiledContracts(),
    );
    expect(manifest).toMatchObject({
      taskId: "site_builder.design_spec",
      fixedCommitSha: FIXED_COMMIT,
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      actualNetworkCalls: 0,
      actualModelCostCents: 0,
      compiledContracts: {
        fixedCommitSha: FIXED_COMMIT,
        runtimeEntrypoint: "packages/contracts/dist/index.js",
        staleOutputRemovedBeforeBuild: true,
        suiteImportedAfterBuild: true,
      },
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
    expect(manifest.deterministicComparator.cases).toHaveLength(24);
    expect(
      manifest.deterministicComparator.cases.every(
        (entry) =>
          entry.assessment === "PASS" &&
          entry.actualCandidateId === entry.expectedCandidateId &&
          /^[a-f0-9]{64}$/.test(entry.fixtureSha256) &&
          /^[a-f0-9]{64}$/.test(entry.promptSha256) &&
          /^[a-f0-9]{64}$/.test(entry.resultSha256),
      ),
    ).toBe(true);
    expect(
      new Set(
        manifest.deterministicComparator.cases.map(
          ({ fixtureId, expectedCandidateId }) =>
            `${fixtureId}:${expectedCandidateId}`,
        ),
      ).size,
    ).toBe(12);
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes once and rejects overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-suite-prep-"));
    const manifest = buildDesignSpecEvaluationSuitePrepManifest(
      FIXED_COMMIT,
      compiledContracts(),
    );
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
        buildDesignSpecEvaluationSuitePrepManifest(
          FIXED_COMMIT,
          compiledContracts(),
        ),
      ),
    ).rejects.toThrow("parent must be a real directory");
  });

  it("rejects malformed fixed commits before building a manifest", () => {
    expect(() =>
      buildDesignSpecEvaluationSuitePrepManifest(
        "origin/main",
        compiledContracts(),
      ),
    ).toThrow("40-character commit");
  });

  it("rejects stale or mismatched compiled contracts attestations", () => {
    const staleArtifact = compiledContracts();
    staleArtifact.compiledArtifacts[0]!.sha256 = "3".repeat(64);
    expect(() =>
      buildDesignSpecEvaluationSuitePrepManifest(FIXED_COMMIT, staleArtifact),
    ).toThrow("trusted fixed-commit compiled contracts required");

    const wrongCommit = compiledContracts();
    wrongCommit.fixedCommitSha = "b".repeat(40);
    expect(() =>
      buildDesignSpecEvaluationSuitePrepManifest(FIXED_COMMIT, wrongCommit),
    ).toThrow("trusted fixed-commit compiled contracts required");
  });
});
