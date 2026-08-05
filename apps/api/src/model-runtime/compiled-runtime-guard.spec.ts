import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "./context-engine";
import {
  assertCompiledRuntimeGuardCurrent,
  createCompiledRuntimeGuard,
  getCompiledRuntimeGuardAttestation,
} from "./compiled-runtime-guard";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "compiled-runtime-guard-"));
  directories.push(root);
  await writeFile(join(root, "runtime.js"), "export const runtime = 1;\n");
  await writeFile(join(root, "contracts.js"), "export const contract = 1;\n");
  return root;
}

describe("CompiledRuntimeGuard", () => {
  it("brands an exact artifact tree and revalidates the bytes", async () => {
    const root = await fixture();
    const binding = {
      fixedSourceCommit: "a".repeat(40),
      manifestDigest: "b".repeat(64),
      sourceBundleDigest: "c".repeat(64),
      planDigest: "d".repeat(64),
    };
    const guard = await createCompiledRuntimeGuard({
      repositoryRoot: root,
      artifactPaths: ["contracts.js", "runtime.js"],
      binding,
    });

    await expect(
      assertCompiledRuntimeGuardCurrent(guard),
    ).resolves.toBeUndefined();
    expect(getCompiledRuntimeGuardAttestation(guard)).toMatchObject({
      bindingDigest: canonicalDigest(binding),
      artifactCount: 2,
    });
    expect(
      getCompiledRuntimeGuardAttestation(guard)?.artifactTreeDigest,
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a clone and detects post-admission byte replacement", async () => {
    const root = await fixture();
    const guard = await createCompiledRuntimeGuard({
      repositoryRoot: root,
      artifactPaths: ["runtime.js"],
      binding: { source: "copy" },
    });

    await expect(
      assertCompiledRuntimeGuardCurrent({ ...guard }),
    ).rejects.toThrow("COMPILED_RUNTIME_GUARD_UNTRUSTED");
    await writeFile(join(root, "runtime.js"), "export const runtime = 2;\n");
    await expect(assertCompiledRuntimeGuardCurrent(guard)).rejects.toThrow(
      "COMPILED_RUNTIME_DRIFT",
    );
  });

  it("rejects path traversal, duplicate paths, and symlink artifacts", async () => {
    const root = await fixture();
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: root,
        artifactPaths: ["../outside.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ARTIFACT_INVALID");
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: root,
        artifactPaths: ["runtime.js", "./runtime.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ARTIFACT_INVALID");
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: root,
        artifactPaths: ["runtime.js", "runtime.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ARTIFACT_INVALID");
    await symlink(join(root, "runtime.js"), join(root, "runtime-link.js"));
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: root,
        artifactPaths: ["runtime-link.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ARTIFACT_INVALID");
  });

  it("rejects missing roots and artifacts, root symlinks, and hard-link aliases", async () => {
    const root = await fixture();
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: join(root, "missing"),
        artifactPaths: ["runtime.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ROOT_INVALID");
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: root,
        artifactPaths: ["missing.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ARTIFACT_INVALID");

    const rootLink = `${root}-link`;
    directories.push(rootLink);
    await symlink(root, rootLink);
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: rootLink,
        artifactPaths: ["runtime.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ROOT_INVALID");

    await link(join(root, "runtime.js"), join(root, "runtime-hardlink.js"));
    await expect(
      createCompiledRuntimeGuard({
        repositoryRoot: root,
        artifactPaths: ["runtime.js", "runtime-hardlink.js"],
        binding: {},
      }),
    ).rejects.toThrow("COMPILED_RUNTIME_ARTIFACT_INVALID");
  });

  it("fails closed when the guarded root disappears", async () => {
    const root = await fixture();
    const guard = await createCompiledRuntimeGuard({
      repositoryRoot: root,
      artifactPaths: ["runtime.js"],
      binding: { source: "copy" },
    });
    await rm(root, { recursive: true, force: true });

    await expect(assertCompiledRuntimeGuardCurrent(guard)).rejects.toThrow(
      "COMPILED_RUNTIME_DRIFT",
    );
  });
});
