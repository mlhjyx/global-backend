import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES,
  type CopyRealCapabilitySourceFile,
} from "./copy-real-capability-manifest-prep";
import {
  COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
  COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH,
  COPY_SONNET_RECOVERY_PROVENANCE_PATHS,
  buildCopySonnetRecoveryManifestArtifact,
  readCopySonnetRecoveryFixedTrackedFile,
  validateCopySonnetRecoveryManifestArtifact,
  writeCopySonnetRecoveryManifestCreateOnly,
  type CopySonnetRecoveryProvenanceArtifactRef,
} from "./copy-sonnet-recovery-manifest-prep";
import { describe, expect, it } from "vitest";

const PREPARATION_HEAD = "f".repeat(40);

function sourceFiles(): CopyRealCapabilitySourceFile[] {
  return COPY_REAL_CAPABILITY_MANIFEST_SOURCE_FILES.map((entry, index) => ({
    ...entry,
    sha256: (index + 1).toString(16).padStart(64, "0"),
  }));
}

function provenance(): CopySonnetRecoveryProvenanceArtifactRef[] {
  const artifactDigests = [
    "80f6a95979eb3c0fff880038d501043241f057f5fe4f35980409525ace1e8172",
    "fe4f215a19ea22916dadf1a14b6fd34f7dc5bf74d0fcc49099200b8a96bff652",
    "91f06c42d5b314ed6f722e6cf3733d8394ee0ed0c95d11c6252fbbe56024b0df",
    "c4afda144365b6b802609cdafd327a6174fae307d90dc5c4dbbfabc20866c23c",
  ] as const;
  const fileSha256 = [
    "f56ee0a7e565b3333e6781d4e2f9d2d0a49b769ffe0ae08f6b0ea2c41af72205",
    "94e5160380a77c717ba419155bd04aac04f8124bf303ba5eadea229c9fd2e537",
    "5d0d0860a30889119e63bdda0b3f561756d928d0ed6e4c0f7927c8c85242a16b",
    "f3b3ff91fec28611c822cbcf8613af0d1e65882ee3ae5ee633e7483aff461d41",
  ] as const;
  return COPY_SONNET_RECOVERY_PROVENANCE_PATHS.map((path, index) => ({
    path,
    fileSha256: fileSha256[index]!,
    artifactDigest: artifactDigests[index]!,
  }));
}

