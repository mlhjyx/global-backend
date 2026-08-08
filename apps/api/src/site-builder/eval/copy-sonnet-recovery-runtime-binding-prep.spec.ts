import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_SONNET_RECOVERY_ADMISSION_SOURCE } from "./copy-sonnet-recovery-admission";
import {
  COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS,
  COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
  COPY_SONNET_RECOVERY_RUNTIME_SOURCE_FILE_SPECS,
  buildCopySonnetRecoveryRuntimeBindingArtifact,
  prepareCopySonnetRecoveryRuntimeBindingFromRepository,
  validateCopySonnetRecoveryRuntimeBindingArtifact,
} from "./copy-sonnet-recovery-runtime-binding-prep";

const REPOSITORY_ROOT = resolve(__dirname, "../../../../..");
const RECOVERY_MANIFEST_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v12.json";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const fixedSourceCommit = "a".repeat(40);
  const recoveryBytes = readFileSync(
    resolve(REPOSITORY_ROOT, RECOVERY_MANIFEST_PATH),
  );
  const recoveryArtifact = JSON.parse(recoveryBytes.toString("utf8")) as {
    artifactDigest: string;
    manifest: unknown;
  };
  const sourceFiles = COPY_SONNET_RECOVERY_RUNTIME_SOURCE_FILE_SPECS.map(
    ({ role, path }, index) => ({
      role,
      path,
      sha256:
        path === RECOVERY_MANIFEST_PATH
          ? sha256(recoveryBytes)
          : index.toString(16).padStart(64, "0"),
    }),
  );
  const sourceBundleDigest = canonicalDigest(sourceFiles);
  const artifacts = COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS.map(
    (path, index) => ({
      path,
      sha256: (index + 1).toString(16).padStart(64, "0"),
    }),
  );
  return {
    fixedSourceCommit,
    recoveryBytes,
    recoveryArtifact,
    sourceFiles,
    compiledRuntimeExpectation: {
      schemaVersion: "compiled-runtime-expectation/2026-08-08-v1" as const,
      buildSourceCommit: fixedSourceCommit,
      sourceBundleDigest,
      buildCommands: [
        "pnpm --filter @global/db generate",
        "pnpm --filter @global/contracts build",
        "pnpm --filter @global/api build",
      ],
      artifactCount: artifacts.length,
      artifacts,
      artifactTreeDigest: canonicalDigest(artifacts),
    },
  };
}

