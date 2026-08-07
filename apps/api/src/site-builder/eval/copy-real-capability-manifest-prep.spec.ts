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
const HISTORICAL_MANIFEST_V5_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v5.json";
const HISTORICAL_MANIFEST_V6_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v6.json";
const HISTORICAL_MANIFEST_V7_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v7.json";
const HISTORICAL_MANIFEST_V8_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v8.json";
const CURRENT_MANIFEST_V9_PATH =
  "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v9.json";

function sourceFiles(): CopyRealCapabilitySourceFile[] {
  return COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.map((entry, index) => ({
    ...entry,
    sha256: index.toString(16).padStart(64, "0"),
  }));
}

describe("Copy real capability create-only manifest preparation", () => {
  it("prepares the post-merge runtime evidence source as manifest v9 without dispatch", () => {
    const artifact = buildCopyRealCapabilityManifestArtifact({
      preparationHeadCommit: PREPARATION_HEAD,
      sourceFiles: sourceFiles(),
    });

    expect(COPY_REAL_CAPABILITY_FIXED_SOURCE_COMMIT).toBe(
      "5775945c6e056e99ba9357d8d8794b01fad0c66b",
    );
    expect(COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH).toBe(
      "docs/evidence/site-builder/m1-g-copy-real-capability-manifest-v9.json",
    );
    expect(artifact).toMatchObject({
      schemaVersion:
        "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1",
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-07-v9",
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
        manifestId: "site-builder-copy-real-capability/2026-08-07-v9",
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
      contractSnapshot: {
        taskId: "site_builder.copy",
        planId: "site-builder-copy-capability-pilot/2026-08-07-v9",
        planDigest: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.planDigest,
        executionScopeDigest: canonicalDigest(
          COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
        ),
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
    expect(artifact.requiredFollowup).toContain(
      "PURPOSE_SPECIFIC_FINITE_CREDENTIAL_ATTESTATION",
    );
    expect(artifact.requiredFollowup).toContain(
      "GIT_REVIEWED_RUNTIME_SETTLEMENT_EVIDENCE",
    );
    expect(artifact.requiredFollowup).toContain(
      "SEPARATE_DISPATCH_AUTHORIZATION",
    );
    expect(artifact.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      validateCopyRealCapabilityManifestArtifact(artifact),
    ).not.toThrow();
  });

  it("rejects source bundle order, duplicate paths, and manifest drift", () => {
    expect(() =>
      buildCopyRealCapabilityManifestArtifact({
        preparationHeadCommit: PREPARATION_HEAD,
        sourceFiles: sourceFiles().reverse(),
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
      "apps/api/src/model-runtime/git-reviewed-evidence-acceptance.ts",
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
          role: "git_reviewed_evidence_acceptance",
          path: "apps/api/src/model-runtime/git-reviewed-evidence-acceptance.ts",
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
    expect(specs.map(({ path }) => path)).not.toEqual(
      expect.arrayContaining([
        "apps/api/src/site-builder/eval/copy-operator-evidence-key.ts",
        "apps/api/src/site-builder/eval/copy-operator-evidence-authorization.ts",
      ]),
    );
  });

  it("refuses to persist an artifact without repository verification", async () => {
    await expect(
      writeCopyRealCapabilityManifestCreateOnly("/tmp", {} as never),
    ).rejects.toThrow("COPY_REAL_CAPABILITY_PREPARATION_NOT_VERIFIED");
  });

  it("freezes repository v9 as the current fixed-source create-only manifest", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, CURRENT_MANIFEST_V9_PATH);
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "ad29a6fffd5e7dee36e7642f7b7137a855b9d6b6c7e56f240552ccb65c30565e",
    );
    expect(() =>
      validateCopyRealCapabilityManifestArtifact(artifact),
    ).not.toThrow();
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-07-v9",
      fixedSourceCommit: "5775945c6e056e99ba9357d8d8794b01fad0c66b",
      preparationHeadCommit: "118d657d9ed3f43228a9ebf7d960e7c7fb884b17",
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        manifestId: "site-builder-copy-real-capability/2026-08-07-v9",
        fixedSourceCommit: "5775945c6e056e99ba9357d8d8794b01fad0c66b",
        plannedExecutions: 3,
        maximumWireCalls: 6,
        maximumRepairCallsPerExecution: 1,
      },
      contractSnapshot: {
        planId: "site-builder-copy-capability-pilot/2026-08-07-v9",
        planDigest:
          "fd77404ce29d05e79550a103331cbac25049064630027672e96581765c364177",
        executionScopeDigest:
          "8660c38795b89fe213f0a9727f1a403ff2f8c3c2b5f5d7b36b32d90ef843ef48",
        admissionSourceDigest:
          "797e678c26801669ca10348e4c5b457ca5500e342686bef747dbc7cf7301688b",
      },
    });
    expect(artifact.sourceBundle.files).toHaveLength(68);
    expect(artifact.sourceBundle.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "git_reviewed_evidence_acceptance",
          path: "apps/api/src/model-runtime/git-reviewed-evidence-acceptance.ts",
        }),
      ]),
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
    expect(artifact.sourceBundle.digest).toBe(
      canonicalDigest(artifact.sourceBundle.files),
    );
    expect(artifact.sourceBundle.digest).toBe(
      "9dc4fed321e58f21f939703c1e0ffe9874512a8715618a3b94f77c3cec1ff4be",
    );
    expect(artifact.manifest.sourceBundleDigest).toBe(
      artifact.sourceBundle.digest,
    );
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifactDigest).toBe(
      "f4eaa8e481cbe7403fce778c65b2c1ec2bbf005f6f913c787917b7045a6cd9ce",
    );
  });

  it("keeps repository v8 as immutable superseded history", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V8_PATH);
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "c634d384ed32fd79ae5b53b870c303f6f9995b41562e8396bea9873f182eb14f",
    );
    expect(() => validateCopyRealCapabilityManifestArtifact(artifact)).toThrow(
      "COPY_REAL_CAPABILITY_MANIFEST_ARTIFACT_INVALID",
    );
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-06-v8",
      fixedSourceCommit: "719aacc2ec328870316b71cb0666d22828b89e74",
      preparationHeadCommit: "5e30427a2a08e95e1f4dfa80f039537bd96f5102",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        manifestId: "site-builder-copy-real-capability/2026-08-06-v8",
        plannedExecutions: 3,
        maximumWireCalls: 6,
        maximumRepairCallsPerExecution: 1,
      },
    });
    expect(artifact.sourceBundle.files).toHaveLength(69);
    expect(artifact.requiredFollowup).toContain(
      "OPERATOR_AUTHENTICATED_EVIDENCE_AUTHORIZATION",
    );
    expect(artifact.sourceBundle.digest).toBe(
      canonicalDigest(artifact.sourceBundle.files),
    );
    expect(artifact.sourceBundle.digest).toBe(
      "0740bb45fcb12a9f29b94ecad5fafbe5d1a5e6b1d58b44343c9ecc407a8c3809",
    );
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifactDigest).toBe(
      "1a08697dec16333593dde4b655da0b36b676b11856bb7bbc5ecd7330a945ff0d",
    );
  });

  it("keeps repository v7 as immutable superseded history", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V7_PATH);
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "0dcced98628249a0d7db96fedba6a23570178ffdbe5af97d9b9f2845896f424e",
    );
    expect(() => validateCopyRealCapabilityManifestArtifact(artifact)).toThrow(
      "COPY_REAL_CAPABILITY_MANIFEST_ARTIFACT_INVALID",
    );
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-06-v7",
      fixedSourceCommit: "a0dde9014a4ca22a87191e778303354a96bd7296",
      preparationHeadCommit: "6d86e393b842663f679dcd3d7d19ce953e73a605",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        manifestId: "site-builder-copy-real-capability/2026-08-06-v7",
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
      "7c23b6bd48209f586c657dd269d784c8c5aa6ef489a161d26559be3a7db8d598",
    );
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifactDigest).toBe(
      "2b66605a89b0ac412b1f61c23216b4c7cdfc9815e809386dba3fb4c0027961e9",
    );
  });

  it("keeps repository v6 as immutable superseded history", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V6_PATH);
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "948ac50be094c4b7398ed0644b98c55fdfa41b319f958ee295bb0b5503510f39",
    );
    expect(() => validateCopyRealCapabilityManifestArtifact(artifact)).toThrow(
      "COPY_REAL_CAPABILITY_MANIFEST_ARTIFACT_INVALID",
    );
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-06-v6",
      fixedSourceCommit: "55f10fa325916be6dde488ab148d1462175cda12",
      preparationHeadCommit: "abb8d3ff74f2998614ad7cac4c3686000db7cb6f",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        manifestId: "site-builder-copy-real-capability/2026-08-06-v6",
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
      "6e74f4f533f56a3def20d4f18d09ac17cc589f3e517915f099472b877eb3704a",
    );
    const { artifactDigest, ...withoutDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutDigest));
    expect(artifactDigest).toBe(
      "c9a4391e20523e980197745f66a0796e8438b6e5186f8bc3bf4e1823b0341d21",
    );
    const historicalFiles = artifact.sourceBundle
      .files as CopyRealCapabilitySourceFile[];
    expect(new Set(historicalFiles.map(({ path }) => path)).size).toBe(
      historicalFiles.length,
    );
    expect(historicalFiles.map(({ path }) => path)).toEqual(
      [...historicalFiles.map(({ path }) => path)].sort(),
    );
    expect(
      historicalFiles.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)),
    ).toBe(true);
  });

  it("keeps repository v5 as self-consistent frozen history", () => {
    const artifactPath = resolve(REPOSITORY_ROOT, HISTORICAL_MANIFEST_V5_PATH);
    const artifactBytes = readFileSync(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "df5f8c1b42135eacf6ed1d5d92ca5fe4d960c6af4c31b426392292df69f1a428",
    );
    expect(artifact).toMatchObject({
      artifactId:
        "site-builder-copy-real-capability-manifest-prep/2026-08-06-v5",
      fixedSourceCommit: "ecdd45b7947b1fec061286d4a68199ab7ad6a49c",
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
