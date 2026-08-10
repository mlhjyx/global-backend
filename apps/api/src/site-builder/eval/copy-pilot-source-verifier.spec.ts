import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../model-runtime/context-engine";
import { COPY_CAPABILITY_PILOT_PLAN } from "./copy-capability-pilot";
import { COPY_REAL_CAPABILITY_ADMISSION_SOURCE } from "./copy-real-capability-admission";
import {
  assertCopyPilotVerifiedSourceCurrent,
  createCopyPilotVerifiedSource,
  getCopyPilotVerifiedSourceBinding,
  requireCopyPilotVerifiedSourceBinding,
} from "./copy-pilot-source-verifier";

const directories: string[] = [];
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../../");

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "copy-pilot-source-"));
  directories.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "docs", "evidence"), { recursive: true });
  await writeFile(join(root, "src", "runtime.ts"), "export const value = 1;\n");
  const compiledBytes = Buffer.from("export const value = 1;\n");
  await writeFile(join(root, "dist", "runtime.js"), compiledBytes);
  git(root, "init", "-q");
  git(root, "config", "user.email", "copy-pilot@example.test");
  git(root, "config", "user.name", "Copy Pilot Test");
  git(root, "add", "src/runtime.ts");
  git(root, "commit", "-qm", "fixed source");
  const fixedSourceCommit = git(root, "rev-parse", "HEAD");
  const bytes = Buffer.from("export const value = 1;\n");
  const files = [
    {
      role: "runtime",
      path: "src/runtime.ts",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  const manifest = {
    schemaVersion: "site-builder-copy-real-capability-manifest/2026-08-05-v1",
    manifestId: "site-builder-copy-real-capability/test-v3",
    fixedSourceCommit,
    sourceBundleDigest: canonicalDigest(files),
    planDigest: canonicalDigest(COPY_CAPABILITY_PILOT_PLAN),
    dispatchAuthorization: "NOT_AUTHORIZED",
    taskId: "site_builder.copy",
    plannedExecutions: 3,
    maximumWireCalls: 6,
    maximumRepairCallsPerExecution: 1,
    executions: COPY_REAL_CAPABILITY_ADMISSION_SOURCE.executions,
  };
  const compiledArtifacts = [
    {
      path: "dist/runtime.js",
      sha256: createHash("sha256").update(compiledBytes).digest("hex"),
    },
  ];
  const withoutDigest = {
    schemaVersion:
      "site-builder-copy-real-capability-manifest-prep/2026-08-05-v1",
    artifactId: "site-builder-copy-real-capability-manifest-prep/test-v3",
    classification: "FIXED_SOURCE_CREATE_ONLY",
    fixedSourceCommit,
    preparationHeadCommit: fixedSourceCommit,
    createOnly: true,
    dispatchAuthorization: "NOT_AUTHORIZED",
    dispatchCapable: false,
    observedNetworkCalls: 0,
    observedModelWireCalls: 0,
    observedModelCost: { CNY: 0, USD: 0 },
    manifest,
    sourceBundle: {
      schemaVersion:
        "site-builder-copy-real-capability-source-bundle/2026-08-05-v1",
      files,
      digest: canonicalDigest(files),
    },
    compiledRuntimeExpectation: {
      schemaVersion: "compiled-runtime-expectation/2026-08-08-v1",
      buildSourceCommit: fixedSourceCommit,
      sourceBundleDigest: canonicalDigest(files),
      buildCommands: [
        "pnpm --filter @global/db generate",
        "pnpm --filter @global/contracts build",
        "pnpm --filter @global/api build",
      ],
      artifactCount: compiledArtifacts.length,
      artifacts: compiledArtifacts,
      artifactTreeDigest: canonicalDigest(compiledArtifacts),
    },
  };
  const artifact = {
    ...withoutDigest,
    artifactDigest: canonicalDigest(withoutDigest),
  };
  const manifestPath = join(root, "docs", "evidence", "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(artifact)}\n`);
  git(root, "add", "docs/evidence/manifest.json");
  git(root, "commit", "-qm", "manifest");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, manifestPath, fixedSourceCommit, manifest, artifact };
}

describe("Copy pilot fixed-source verifier", () => {
  it("recomputes tracked bytes and returns only an opaque source binding", async () => {
    const fixture = await repository();
    const verified = await createCopyPilotVerifiedSource({
      repositoryRoot: fixture.root,
      manifestArtifactPath: fixture.manifestPath,
    });

    expect(Object.keys(verified)).toEqual([]);
    expect(getCopyPilotVerifiedSourceBinding(verified)).toMatchObject({
      fixedSourceCommit: fixture.fixedSourceCommit,
      sourceBundleDigest: fixture.manifest.sourceBundleDigest,
      manifestDigest: canonicalDigest(fixture.manifest),
      repositoryRoot: fixture.root,
      preparationHeadCommit: fixture.fixedSourceCommit,
      compiledRuntimeExpectation: {
        artifactTreeDigest:
          fixture.artifact.compiledRuntimeExpectation.artifactTreeDigest,
      },
    });
  });

  it("requires a branded source handle and revalidates its current bytes", async () => {
    const fixture = await repository();
    const verified = await createCopyPilotVerifiedSource({
      repositoryRoot: fixture.root,
      manifestArtifactPath: fixture.manifestPath,
    });

    expect(() => requireCopyPilotVerifiedSourceBinding({} as never)).toThrow(
      "COPY_PILOT_VERIFIED_SOURCE_REQUIRED",
    );
    await expect(
      assertCopyPilotVerifiedSourceCurrent(verified),
    ).resolves.toBeUndefined();

    await writeFile(join(fixture.root, "dist", "runtime.js"), "drift\n");
    await expect(
      assertCopyPilotVerifiedSourceCurrent(verified),
    ).rejects.toThrow("COPY_PILOT_COMPILED_RUNTIME_MISMATCH");
  });

  it("rejects working-tree drift and an untracked manifest", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.root, "src", "runtime.ts"), "drift\n");
    await expect(
      createCopyPilotVerifiedSource({
        repositoryRoot: fixture.root,
        manifestArtifactPath: fixture.manifestPath,
      }),
    ).rejects.toThrow("COPY_PILOT_SOURCE_BYTES_MISMATCH");

    const untracked = join(fixture.root, "docs", "evidence", "copy.json");
    await writeFile(untracked, await readFile(fixture.manifestPath));
    await expect(
      createCopyPilotVerifiedSource({
        repositoryRoot: fixture.root,
        manifestArtifactPath: untracked,
      }),
    ).rejects.toThrow("COPY_PILOT_MANIFEST_NOT_TRACKED");
  });

  it("rejects an intermediate source-directory symlink even when bytes match", async () => {
    const fixture = await repository();
    const originalDirectory = join(fixture.root, "src");
    const relocatedDirectory = join(fixture.root, "src-relocated");
    await rename(originalDirectory, relocatedDirectory);
    await symlink(relocatedDirectory, originalDirectory, "dir");

    await expect(
      createCopyPilotVerifiedSource({
        repositoryRoot: fixture.root,
        manifestArtifactPath: fixture.manifestPath,
      }),
    ).rejects.toThrow("COPY_PILOT_SOURCE_FILE_INVALID");
  });

  it("rejects stale compiled bytes and unreachable preparation provenance", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.root, "dist", "runtime.js"), "stale\n");
    await expect(
      createCopyPilotVerifiedSource({
        repositoryRoot: fixture.root,
        manifestArtifactPath: fixture.manifestPath,
      }),
    ).rejects.toThrow("COPY_PILOT_COMPILED_RUNTIME_MISMATCH");

    await writeFile(
      join(fixture.root, "dist", "runtime.js"),
      "export const value = 1;\n",
    );
    const { artifactDigest: _artifactDigest, ...artifactWithoutDigest } =
      fixture.artifact;
    const unreachableWithoutDigest = {
      ...artifactWithoutDigest,
      preparationHeadCommit: "f".repeat(40),
    };
    const unreachableArtifact = {
      ...unreachableWithoutDigest,
      artifactDigest: canonicalDigest(unreachableWithoutDigest),
    };
    await writeFile(
      fixture.manifestPath,
      `${JSON.stringify(unreachableArtifact)}\n`,
    );
    git(fixture.root, "add", "docs/evidence/manifest.json");
    git(fixture.root, "commit", "-qm", "unreachable preparation");
    git(fixture.root, "update-ref", "refs/remotes/origin/main", "HEAD");

    await expect(
      createCopyPilotVerifiedSource({
        repositoryRoot: fixture.root,
        manifestArtifactPath: fixture.manifestPath,
      }),
    ).rejects.toThrow("COPY_PILOT_PREPARATION_SOURCE_UNREACHABLE");
  });

  for (const version of ["v13", "v14"] as const) {
    it(`rejects the frozen ${version} recovery binding as the live v15 source`, async () => {
      await expect(
        createCopyPilotVerifiedSource({
          repositoryRoot: REPOSITORY_ROOT,
          manifestArtifactPath: resolve(
            REPOSITORY_ROOT,
            `docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-${version}.json`,
          ),
        }),
      ).rejects.toThrow("COPY_PILOT_MANIFEST_INVALID");
    });
  }
});