describe("Copy Sonnet recovery fixed-source runtime binding", () => {
  it("binds v12, the Sonnet-only runtime, and compiled bytes without dispatch", () => {
    const input = fixture();
    const artifact = buildCopySonnetRecoveryRuntimeBindingArtifact({
      fixedSourceCommit: input.fixedSourceCommit,
      preparationHeadCommit: input.fixedSourceCommit,
      sourceFiles: input.sourceFiles,
      recoveryManifestBytes: input.recoveryBytes,
      compiledRuntimeExpectation: input.compiledRuntimeExpectation,
      fixedCommitReachableFromOriginMainAtPreparation: false,
    });

    expect(COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH).toBe(
      "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v12.json",
    );
    expect(artifact).toMatchObject({
      classification: "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY_RUNTIME",
      fixedSourceCommit: input.fixedSourceCommit,
      preparationHeadCommit: input.fixedSourceCommit,
      requiredMergeMethod: "merge_commit",
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      manifest: {
        plannedExecutions: 1,
        maximumWireCalls: 2,
        maximumRepairCallsPerExecution: 1,
        executions: COPY_SONNET_RECOVERY_ADMISSION_SOURCE.executions,
      },
      recoveryManifestReference: {
        path: RECOVERY_MANIFEST_PATH,
        fileSha256: sha256(input.recoveryBytes),
        artifactDigest: input.recoveryArtifact.artifactDigest,
        manifestDigest: canonicalDigest(input.recoveryArtifact.manifest),
      },
      compiledRuntimeExpectation: {
        artifactTreeDigest: input.compiledRuntimeExpectation.artifactTreeDigest,
      },
    });
    expect(artifact.artifactDigest).toBe(
      canonicalDigest(
        Object.fromEntries(
          Object.entries(artifact).filter(([key]) => key !== "artifactDigest"),
        ),
      ),
    );
    expect(JSON.stringify(artifact.manifest)).not.toMatch(
      /gpt-5\.6-(terra|sol)/u,
    );
  });

  it("guards every recovery runtime module in the compiled expectation", () => {
    expect(COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS).toEqual(
      [...COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS].sort(),
    );
    expect(COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS).toEqual(
      expect.arrayContaining([
        "apps/api/dist/site-builder/eval/copy-sonnet-recovery-admission.js",
        "apps/api/dist/site-builder/eval/copy-sonnet-recovery-contract.js",
        "apps/api/dist/site-builder/eval/copy-real-capability-runner.js",
        "apps/api/dist/site-builder/eval/copy-pilot-source-verifier.js",
        "apps/api/dist/site-builder/eval/copy-pilot-trusted-gateway.js",
      ]),
    );
  });

  it("rejects a broadened compiled tree or a different recovery artifact", () => {
    const input = fixture();
    expect(() =>
      buildCopySonnetRecoveryRuntimeBindingArtifact({
        fixedSourceCommit: input.fixedSourceCommit,
        preparationHeadCommit: input.fixedSourceCommit,
        sourceFiles: input.sourceFiles,
        recoveryManifestBytes: input.recoveryBytes,
        compiledRuntimeExpectation: {
          ...input.compiledRuntimeExpectation,
          artifacts: [
            ...input.compiledRuntimeExpectation.artifacts,
            { path: "apps/api/dist/forged.js", sha256: "f".repeat(64) },
          ],
          artifactCount: input.compiledRuntimeExpectation.artifactCount + 1,
        },
        fixedCommitReachableFromOriginMainAtPreparation: false,
      }),
    ).toThrow("COPY_SONNET_RECOVERY_COMPILED_RUNTIME_EXPECTATION_INVALID");

    const changedRecoveryBytes = Buffer.from(
      input.recoveryBytes
        .toString("utf8")
        .replace("claude-sonnet-5", "gpt-5.6-terra"),
    );
    expect(() =>
      buildCopySonnetRecoveryRuntimeBindingArtifact({
        fixedSourceCommit: input.fixedSourceCommit,
        preparationHeadCommit: input.fixedSourceCommit,
        sourceFiles: input.sourceFiles,
        recoveryManifestBytes: changedRecoveryBytes,
        compiledRuntimeExpectation: input.compiledRuntimeExpectation,
        fixedCommitReachableFromOriginMainAtPreparation: false,
      }),
    ).toThrow("COPY_SONNET_RECOVERY_SOURCE_MANIFEST_INVALID");
  });

  it("validates exact recovery bytes and rejects post-build mutation", () => {
    const input = fixture();
    const artifact = buildCopySonnetRecoveryRuntimeBindingArtifact({
      fixedSourceCommit: input.fixedSourceCommit,
      preparationHeadCommit: input.fixedSourceCommit,
      sourceFiles: input.sourceFiles,
      recoveryManifestBytes: input.recoveryBytes,
      compiledRuntimeExpectation: input.compiledRuntimeExpectation,
      fixedCommitReachableFromOriginMainAtPreparation: false,
    });

    expect(() =>
      validateCopySonnetRecoveryRuntimeBindingArtifact(
        artifact,
        input.recoveryBytes,
      ),
    ).not.toThrow();
    expect(() =>
      validateCopySonnetRecoveryRuntimeBindingArtifact(
        { ...artifact, dispatchCapable: true },
        input.recoveryBytes,
      ),
    ).toThrow("COPY_SONNET_RECOVERY_RUNTIME_BINDING_ARTIFACT_INVALID");
  });

  it.runIf(process.env.COPY_SONNET_RECOVERY_REBUILD_TEST === "1")(
    "rebuilds the create-only binding from the clean current commit",
    async () => {
      const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      }).trim();
      const artifact =
        await prepareCopySonnetRecoveryRuntimeBindingFromRepository(
          REPOSITORY_ROOT,
        );

      expect(artifact).toMatchObject({
        fixedSourceCommit: currentCommit,
        preparationHeadCommit: currentCommit,
        dispatchAuthorization: "NOT_AUTHORIZED",
        dispatchCapable: false,
        observedNetworkCalls: 0,
        observedModelWireCalls: 0,
        observedModelCost: { CNY: 0, USD: 0 },
      });
      expect(artifact.compiledRuntimeExpectation.artifactCount).toBe(
        COPY_SONNET_RECOVERY_RUNTIME_ARTIFACT_PATHS.length,
      );
      expect(() =>
        validateCopySonnetRecoveryRuntimeBindingArtifact(
          artifact,
          readFileSync(resolve(REPOSITORY_ROOT, RECOVERY_MANIFEST_PATH)),
        ),
      ).not.toThrow();
    },
    90_000,
  );
});
