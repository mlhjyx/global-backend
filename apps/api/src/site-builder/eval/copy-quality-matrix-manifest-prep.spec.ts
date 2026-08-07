import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../../model-runtime";
import { COPY_QUALITY_MATRIX_ADMISSION_SOURCE } from "./copy-quality-matrix-admission";
import { COPY_QUALITY_MATRIX_PLAN } from "./copy-quality-matrix-runner";
import {
  COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH,
  COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES,
  buildCopyQualityMatrixManifestArtifact,
  buildCopyQualityMatrixSourceFileSpecs,
  prepareCopyQualityMatrixManifestFromRepository,
  validateCopyQualityMatrixManifestArtifact,
  writeCopyQualityMatrixManifestCreateOnly,
  type CopyQualityMatrixSourceFile,
} from "./copy-quality-matrix-manifest-prep";

const FIXED_SOURCE_COMMIT = "a".repeat(40);
const PREPARATION_HEAD_COMMIT = "b".repeat(40);
const temporaryRoots: string[] = [];

function sourceFiles(): CopyQualityMatrixSourceFile[] {
  return COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES.map((entry, index) => ({
    ...entry,
    sha256: index.toString(16).padStart(64, "0"),
  }));
}

function mutateRoleDigest(
  files: readonly CopyQualityMatrixSourceFile[],
  role: string,
): CopyQualityMatrixSourceFile[] {
  let changed = false;
  const result = files.map((file) => {
    if (!changed && file.role === role) {
      changed = true;
      return { ...file, sha256: "f".repeat(64) };
    }
    return { ...file };
  });
  expect(changed).toBe(true);
  return result;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

async function createRepositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "copy-quality-matrix-manifest-"));
  temporaryRoots.push(root);
  git(root, ["init"]);
  git(root, ["config", "user.name", "Copy Matrix Test"]);
  git(root, ["config", "user.email", "copy-matrix@example.invalid"]);
  for (const spec of COPY_QUALITY_MATRIX_MANIFEST_SOURCE_FILES) {
    const path = join(root, spec.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${spec.role}:${spec.path}\n`, "utf8");
  }
  mkdirSync(join(root, "docs/evidence/site-builder"), { recursive: true });
  writeFileSync(join(root, "docs/evidence/site-builder/.gitkeep"), "", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "test fixture"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Copy quality matrix create-only manifest preparation", () => {
  it("freezes the complete 36/72 matrix without authorizing dispatch", () => {
    const artifact = buildCopyQualityMatrixManifestArtifact({
      fixedSourceCommit: FIXED_SOURCE_COMMIT,
      preparationHeadCommit: PREPARATION_HEAD_COMMIT,
      sourceFiles: sourceFiles(),
    });

    expect(COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH).toBe(
      "docs/evidence/site-builder/m1-g-copy-quality-matrix-manifest-v3.json",
    );
    expect(artifact).toMatchObject({
      schemaVersion:
        "site-builder-copy-quality-matrix-manifest-prep/2026-08-07-v3",
      artifactId:
        "site-builder-copy-quality-matrix-manifest-prep/2026-08-07-v3",
      classification: "FIXED_SOURCE_CREATE_ONLY",
      fixedSourceCommit: FIXED_SOURCE_COMMIT,
      preparationHeadCommit: PREPARATION_HEAD_COMMIT,
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      manifest: {
        schemaVersion:
          "site-builder-copy-quality-matrix-manifest/2026-08-07-v3",
        manifestId: "site-builder-copy-quality-matrix/2026-08-07-v3",
        purpose: "site_builder_copy_quality_matrix",
        fixedSourceCommit: FIXED_SOURCE_COMMIT,
        dispatchAuthorization: "NOT_AUTHORIZED",
        taskId: "site_builder.copy",
        plannedExecutions: 36,
        maximumWireCalls: 72,
        maximumRepairCallsPerExecution: 1,
        ledgerTopology: "shared_campaign_ledger",
        acceptedEvidenceClass: "git_reviewed_gateway_settlement_accepted",
        evidenceKind: "quality_matrix",
        outputReplayPolicy: "git_reviewed_canonical_output_bytes_consume_once",
      },
      preparationVerification: {
        fixedCommitEqualsPreparationHead: false,
        preparationHeadEqualsOriginMain: true,
        trackedSourceBytesMatch: true,
        futureExecutionMustReverify: true,
      },
    });
    expect(artifact.manifest.executions).toEqual(
      COPY_QUALITY_MATRIX_PLAN.executions,
    );
    expect(
      new Set(
        artifact.manifest.executions
          .filter(({ alias }) => alias === "gpt-5.6-terra")
          .map(({ protocol }) => protocol),
      ),
    ).toEqual(new Set(["openai_chat_completions"]));
    expect(
      new Set(
        artifact.manifest.executions
          .filter(({ alias }) => alias === "gpt-5.6-sol")
          .map(({ protocol }) => protocol),
      ),
    ).toEqual(new Set(["openai_chat_completions"]));
    expect(
      new Set(
        artifact.manifest.executions
          .filter(({ alias }) => alias === "claude-sonnet-5")
          .map(({ protocol }) => protocol),
      ),
    ).toEqual(new Set(["anthropic_messages"]));
    expect(artifact.requiredFollowup).toContain(
      "SUCCESSFUL_CAPABILITY_PILOT_EVIDENCE",
    );
    expect(
      new Set(
        artifact.manifest.executions.map(({ executionKey }) => executionKey),
      ).size,
    ).toBe(36);
    expect(artifact.manifest.sourceBundleDigest).toBe(
      artifact.sourceBundle.digest,
    );
    expect(artifact.manifest.planDigest).toBe(
      canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    );
    expect(artifact.admissionSourceDigest).toBe(
      canonicalDigest(COPY_QUALITY_MATRIX_ADMISSION_SOURCE),
    );
    expect(Object.values(artifact.sourceDigests)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}$/u)]),
    );
    expect(artifact.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      validateCopyQualityMatrixManifestArtifact(artifact),
    ).not.toThrow();
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.manifest.executions)).toBe(true);
  });

  it("binds runner, evaluator, fixture, and runtime drift independently", () => {
    const baseline = buildCopyQualityMatrixManifestArtifact({
      fixedSourceCommit: FIXED_SOURCE_COMMIT,
      preparationHeadCommit: PREPARATION_HEAD_COMMIT,
      sourceFiles: sourceFiles(),
    });

    for (const [role, digestKey] of [
      ["quality_matrix_runner", "runner"],
      ["quality_evaluator", "evaluator"],
      ["quality_replay", "evaluator"],
      ["quality_fixture", "fixtures"],
      ["runtime_adapter", "runtime"],
      ["runtime_execution", "runtime"],
    ] as const) {
      const drifted = buildCopyQualityMatrixManifestArtifact({
        fixedSourceCommit: FIXED_SOURCE_COMMIT,
        preparationHeadCommit: PREPARATION_HEAD_COMMIT,
        sourceFiles: mutateRoleDigest(sourceFiles(), role),
      });
      expect(drifted.sourceDigests[digestKey]).not.toBe(
        baseline.sourceDigests[digestKey],
      );
      expect(drifted.artifactDigest).not.toBe(baseline.artifactDigest);
    }
  });

  it("includes matrix dependencies plus all transitive runtime and contract sources", () => {
    const specs = buildCopyQualityMatrixSourceFileSpecs([
      "apps/api/src/model-runtime/capability-registry.ts",
      "apps/api/src/model-runtime/capability-registry.spec.ts",
      "packages/contracts/src/site-builder/locales.ts",
    ]);

    expect(specs).toEqual(
      expect.arrayContaining([
        {
          role: "quality_matrix_admission",
          path: "apps/api/src/site-builder/eval/copy-quality-matrix-admission.ts",
        },
        {
          role: "quality_matrix_runner",
          path: "apps/api/src/site-builder/eval/copy-quality-matrix-runner.ts",
        },
        {
          role: "quality_evaluator",
          path: "apps/api/src/site-builder/eval/copy-quality-evaluator.ts",
        },
        {
          role: "quality_replay",
          path: "apps/api/src/site-builder/eval/copy-quality-accepted-replay.ts",
        },
        {
          role: "quality_replay",
          path: "apps/api/src/site-builder/eval/copy-quality-candidate-receipt.ts",
        },
        {
          role: "quality_fixture",
          path: "apps/api/src/site-builder/eval/copy-assembly-eval.ts",
        },
        {
          role: "runtime_adapter",
          path: "apps/api/src/model-runtime/adapters/ai-sdk-openai-chat-completions.adapter.ts",
        },
        {
          role: "runtime_capability",
          path: "apps/api/src/model-runtime/capability-registry.ts",
        },
        {
          role: "contracts_transitive_source",
          path: "packages/contracts/src/site-builder/locales.ts",
        },
      ]),
    );
    expect(specs.map(({ path }) => path)).not.toContain(
      "apps/api/src/model-runtime/capability-registry.spec.ts",
    );
    expect(specs.map(({ path }) => path)).toEqual(
      [...specs.map(({ path }) => path)].sort(),
    );
  });

  it("preserves canonical v2 history but rejects it after the Chat plan drift", () => {
    const historicalPath = resolve(
      import.meta.dirname,
      "../../../../../docs/evidence/site-builder/m1-g-copy-quality-matrix-manifest-v2.json",
    );
    const historicalBytes = readFileSync(historicalPath, "utf8");
    const historical = JSON.parse(historicalBytes) as {
      artifactDigest: string;
      manifest: {
        planDigest: string;
        sourceBundleDigest: string;
        executions: Array<{ alias: string; protocol: string }>;
      };
      sourceBundle: { digest: string; files: unknown[] };
    };
    const { artifactDigest, ...withoutArtifactDigest } = historical;

    expect(historicalBytes).toBe(`${JSON.stringify(historical, null, 2)}\n`);
    expect(historical.sourceBundle.digest).toBe(
      canonicalDigest(historical.sourceBundle.files),
    );
    expect(historical.manifest.sourceBundleDigest).toBe(
      historical.sourceBundle.digest,
    );
    expect(artifactDigest).toBe(canonicalDigest(withoutArtifactDigest));
    expect(historical.manifest.planDigest).not.toBe(
      canonicalDigest(COPY_QUALITY_MATRIX_PLAN),
    );
    expect(
      new Set(
        historical.manifest.executions
          .filter(({ alias }) =>
            ["gpt-5.6-terra", "gpt-5.6-sol"].includes(alias),
          )
          .map(({ protocol }) => protocol),
      ),
    ).toEqual(new Set(["openai_responses"]));
    expect(() => validateCopyQualityMatrixManifestArtifact(historical)).toThrow(
      "COPY_QUALITY_MATRIX_MANIFEST_ARTIFACT_INVALID",
    );
  });

  it("rejects malformed commits, source order, duplicate paths, and artifact drift", () => {
    expect(() =>
      buildCopyQualityMatrixManifestArtifact({
        fixedSourceCommit: "HEAD",
        preparationHeadCommit: PREPARATION_HEAD_COMMIT,
        sourceFiles: sourceFiles(),
      }),
    ).toThrow("COPY_QUALITY_MATRIX_FIXED_SOURCE_COMMIT_INVALID");

    expect(() =>
      buildCopyQualityMatrixManifestArtifact({
        fixedSourceCommit: FIXED_SOURCE_COMMIT,
        preparationHeadCommit: PREPARATION_HEAD_COMMIT,
        sourceFiles: sourceFiles().reverse(),
      }),
    ).toThrow("COPY_QUALITY_MATRIX_SOURCE_BUNDLE_INVALID");

    const duplicated = sourceFiles();
    duplicated[1] = { ...duplicated[0]! };
    expect(() =>
      buildCopyQualityMatrixManifestArtifact({
        fixedSourceCommit: FIXED_SOURCE_COMMIT,
        preparationHeadCommit: PREPARATION_HEAD_COMMIT,
        sourceFiles: duplicated,
      }),
    ).toThrow("COPY_QUALITY_MATRIX_SOURCE_BUNDLE_INVALID");

    const artifact = buildCopyQualityMatrixManifestArtifact({
      fixedSourceCommit: FIXED_SOURCE_COMMIT,
      preparationHeadCommit: PREPARATION_HEAD_COMMIT,
      sourceFiles: sourceFiles(),
    });
    expect(() =>
      validateCopyQualityMatrixManifestArtifact({
        ...artifact,
        manifest: { ...artifact.manifest, maximumWireCalls: 73 },
      }),
    ).toThrow("COPY_QUALITY_MATRIX_MANIFEST_ARTIFACT_INVALID");
  });

  it("requires a clean origin/main HEAD and writes exactly once without network access", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const root = await createRepositoryFixture();

    const artifact = prepareCopyQualityMatrixManifestFromRepository(root);
    expect(artifact.fixedSourceCommit).toBe(git(root, ["rev-parse", "HEAD"]));
    expect(artifact.preparationHeadCommit).toBe(artifact.fixedSourceCommit);
    expect(artifact.preparationVerification).toMatchObject({
      fixedCommitEqualsPreparationHead: true,
      preparationHeadEqualsOriginMain: true,
      trackedSourceBytesMatch: true,
    });

    await writeCopyQualityMatrixManifestCreateOnly(root, artifact);
    const written = JSON.parse(
      readFileSync(
        join(root, COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH),
        "utf8",
      ),
    ) as unknown;
    expect(written).toEqual(JSON.parse(JSON.stringify(artifact)));
    expect(fetchSpy).not.toHaveBeenCalled();

    await expect(
      writeCopyQualityMatrixManifestCreateOnly(root, artifact),
    ).rejects.toThrow(/EEXIST|COPY_QUALITY_MATRIX_OUTPUT_EXISTS/u);
  });

  it("refuses unverified artifacts and repository drift before creating output", async () => {
    const root = await createRepositoryFixture();
    const unverified = buildCopyQualityMatrixManifestArtifact({
      fixedSourceCommit: git(root, ["rev-parse", "HEAD"]),
      preparationHeadCommit: git(root, ["rev-parse", "HEAD"]),
      sourceFiles: sourceFiles(),
    });
    await expect(
      writeCopyQualityMatrixManifestCreateOnly(root, unverified),
    ).rejects.toThrow("COPY_QUALITY_MATRIX_PREPARATION_NOT_VERIFIED");

    writeFileSync(join(root, "dirty.txt"), "dirty", "utf8");
    expect(() => prepareCopyQualityMatrixManifestFromRepository(root)).toThrow(
      "COPY_QUALITY_MATRIX_PREPARATION_WORKTREE_DIRTY",
    );
  });

  it("rejects a symlinked output evidence directory before creating the manifest", async () => {
    const root = await createRepositoryFixture();
    const artifact = prepareCopyQualityMatrixManifestFromRepository(root);
    const evidenceDirectory = join(root, "docs/evidence/site-builder");
    const symlinkTarget = join(root, "docs/evidence-real");
    rmSync(evidenceDirectory, { recursive: true, force: true });
    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, evidenceDirectory, "dir");

    await expect(
      writeCopyQualityMatrixManifestCreateOnly(root, artifact),
    ).rejects.toThrow("COPY_QUALITY_MATRIX_OUTPUT_PARENT_INVALID");
  });

  it("keeps the operational script create-only and free of clients, credentials, and network calls", () => {
    const script = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../scripts/prepare-site-builder-copy-quality-matrix-manifest.mts",
      ),
      "utf8",
    );
    expect(script).toContain("prepareCopyQualityMatrixManifestFromRepository");
    expect(script).toContain("writeCopyQualityMatrixManifestCreateOnly");
    expect(script).not.toMatch(/\bfetch\s*\(/u);
    expect(script).not.toMatch(/process\.env/u);
    expect(script).not.toMatch(/credential|bearer|api[_-]?key|model.*client/iu);
  });
});
