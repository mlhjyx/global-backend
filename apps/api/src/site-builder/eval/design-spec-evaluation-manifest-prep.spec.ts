import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertDesignSpecFixedSourceCommitOnMain,
  assertDesignSpecSourceBundleAtFixedCommit,
  buildDesignSpecEvaluationPrepManifest,
  type DesignSpecEvaluationManifestPrepManifest,
  writeDesignSpecEvaluationPrepManifestCreateOnly,
} from "./design-spec-evaluation-manifest-prep";
import {
  COMPILED_CONTRACTS_ATTESTATION_SCHEMA_VERSION,
  COMPILED_CONTRACTS_BUILD_COMMAND,
  COMPILED_CONTRACTS_BUILD_ID,
  COMPILED_CONTRACTS_RUNTIME_ENTRYPOINT,
  type CompiledContractsAttestation,
} from "./compiled-contracts-attestation";
import { sha256CanonicalJson } from "./eval-provenance";
import { DESIGN_SPEC_COMPILED_CONTRACT_ARTIFACTS } from "./design-spec-compiled-contracts-runtime";
import { writeRepositoryJsonCreateOnly } from "./create-only-json";

const FIXED_COMMIT = "a".repeat(40);

function compiledContracts(): CompiledContractsAttestation {
  const trackedSourceFiles = [
    {
      path: "packages/contracts/src/index.ts",
      sha256: "1".repeat(64),
    },
  ];
  const compiledArtifacts = DESIGN_SPEC_COMPILED_CONTRACT_ARTIFACTS.map(
    (artifact) => ({ ...artifact }),
  );
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

describe("design_spec zero-cost manifest preparation", () => {
  it("preserves the self-authenticating manifest as current source evolves", async () => {
    const manifest = JSON.parse(
      await readFile(
        join(
          __dirname,
          "../../../../../docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json",
        ),
        "utf8",
      ),
    ) as DesignSpecEvaluationManifestPrepManifest;
    const { manifestSha256, ...withoutDigest } = manifest;

    expect(manifest.fixedCommitSha).toBe(
      "e493ba1d09fe37feea927f70d12f17aadadc5c6a",
    );
    expect(manifestSha256).toBe(sha256CanonicalJson(withoutDigest));
    expect(manifest.suite.sourceBundleSha256).toBe(
      sha256CanonicalJson(manifest.suite.sourceFiles),
    );
    expect(manifest.suite.sourceFiles).toHaveLength(47);
    expect(manifest.actualNetworkCalls).toBe(0);
    expect(manifest.actualModelCostCents).toBe(0);
    expect(manifest.dispatchAuthorization).toBe("NOT_AUTHORIZED");
  });

  it("freezes the paid and deterministic matrices without retired aliases", () => {
    const manifest = buildDesignSpecEvaluationPrepManifest(
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
      sourceManifestSplitGate: {
        fixedSourceCommitReachableFromPrepHead: true,
        fixedSourceCommitReachableFromOriginMain: true,
        prepHeadMayDifferFromFixedSourceCommit: true,
        postMergeReachabilityRequiredBeforeEvidence: true,
        squashMergeOutcome: "ALLOWED_IF_FIXED_SOURCE_REMAINS_REACHABLE",
      },
      compiledContracts: {
        fixedCommitSha: FIXED_COMMIT,
        runtimeEntrypoint: "packages/contracts/dist/index.js",
        staleOutputRemovedBeforeBuild: true,
        suiteImportedAfterBuild: true,
      },
      suite: {
        compiledContractsArtifactTreeSha256:
          "d65642cc5f9b20001b4a167ec4acbd5cb9a1dac1d5e335b02da0208ffdc9cc01",
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
    const manifest = buildDesignSpecEvaluationPrepManifest(
      FIXED_COMMIT,
      compiledContracts(),
    );
    await writeRepositoryJsonCreateOnly(
      root,
      "docs/evidence/site-builder/design-spec-suite.json",
      manifest,
    );
    expect(
      JSON.parse(
        await readFile(
          join(root, "docs/evidence/site-builder/design-spec-suite.json"),
          "utf8",
        ),
      ),
    ).toEqual(manifest);
    await expect(
      writeRepositoryJsonCreateOnly(
        root,
        "docs/evidence/site-builder/design-spec-suite.json",
        manifest,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects output parents that are symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-suite-root-"));
    const outside = await mkdtemp(join(tmpdir(), "design-spec-suite-outside-"));
    await mkdir(join(outside, "sink"));
    await mkdir(join(root, "docs"));
    await symlink(join(outside, "sink"), join(root, "docs/evidence"));
    await expect(
      writeRepositoryJsonCreateOnly(
        root,
        "docs/evidence/site-builder/design-spec-suite.json",
        buildDesignSpecEvaluationPrepManifest(
          FIXED_COMMIT,
          compiledContracts(),
        ),
      ),
    ).rejects.toThrow("parent must be a real directory");
  });

  it("rejects repository-control and non-evidence output paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-suite-root-"));
    const manifest = buildDesignSpecEvaluationPrepManifest(
      FIXED_COMMIT,
      compiledContracts(),
    );
    await expect(
      writeRepositoryJsonCreateOnly(
        root,
        ".git/refs/heads/evidence.json",
        manifest,
      ),
    ).rejects.toThrow("Site Builder evidence JSON path");
    await expect(
      writeRepositoryJsonCreateOnly(
        root,
        "evidence/design-spec-suite.json",
        manifest,
      ),
    ).rejects.toThrow("Site Builder evidence JSON path");
  });

  it("rejects a caller-constructed compiled attestation before evidence write", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-suite-root-"));
    const untrustedCompiledContracts = compiledContracts();
    const manifest = buildDesignSpecEvaluationPrepManifest(
      FIXED_COMMIT,
      untrustedCompiledContracts,
    );
    await expect(
      writeDesignSpecEvaluationPrepManifestCreateOnly(
        root,
        "docs/evidence/site-builder/design-spec-suite.json",
        manifest,
        untrustedCompiledContracts,
      ),
    ).rejects.toThrow("trusted zero-cost design_spec suite manifest required");
  });

  it("rejects malformed fixed commits before building a manifest", () => {
    expect(() =>
      buildDesignSpecEvaluationPrepManifest("origin/main", compiledContracts()),
    ).toThrow("40-character commit");
  });

  it("requires the fixed source commit to already be on origin/main", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-main-source-"));
    await writeFile(join(root, "source.ts"), "export const source = true;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Manifest Test"], {
      cwd: root,
    });
    execFileSync("git", ["add", "source.ts"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixed source"], {
      cwd: root,
    });
    const fixedCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    execFileSync(
      "git",
      ["update-ref", "refs/remotes/origin/main", fixedCommitSha],
      { cwd: root },
    );
    expect(() =>
      assertDesignSpecFixedSourceCommitOnMain(root, fixedCommitSha),
    ).not.toThrow();

    const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const unrelatedCommitSha = execFileSync(
      "git",
      ["commit-tree", treeSha, "-m", "unrelated main"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync(
      "git",
      ["update-ref", "refs/remotes/origin/main", unrelatedCommitSha],
      { cwd: root },
    );
    expect(() =>
      assertDesignSpecFixedSourceCommitOnMain(root, fixedCommitSha),
    ).toThrow("must already be reachable from origin/main");
  });

  it("rejects a source bundle assembled from a different worktree commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-spec-source-bundle-"));
    await mkdir(join(root, "apps/api/src"), { recursive: true });
    const sourcePath = "apps/api/src/evaluator.ts";
    const absoluteSourcePath = join(root, sourcePath);
    await writeFile(absoluteSourcePath, "export const version = 1;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Suite Test"], { cwd: root });
    execFileSync("git", ["add", sourcePath], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "source v1"], {
      cwd: root,
    });
    const fixedCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const fixedBytes = await readFile(absoluteSourcePath);
    const fixedFingerprint = {
      path: sourcePath,
      sha256: createHash("sha256").update(fixedBytes).digest("hex"),
    };
    expect(() =>
      assertDesignSpecSourceBundleAtFixedCommit(root, fixedCommitSha, [
        fixedFingerprint,
      ]),
    ).not.toThrow();

    const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const unrelatedCommitSha = execFileSync(
      "git",
      ["commit-tree", treeSha, "-m", "unrelated source history"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    execFileSync("git", ["update-ref", "HEAD", unrelatedCommitSha], {
      cwd: root,
    });
    expect(() =>
      assertDesignSpecSourceBundleAtFixedCommit(root, fixedCommitSha, [
        fixedFingerprint,
      ]),
    ).toThrow(
      "design_spec fixed commit must be reachable from the current history",
    );
    execFileSync("git", ["update-ref", "HEAD", fixedCommitSha], { cwd: root });

    await writeFile(absoluteSourcePath, "export const version = 2;\n");
    const currentBytes = await readFile(absoluteSourcePath);
    expect(() =>
      assertDesignSpecSourceBundleAtFixedCommit(root, fixedCommitSha, [
        {
          path: sourcePath,
          sha256: createHash("sha256").update(currentBytes).digest("hex"),
        },
      ]),
    ).toThrow(`${sourcePath} drifted from the fixed commit`);
  });

  it("rejects stale or mismatched compiled contracts attestations", () => {
    const staleArtifact = compiledContracts();
    staleArtifact.compiledArtifacts[0]!.sha256 = "3".repeat(64);
    expect(() =>
      buildDesignSpecEvaluationPrepManifest(FIXED_COMMIT, staleArtifact),
    ).toThrow("trusted fixed-commit compiled contracts required");

    const wrongCommit = compiledContracts();
    wrongCommit.fixedCommitSha = "b".repeat(40);
    expect(() =>
      buildDesignSpecEvaluationPrepManifest(FIXED_COMMIT, wrongCommit),
    ).toThrow("trusted fixed-commit compiled contracts required");
  });
});
