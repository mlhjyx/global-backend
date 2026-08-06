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
const HISTORICAL_MANIFEST_V3_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v3.json";
const HISTORICAL_MANIFEST_V4_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v4.json";

function sourceFiles(): CopyRealCapabilitySourceFile[] {
  return COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.map((entry, index) => ({
    ...entry,
    sha256: index.toString(16).padStart(64, "0"),
  }));
}

describe("Copy real capability create-only manifest preparation", () => {
  it("freezes the live preflight fix merge as manifest v5 without dispatch", () => {
    const artifact = buildCopyRealCapabilityManifestArtifact({
      preparationHeadCommit: PREPARATION_HEAD,
      sourceFiles: sourceFiles(),
    });

    expect(COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT).toBe(
      "ecdd45b7947b1fec061286d4a68199ab7ad6a49c",
    );
    expect(COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH).toBe(
      "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v5.json",
    );
    expect(artifact).toMatchObject({
      schemaVersion:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1",
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-06-v5",
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
        manifestId: "site-builder-copy-real-capability/2026-08-06-v5",
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
      "apps/api/src/model-runtime/real-model-execution-ledger-storage.ts",
      "apps/api/src/model-runtime/real-model-execution-ledger.ts",
      "apps/api/src/site-builder/eval/copy-operator-evidence-authorization.ts",
      "apps/api/src/site-builder/eval/copy-operator-evidence-key.ts",
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
        {
          role: "operator_evidence_key",
          path: "apps/api/src/site-builder/eval/copy-operator-evidence-key.ts",
        },
        {
          role: "operator_evidence_authorization",
          path: "apps/api/src/site-builder/eval/copy-operator-evidence-authorization.ts",
        },
        {
          role: "runtime_transitive_source",
          path: "apps/api/src/model-runtime/real-model-execution-ledger-storage.ts",
        },
        {
          role: "runtime_transitive_source",
          path: "apps/api/src/model-runtime/real-model-execution-ledger.ts",
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

  it("keeps repository v5 bound to the merged live preflight source", () => {
    const artifactPath = resolve(
      REPOSITORY_ROOT,
      COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH,
    );
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "df5f8c1b42135eacf6ed1d5d92ca5fe4d960c6af4c31b426392292df69f1a428",
    );
    expect(() =>
      validateCopyRealCapabilityManifestArtifact(artifact),
    ).not.toThrow();
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-06-v5",
      fixedSourceCommit: COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT,
      preparationHeadCommit: "c7f7acd3dd652829353c25c963c38dc79830081c",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        manifestId: "site-builder-copy-real-capability/2026-08-06-v5",
        plannedExecutions: 3,
        maximumWireCalls: 6,
        maximumRepairCallsPerExecution: 1,
      },
    });
    expect(artifact.sourceBundle.files).toHaveLength(69);
    expect(artifact.sourceBundle.digest).toBe(
      canonicalDigest(artifact.sourceBundle.files),
    );
    expect(artifact.sourceBundle.digest).toBe(
      "6bb9626e0d41aa0fabee4473b9cc90fc98e2e0feca7e20609daa546dcce02aae",
    );
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifactDigest).toBe(
      "b93a0b0b5cf01fd61a92407634b2aec47c142502aec0a40251de5d5cc4bc0118",
    );
    expect(artifact.sourceBundle.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "runtime_transitive_source",
          path: "apps/api/src/model-runtime/real-model-execution-ledger-storage.ts",
        }),
        expect.objectContaining({
          role: "runtime_transitive_source",
          path: "apps/api/src/model-runtime/real-model-execution-ledger.ts",
        }),
        expect.objectContaining({
          role: "operator_evidence_key",
          path: "apps/api/src/site-builder/eval/copy-operator-evidence-key.ts",
        }),
        expect.objectContaining({
          role: "operator_evidence_authorization",
          path: "apps/api/src/site-builder/eval/copy-operator-evidence-authorization.ts",
        }),
        expect.objectContaining({
          role: "real_dispatch_runner",
          path: "apps/api/src/site-builder/eval/copy-real-capability-runner.ts",
        }),
      ]),
    );
    for (const entry of artifact.sourceBundle
      .files as CopyRealCapabilitySourceFile[]) {
      const checkedOutBytes = readFileSync(
        resolve(REPOSITORY_ROOT, entry.path),
      );
      expect(createHash("sha256").update(checkedOutBytes).digest("hex")).toBe(
        entry.sha256,
      );
    }
  });

  it("keeps repository v4 as self-consistent stale history", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V4_PATH);
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "5601ef8ead8fd69ce96d72e2ceecdf3dcd42d1a17930fcd8ef0699e25c8deeaa",
    );
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v4",
      fixedSourceCommit: "00d39b384a03c2144fc04029ec90a3e840550140",
      preparationHeadCommit: "9d6adb80facdb4fa7eb064cffd5ef6d1d4c6212d",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        manifestId: "site-builder-copy-real-capability/2026-08-05-v4",
        plannedExecutions: 3,
        maximumWireCalls: 6,
        maximumRepairCallsPerExecution: 1,
      },
    });
    expect(artifact.sourceBundle.files).toHaveLength(69);
    expect(artifact.sourceBundle.digest).toBe(
      "8eee87290b1a462d405f9b6d891f1f1db646c17ea1409292d16d962d24b3ccaf",
    );
    expect(artifact.artifactDigest).toBe(
      "fa098048b1d3bba6ddcad70a1adc9cd4df6ccdbfd213c49f51d1c66fbf4766d5",
    );
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifact.sourceBundle.digest).toBe(
      canonicalDigest(artifact.sourceBundle.files),
    );
    expect(artifact.manifest.sourceBundleDigest).toBe(
      artifact.sourceBundle.digest,
    );
  });

  it("keeps repository v3 as self-consistent history after the operator gate", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V3_PATH);
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "953101004cd8c93c42ec2416bf9fe3c5e8aefbd04ff939869eedfb78380359e0",
    );
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v3",
      fixedSourceCommit: "03d701ee15d28254419fa4f04fb865ba4fd44932",
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
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifact.sourceBundle.digest).toBe(
      canonicalDigest(artifact.sourceBundle.files),
    );
    expect(artifact.manifest.sourceBundleDigest).toBe(
      artifact.sourceBundle.digest,
    );
    expect(
      artifact.sourceBundle.files.map(
        ({ path }: CopyRealCapabilitySourceFile) => path,
      ),
    ).not.toEqual(
      expect.arrayContaining([
        "apps/api/src/site-builder/eval/copy-operator-evidence-key.ts",
        "apps/api/src/site-builder/eval/copy-operator-evidence-authorization.ts",
      ]),
    );
    expect(
      artifact.sourceBundle.files.every(
        ({ sha256 }: CopyRealCapabilitySourceFile) =>
          /^[0-9a-f]{64}$/u.test(sha256),
      ),
    ).toBe(true);
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
