import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  materializeQualityCandidateArtifact,
  persistQualityCandidateArtifact,
  type QualityCandidateArtifactStorage,
} from "./quality-candidate-artifact";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function memoryStorage(): QualityCandidateArtifactStorage & {
  objects: Map<string, Buffer>;
} {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putBufferImmutable: vi.fn(async (key, bytes) => {
      if (objects.has(key)) return "exists" as const;
      objects.set(key, Buffer.from(bytes));
      return "created" as const;
    }),
    getBufferBounded: vi.fn(async (key, maxBytes) => {
      const bytes = objects.get(key);
      if (!bytes || bytes.length > maxBytes) throw new Error("missing object");
      return Buffer.from(bytes);
    }),
    hashObject: vi.fn(async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing object");
      return {
        sha256: await import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(bytes).digest("hex"),
        ),
        head: bytes.subarray(0, 16),
        size: bytes.length,
      };
    }),
  };
}

describe("quality candidate artifact", () => {
  it("persists immutable files and materializes them under a different scratch root", async () => {
    const source = await temporaryRoot("candidate-source-");
    await mkdir(path.join(source, "assets"), { recursive: true });
    await writeFile(path.join(source, "index.html"), "<h1>candidate</h1>");
    await writeFile(path.join(source, "assets", "app.css"), "body{color:#123}");
    const storage = memoryStorage();

    const reference = await persistQualityCandidateArtifact({
      root: source,
      objectPrefix: "sites/site-1/quality-candidates/run-1/tree-abc",
      rendererOutputDigest: "a".repeat(64),
      storage,
    });
    await rm(source, { recursive: true, force: true });

    const scratchParent = await temporaryRoot("candidate-target-parent-");
    const materialized = await materializeQualityCandidateArtifact({
      reference,
      scratchParent,
      storage,
    });

    expect(materialized.root.startsWith(`${scratchParent}${path.sep}`)).toBe(true);
    await expect(readFile(path.join(materialized.root, "index.html"), "utf8")).resolves.toBe(
      "<h1>candidate</h1>",
    );
    await expect(
      readFile(path.join(materialized.root, "assets", "app.css"), "utf8"),
    ).resolves.toBe("body{color:#123}");
    await materialized.cleanup();
    await expect(readFile(path.join(materialized.root, "index.html"))).rejects.toThrow();
  });

  it("rejects a manifest whose digest does not match the Temporal reference", async () => {
    const source = await temporaryRoot("candidate-source-");
    await writeFile(path.join(source, "index.html"), "candidate");
    const storage = memoryStorage();
    const reference = await persistQualityCandidateArtifact({
      root: source,
      objectPrefix: "sites/site-1/quality-candidates/run-1/tree-abc",
      rendererOutputDigest: "b".repeat(64),
      storage,
    });
    const scratchParent = await temporaryRoot("candidate-target-parent-");

    await expect(
      materializeQualityCandidateArtifact({
        reference: { ...reference, manifestSha256: "0".repeat(64) },
        scratchParent,
        storage,
      }),
    ).rejects.toThrow("QUALITY_CANDIDATE_ARTIFACT_INVALID");
  });

  it("rejects traversal and a file whose bytes do not match its immutable manifest", async () => {
    const source = await temporaryRoot("candidate-source-");
    await writeFile(path.join(source, "index.html"), "candidate");
    const storage = memoryStorage();
    const reference = await persistQualityCandidateArtifact({
      root: source,
      objectPrefix: "sites/site-1/quality-candidates/run-1/tree-abc",
      rendererOutputDigest: "c".repeat(64),
      storage,
    });
    const manifest = JSON.parse(
      storage.objects.get(reference.manifestKey)!.toString("utf8"),
    ) as { files: Array<{ objectKey: string }> };
    storage.objects.set(manifest.files[0]!.objectKey, Buffer.from("tampered"));
    const scratchParent = await temporaryRoot("candidate-target-parent-");

    await expect(
      materializeQualityCandidateArtifact({ reference, scratchParent, storage }),
    ).rejects.toThrow("QUALITY_CANDIDATE_ARTIFACT_INVALID");
  });

  it("refuses symlinks and unsafe object prefixes", async () => {
    const source = await temporaryRoot("candidate-source-");
    await writeFile(path.join(source, "index.html"), "candidate");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(path.join(source, "index.html"), path.join(source, "escape")),
    );
    const storage = memoryStorage();

    await expect(
      persistQualityCandidateArtifact({
        root: source,
        objectPrefix: "../escape",
        rendererOutputDigest: "d".repeat(64),
        storage,
      }),
    ).rejects.toThrow("QUALITY_CANDIDATE_ARTIFACT_INVALID");
  });
});