describe("Copy Sonnet-only recovery create-only manifest", () => {
  it("binds one Sonnet execution to the post-v12-fix main and excludes successful wires", () => {
    expect(COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT).toBe(
      "a29b222a45ae5fdb4868d5235cc94aeab1574ecd",
    );
    expect(COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH).toBe(
      "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v13.json",
    );
    const files = sourceFiles();
    const artifact = buildCopySonnetRecoveryManifestArtifact({
      preparationHeadCommit: PREPARATION_HEAD,
      sourceFiles: files,
      provenanceArtifacts: provenance(),
      fixedCommitReachableFromOriginMainAtPreparation: true,
    });

    expect(artifact).toMatchObject({
      schemaVersion:
        "site-builder-copy-sonnet-recovery-manifest-prep/2026-08-08-v1",
      artifactId:
        "site-builder-copy-sonnet-recovery-manifest-prep/2026-08-09-v13",
      classification: "FIXED_SOURCE_CREATE_ONLY_SONNET_RECOVERY",
      fixedSourceCommit: COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
      preparationHeadCommit: PREPARATION_HEAD,
      requiredMergeMethod: "merge_commit",
      createOnly: true,
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      manifest: {
        schemaVersion:
          "site-builder-copy-sonnet-recovery-manifest/2026-08-08-v1",
        manifestId: "site-builder-copy-sonnet-recovery/2026-08-09-v13",
        taskId: "site_builder.copy",
        plannedExecutions: 1,
        maximumWireCalls: 2,
        maximumRepairCallsPerExecution: 1,
        executions: [
          {
            executionKey: "copy-sonnet-recovery-v13-claude-sonnet-5",
            sourcePilotExecutionKey: "copy-capability-3-claude-sonnet-5",
            alias: "claude-sonnet-5",
            protocol: "anthropic_messages",
            reasoning: "medium",
          },
        ],
      },
      duplicatePrevention: {
        acceptedAliasesExcludedFromDispatch: ["gpt-5.6-terra", "gpt-5.6-sol"],
        acceptedWireReplayPolicy:
          "never_repeat_successful_v11_or_stopped_v12_wires",
        consumedAuthorizationPolicy:
          "never_reuse_v11_or_v12_authorization",
      },
    });
    expect(artifact.manifest.executions).toHaveLength(1);
    expect(artifact.manifest.executions.map(({ alias }) => alias)).not.toEqual(
      expect.arrayContaining(["gpt-5.6-terra", "gpt-5.6-sol"]),
    );
    expect(artifact.requiredFollowup).toContain(
      "SEPARATE_SONNET_RECOVERY_DISPATCH_AUTHORIZATION",
    );
    expect(artifact.requiredFollowup).toContain(
      "RECOVERY_ADMISSION_AND_RUNNER_BINDING",
    );
    expect(artifact.requiredFollowup).toContain(
      "FIXED_SOURCE_COMPILED_RUNTIME_EXPECTATION",
    );
    expect(artifact.requiredFollowup).toContain(
      "NEVER_REUSE_STOPPED_V12_AUTHORIZATION_OR_WIRE",
    );
    expect(artifact).not.toHaveProperty("compiledRuntimeExpectation");
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(() =>
      validateCopySonnetRecoveryManifestArtifact(artifact),
    ).not.toThrow();
  });

  it("fails closed on provenance or source drift", () => {
    const files = sourceFiles();
    const valid = {
      preparationHeadCommit: PREPARATION_HEAD,
      sourceFiles: files,
      provenanceArtifacts: provenance(),
      fixedCommitReachableFromOriginMainAtPreparation: true,
    };

    expect(() =>
      buildCopySonnetRecoveryManifestArtifact({
        ...valid,
        provenanceArtifacts: valid.provenanceArtifacts.slice(1),
      }),
    ).toThrow("COPY_SONNET_RECOVERY_PROVENANCE_INVALID");
    expect(() =>
      buildCopySonnetRecoveryManifestArtifact({
        ...valid,
        provenanceArtifacts: valid.provenanceArtifacts.map((entry, index) =>
          index === 0 ? { ...entry, fileSha256: "0".repeat(64) } : entry,
        ),
      }),
    ).toThrow("COPY_SONNET_RECOVERY_PROVENANCE_INVALID");
    expect(() =>
      buildCopySonnetRecoveryManifestArtifact({
        ...valid,
        sourceFiles: [...files].reverse(),
      }),
    ).toThrow("COPY_SONNET_RECOVERY_SOURCE_BUNDLE_INVALID");
    expect(() => validateCopySonnetRecoveryManifestArtifact({})).toThrow(
      "COPY_SONNET_RECOVERY_MANIFEST_ARTIFACT_INVALID",
    );
  });

  it("refuses to persist an artifact not produced by repository verification", async () => {
    await expect(
      writeCopySonnetRecoveryManifestCreateOnly("/tmp", {} as never),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_PREPARATION_NOT_VERIFIED");
  });

  it("reads fixed tracked bytes through a no-follow descriptor and rejects drift", () => {
    const repositoryRoot = mkdtempSync(
      join(tmpdir(), "copy-sonnet-recovery-source-"),
    );
    const trackedPath = "evidence.json";
    const absolutePath = resolve(repositoryRoot, trackedPath);
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: repositoryRoot,
      });
      execFileSync("git", ["config", "user.name", "Test"], {
        cwd: repositoryRoot,
      });
      writeFileSync(absolutePath, "fixed\n", "utf8");
      execFileSync("git", ["add", trackedPath], { cwd: repositoryRoot });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
        cwd: repositoryRoot,
      });
      const fixedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim();

      expect(
        readCopySonnetRecoveryFixedTrackedFile({
          repositoryRoot,
          fixedCommit,
          path: trackedPath,
        }).toString("utf8"),
      ).toBe("fixed\n");

      writeFileSync(absolutePath, "drift\n", "utf8");
      expect(() =>
        readCopySonnetRecoveryFixedTrackedFile({
          repositoryRoot,
          fixedCommit,
          path: trackedPath,
        }),
      ).toThrow("COPY_SONNET_RECOVERY_TRACKED_BYTES_MISMATCH");

      unlinkSync(absolutePath);
      symlinkSync("/etc/hosts", absolutePath);
      expect(() =>
        readCopySonnetRecoveryFixedTrackedFile({
          repositoryRoot,
          fixedCommit,
          path: trackedPath,
        }),
      ).toThrow("COPY_SONNET_RECOVERY_TRACKED_FILE_INVALID");
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("keeps the preparation path free of clients, credentials, environment reads, and fetch", () => {
    const sources = [
      readFileSync(
        resolve(import.meta.dirname, "copy-sonnet-recovery-manifest-prep.ts"),
        "utf8",
      ),
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../../scripts/prepare-site-builder-copy-sonnet-recovery-manifest.mts",
        ),
        "utf8",
      ),
    ].join("\n");
    expect(sources).not.toMatch(/\bfetch\b|process\.env|apiKey|credentialRef/u);
  });

  it("matches the generated v13 create-only artifact exactly", () => {
    const artifactBytes = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../../../",
        COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH,
      ),
    );
    const artifact = JSON.parse(artifactBytes.toString("utf8"));

    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(
      "TO_BE_REPLACED_AFTER_CREATE_ONLY_GENERATION",
    );
    expect(() =>
      validateCopySonnetRecoveryManifestArtifact(artifact),
    ).not.toThrow();
    expect(artifact).toMatchObject({
      fixedSourceCommit: COPY_SONNET_RECOVERY_FIXED_SOURCE_COMMIT,
      preparationHeadCommit: "TO_BE_REPLACED_AFTER_PREPARATION_COMMIT",
      artifactDigest:
        "TO_BE_REPLACED_AFTER_CREATE_ONLY_GENERATION",
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedNetworkCalls: 0,
      observedModelWireCalls: 0,
      preparationVerification: {
        compiledRuntimeBindingDeferred: true,
      },
    });
  });
});
