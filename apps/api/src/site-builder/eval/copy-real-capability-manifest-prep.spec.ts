import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime";
import { COPY_REAL_CAPABILITY_ADMISSION_SOURCE } from "./copy-real-capability-admission";
import {
  COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT,
  COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH,
  COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES,
  buildCopyRealCapabilityManifestArtifact,
  buildCopyRealCapabilitySourceFileSpecs,
  validateCopyRealCapabilityManifestArtifact,
  writeCopyRealCapabilityManifestCreateOnly,
  type CopyRealCapabilitySourceFile,
} from "./copy-real-capability-manifest-prep";

const PREPARATION_HEAD = "f".repeat(40);
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../..");
const HISTORICAL_MANIFEST_V1_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v1.json";
const HISTORICAL_MANIFEST_V2_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v2.json";

function sourceFiles(): CopyRealCapabilitySourceFile[] {
  return COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.map((entry, index) => ({
    ...entry,
    sha256: index.toString(16).padStart(64, "0"),
  }));
}

describe("Copy real capability create-only manifest preparation", () => {
  it("freezes the dispatch-preflight merge as manifest v3 without dispatch", () => {
    const artifact = buildCopyRealCapabilityManifestArtifact({
      preparationHeadCommit: PREPARATION_HEAD,
      sourceFiles: sourceFiles(),
    });

    expect(COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT).toBe(
      "03d701ee15d28254419fa4f04fb865ba4fd44932",
    );
    expect(COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH).toBe(
      "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v3.json",
    );
    expect(artifact).toMatchObject({
      schemaVersion:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1",
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v3",
      classification: "FIXED_SOURCE_CREATE_ONLY",
      fixedSourceCommit: COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT,
      preparationHeadCommit: PREPARATION_HEAD,
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        schemaVersion:
          "site-builder-copy-real-capability-manifest/2026-08-05-v1",
        manifestId: "site-builder-copy-real-capability/2026-08-05-v3",
        fixedSourceCommit: COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT,
        planDigest: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.planDigest,
        dispatchAuthorization: "NOT_AUTHORIZED",
        taskId: "site_builder.copy",
        plannedExecutions: 3,
        maximumWireCalls: 6,
        maximumRepairCallsPerExecution: 1,
        executions: [
          {
            alias: "gpt-5.6-terra",
            protocol: "openai_responses",
            reasoning: "medium",
          },
          {
            alias: "gpt-5.6-sol",
            protocol: "openai_responses",
            reasoning: "high",
          },
          {
            alias: "claude-sonnet-5",
            protocol: "anthropic_messages",
            reasoning: "medium",
          },
        ],
      },
      preparationVerification: {
        fixedCommitReachableFromPreparationHead: true,
        fixedCommitReachableFromOriginMain: true,
        trackedSourceBytesMatch: true,
        futureExecutionMustReverify: true,
      },
      compiledRuntimeAttestation: "REQUIRED_BEFORE_DISPATCH",
    });
    expect(artifact.manifest.sourceBundleDigest).toBe(
      artifact.sourceBundle.digest,
    );
    expect(artifact.contractSnapshot).toMatchObject({
      taskId: "site_builder.copy",
      planDigest: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.planDigest,
      executionScopeDigest: canonicalDigest(
        COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
      ),
    });
    expect(artifact.requiredFollowup).toContain(
      "SEPARATE_DISPATCH_AUTHORIZATION",
    );
    expect(artifact.requiredFollowup).toContain(
      "OPERATOR_AUTHENTICATED_EVIDENCE_AUTHORIZATION",
    );
    expect(artifact.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      validateCopyRealCapabilityManifestArtifact(artifact),
    ).not.toThrow();
  });

  it("rejects source bundle order, duplicate paths, and digest drift", () => {
    const reversed = sourceFiles().reverse();
    expect(() =>
      buildCopyRealCapabilityManifestArtifact({
        preparationHeadCommit: PREPARATION_HEAD,
        sourceFiles: reversed,
      }),
    ).toThrow("COPY_REAL_CAPABILITY_SOURCE_BUNDLE_INVALID");

    const duplicated = sourceFiles();
    duplicated[1] = { ...duplicated[0]! };
    expect(() =>
      buildCopyRealCapabilityManifestArtifact({
        preparationHeadCommit: PREPARATION_HEAD,
        sourceFiles: duplicated,
      }),
    ).toThrow("COPY_REAL_CAPABILITY_SOURCE_BUNDLE_INVALID");

    const artifact = buildCopyRealCapabilityManifestArtifact({
      preparationHeadCommit: PREPARATION_HEAD,
      sourceFiles: sourceFiles(),
    });
    const drifted = {
      ...artifact,
      manifest: {
        ...artifact.manifest,
        maximumWireCalls: 7 as never,
      },
    };
    expect(() => validateCopyRealCapabilityManifestArtifact(drifted)).toThrow(
      "COPY_REAL_CAPABILITY_MANIFEST_ARTIFACT_INVALID",
    );
  });

  it("expands the fixed bundle over the complete loaded runtime and contracts roots", () => {
    const specs = buildCopyRealCapabilitySourceFileSpecs([
      "apps/api/src/model-runtime/capability-registry.ts",
      "apps/api/src/model-runtime/capability-registry.spec.ts",
      "packages/contracts/src/site-builder/locales.ts",
    ]);

    expect(specs).toEqual(
      expect.arrayContaining([
        {
          role: "runtime_transitive_source",
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
    expect(specs).toEqual(
      expect.arrayContaining([
        {
          role: "gateway_settlement",
          path: "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
        },
        {
          role: "real_dispatch_ledger_identity",
          path: "apps/api/src/site-builder/eval/copy-pilot-ledger-identity.ts",
        },
        {
          role: "real_dispatch_source_verifier",
          path: "apps/api/src/site-builder/eval/copy-pilot-source-verifier.ts",
        },
        {
          role: "real_dispatch_gateway",
          path: "apps/api/src/site-builder/eval/copy-pilot-trusted-gateway.ts",
        },
        {
          role: "real_dispatch_runner",
          path: "apps/api/src/site-builder/eval/copy-real-capability-runner.ts",
        },
      ]),
    );
    expect(specs.map(({ path }) => path)).toEqual(
      [...specs.map(({ path }) => path)].sort(),
    );
  });

  it("refuses to persist an artifact without repository verification", async () => {
    const artifact = buildCopyRealCapabilityManifestArtifact({
      preparationHeadCommit: PREPARATION_HEAD,
      sourceFiles: sourceFiles(),
    });

    await expect(
      writeCopyRealCapabilityManifestCreateOnly("/tmp", artifact),
    ).rejects.toThrow("COPY_REAL_CAPABILITY_PREPARATION_NOT_VERIFIED");
  });

  it("keeps the generated repository v3 bound to the merged dispatch source", () => {
    const artifact = JSON.parse(
      readFileSync(
        resolve(REPOSITORY_ROOT, COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH),
        "utf8",
      ),
    );

    expect(() =>
      validateCopyRealCapabilityManifestArtifact(artifact),
    ).not.toThrow();
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v3",
      fixedSourceCommit: COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT,
      preparationHeadCommit: "fb1607d00cc29e3802fe265930bc5e9259899c76",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        manifestId: "site-builder-copy-real-capability/2026-08-05-v3",
        plannedExecutions: 3,
        maximumWireCalls: 6,
        maximumRepairCallsPerExecution: 1,
      },
    });
    expect(artifact.sourceBundle.files).toHaveLength(67);
    expect(artifact.sourceBundle.digest).toBe(
      "e3bcbb3c5705dd036b1db0f362f5d4f7352333488819fb28e6bc783466a5c63b",
    );
    expect(artifact.requiredFollowup).toContain(
      "OPERATOR_AUTHENTICATED_EVIDENCE_AUTHORIZATION",
    );
  });

  it("keeps repository v2 as self-consistent history after runtime v5 drift", () => {
    const artifact = JSON.parse(
      readFileSync(
        resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V2_PATH),
        "utf8",
      ),
    );

    expect(() => validateCopyRealCapabilityManifestArtifact(artifact)).toThrow(
      "COPY_REAL_CAPABILITY_MANIFEST_ARTIFACT_INVALID",
    );
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v2",
      fixedSourceCommit: "c167cde19e0d7d415303bc5353e2733480df13da",
      preparationHeadCommit: "42b6bc209560c30840ecd5b305325a5e3e93abc7",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
    });
    expect(artifact.sourceBundle.files).toHaveLength(60);
    expect(artifact.sourceBundle.digest).toBe(
      "c9ae0a641fc5401ad8dca84e267b550129e67af8426aebf407a5c48b76cf0901",
    );
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifact.sourceBundle.digest).toBe(
      canonicalDigest(artifact.sourceBundle.files),
    );
    expect(artifact.manifest.planDigest).not.toBe(
      COPY_REAL_CAPABILITY_ADMISSION_SOURCE.planDigest,
    );
  });

  it("keeps the historical artifact self-consistent after current-source drift", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V1_PATH);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1",
      fixedSourceCommit: "5287e5c4d95cd1eb78a61e71ba84c1dfa56b632a",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      compiledRuntimeAttestation: "REQUIRED_BEFORE_DISPATCH",
    });
    expect(artifact.manifest.executions).toEqual([
      {
        alias: "gpt-5.6-terra",
        protocol: "openai_responses",
        reasoning: "medium",
      },
      {
        alias: "gpt-5.6-sol",
        protocol: "openai_responses",
        reasoning: "high",
      },
      {
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages",
        reasoning: "medium",
      },
    ]);
    const { artifactDigest, ...artifactWithoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(artifactWithoutDigest));
    expect(artifact.sourceBundle.digest).toBe(
      canonicalDigest(artifact.sourceBundle.files),
    );
    expect(artifact.manifest.sourceBundleDigest).toBe(
      artifact.sourceBundle.digest,
    );

    const currentTransitivePaths = execFileSync(
      "git",
      [
        "ls-files",
        "--",
        "apps/api/src/model-runtime",
        "packages/contracts/src",
      ],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const historicalPaths = (
      artifact.sourceBundle.files as CopyRealCapabilitySourceFile[]
    ).map(({ path }) => path);
    const currentPaths = buildCopyRealCapabilitySourceFileSpecs(
      currentTransitivePaths,
    ).map(({ path }) => path);
    expect(currentPaths).toContain(
      "apps/api/src/model-runtime/compiled-runtime-guard.ts",
    );
    expect(historicalPaths).not.toContain(
      "apps/api/src/model-runtime/compiled-runtime-guard.ts",
    );
    expect(historicalPaths).not.toEqual(currentPaths);

    const workingMatches: boolean[] = [];
    for (const entry of artifact.sourceBundle
      .files as CopyRealCapabilitySourceFile[]) {
      const workingBytes = readFileSync(resolve(REPOSITORY_ROOT, entry.path));
      workingMatches.push(
        createHash("sha256").update(workingBytes).digest("hex") ===
          entry.sha256,
      );
    }
    expect(workingMatches).toContain(false);

    const forbiddenKeys = new Set([
      "apiKey",
      "bearer",
      "credentialHandle",
      "gatewayUrl",
      "reservation",
      "settlementReceipt",
      "token",
    ]);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        expect(forbiddenKeys.has(key)).toBe(false);
        visit(child);
      }
    };
    visit(artifact);
  });
});
