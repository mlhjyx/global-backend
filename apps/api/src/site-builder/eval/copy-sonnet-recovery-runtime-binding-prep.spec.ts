import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_SONNET_RECOVERY_ADMISSION_SOURCE } from "./copy-sonnet-recovery-admission";
import { buildCopyRealCapabilitySourceFileSpecs } from "./copy-real-capability-manifest-prep";
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
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v13.json";

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
  it("binds v13, the Sonnet-only runtime, and compiled bytes without dispatch", () => {
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
      "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v13.json",
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
        manifestId:
          "site-builder-copy-sonnet-recovery-runtime/2026-08-09-v13-v1",
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
    const fixedSourceSpecs = buildCopyRealCapabilitySourceFileSpecs([
      "apps/api/src/model-runtime/real-model-execution-ledger-storage.ts",
      "apps/api/src/model-runtime/real-model-execution-ledger.ts",
    ]);
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
    expect(fixedSourceSpecs).toEqual(
      expect.arrayContaining([
        {
          role: "gateway_settlement",
          path: "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
        },
        {
          role: "runtime_adapter",
          path: "apps/api/src/model-runtime/adapters/ai-sdk-adapter-result.ts",
        },
        {
          role: "runtime_execution",
          path: "apps/api/src/model-runtime/durable-model-execution-runtime.ts",
        },
        {
          role: "runtime_ledger",
          path: "apps/api/src/model-runtime/model-execution-ledger.ts",
        },
        {
          role: "runtime_transitive_source",
          path: "apps/api/src/model-runtime/real-model-execution-ledger.ts",
        },
        {
          role: "runtime_types",
          path: "apps/api/src/model-runtime/types.ts",
        },
        {
          role: "real_dispatch_runner",
          path: "apps/api/src/site-builder/eval/copy-real-capability-runner.ts",
        },
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

  it("keeps runtime-binding preparation free of clients, credentials, environment reads, and fetch", () => {
    const sources = [
      readFileSync(
        resolve(
          import.meta.dirname,
          "copy-sonnet-recovery-runtime-binding-prep.ts",
        ),
        "utf8",
      ),
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../scripts/prepare-site-builder-copy-sonnet-recovery-runtime-binding.mts",
        ),
        "utf8",
      ),
    ].join("\n");

    expect(sources).not.toMatch(/\bfetch\b|process\.env|apiKey|credentialRef/u);
  });

  it("matches the generated v13 create-only runtime binding exactly", () => {
    const recoveryManifestBytes = readFileSync(
      resolve(REPOSITORY_ROOT, RECOVERY_MANIFEST_PATH),
    );
    const bindingBytes = readFileSync(
      resolve(
        REPOSITORY_ROOT,
        COPY_SONNET_RECOVERY_RUNTIME_BINDING_OUTPUT_PATH,
      ),
    );
    const artifact = JSON.parse(bindingBytes.toString("utf8"));

    expect(sha256(bindingBytes)).toBe(
      "ce1ddef1d5a862817cc154f63fff05130e5ef462815e15b69421a1e828e4e6a6",
    );
    expect(() =>
      validateCopySonnetRecoveryRuntimeBindingArtifact(
        artifact,
        recoveryManifestBytes,
      ),
    ).not.toThrow();
    // The v13 binding is historical after execution: later runtime fixes must
    // not rewrite it or be forced to match its frozen source bytes. Verify the
    // immutable Git blobs when the checkout has history; shallow CI still
    // verifies the artifact's own digest and schema above.
    const shallowCheckout =
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      }).trim() === "true";
    if (!shallowCheckout) {
      for (const source of artifact.sourceBundle.files) {
        const fixedBytes = execFileSync(
          "git",
          ["show", `${artifact.fixedSourceCommit}:${source.path}`],
          { cwd: REPOSITORY_ROOT, encoding: "buffer" },
        );
        expect(sha256(fixedBytes)).toBe(source.sha256);
      }
    }
    expect(artifact).toMatchObject({
      fixedSourceCommit: "874a8cc2aa637c35f8c78302006ffb370913fcb7",
      preparationHeadCommit: "874a8cc2aa637c35f8c78302006ffb370913fcb7",
      artifactDigest:
        "caa42cbfd69c1fcad25c1bc5dc0b8c787098ca84fa6619270c882d41b7a901e5",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      recoveryManifestReference: {
        path: RECOVERY_MANIFEST_PATH,
        fileSha256:
          "99a1d51497b2112a83f5e18f8509baddd5f6486be13f92e08c3b5fec8dac0b47",
        artifactDigest:
          "476a8d68a0fae68a7ddeb28bd58ff3bc21956b505420586e81d6a08fef903152",
      },
      sourceBundle: {
        digest:
          "139c8661b03ea74135d901ec5e0ce5d399f53a9267a73e8e9f2900724626e3ed",
      },
      compiledRuntimeExpectation: {
        artifactCount: 53,
        artifactTreeDigest:
          "a7ac0ca8825dc4fdc802a58facae0b9fa42549e33adb03a4fdc1347d3b79bb6c",
      },
      preparationVerification: {
        fixedCommitReachableFromOriginMainAtPreparation: false,
      },
    });
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
