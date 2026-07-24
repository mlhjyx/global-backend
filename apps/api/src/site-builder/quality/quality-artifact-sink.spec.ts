import { createHash } from "node:crypto";
import {
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
} from "@global/contracts";
import { describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage.service";
import { StorageQualityArtifactSink } from "./quality-artifact-sink";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("private quality artifact sink", () => {
  it("uses create-only object writes and returns digest-bound metadata", async () => {
    const putBufferImmutable = vi.fn().mockResolvedValue("created");
    const storage = {
      putBufferImmutable,
      hashObject: vi.fn(),
    } as unknown as StorageService;
    const sink = new StorageQualityArtifactSink(storage);
    const ref = await sink.persist(
      "sites/site-1/attempts/token/quality/round-0",
      {
        artifactId: "home-375",
        bytes: PNG,
        mimeType: "image/png",
        kind: "screenshot",
        target: { locale: "en", pageId: "home", breakpoint: 375 },
      },
    );
    const digest = createHash("sha256").update(PNG).digest("hex");
    expect(ref).toEqual({
      artifactId: "home-375",
      objectKey: `sites/site-1/attempts/token/quality/round-0/home-375-${digest}.png`,
      sha256: digest,
      sizeBytes: PNG.length,
      mimeType: "image/png",
      kind: "screenshot",
      target: { locale: "en", pageId: "home", breakpoint: 375 },
    });
    expect(putBufferImmutable).toHaveBeenCalledWith(
      ref.objectKey,
      PNG,
      "image/png",
      digest,
      undefined,
    );
  });

  it("accepts ACK-loss replay only when the existing immutable object matches", async () => {
    const digest = createHash("sha256").update(PNG).digest("hex");
    const storage = {
      putBufferImmutable: vi.fn().mockResolvedValue("exists"),
      hashObject: vi
        .fn()
        .mockResolvedValue({ sha256: digest, size: PNG.length, head: PNG }),
    } as unknown as StorageService;
    const sink = new StorageQualityArtifactSink(storage);
    await expect(
      sink.persist("site/quality/round-0", {
        artifactId: "evidence",
        bytes: PNG,
        mimeType: "image/png",
        kind: "screenshot",
        target: { locale: "en", pageId: "home", breakpoint: 375 },
      }),
    ).resolves.toMatchObject({ sha256: digest });

    (
      storage.hashObject as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      sha256: "f".repeat(64),
      size: PNG.length,
      head: PNG,
    });
    await expect(
      sink.persist("site/quality/round-0", {
        artifactId: "evidence",
        bytes: PNG,
        mimeType: "image/png",
        kind: "screenshot",
        target: { locale: "en", pageId: "home", breakpoint: 375 },
      }),
    ).rejects.toThrow("immutable collision");
  });

  it("rejects path traversal before object storage is called", async () => {
    const putBufferImmutable = vi.fn();
    const sink = new StorageQualityArtifactSink({
      putBufferImmutable,
    } as unknown as StorageService);
    await expect(
      sink.persist("../public", {
        artifactId: "evidence",
        bytes: PNG,
        mimeType: "image/png",
        kind: "screenshot",
      }),
    ).rejects.toThrow("object identity");
    expect(putBufferImmutable).not.toHaveBeenCalled();
  });

  it("commits one immutable result checkpoint and reuses the first writer", async () => {
    const prefix = "site/quality/round-0";
    const identity = {
      candidateSpecDigest: "a".repeat(64),
      designBriefDigest: "b".repeat(64),
      round: 0 as const,
    };
    const artifactDraft = {
      schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
      ...identity,
      expectedTargets: [{ locale: "en", pageId: "home" }],
      artifacts: ([375, 768, 1440] as const).map((breakpoint) => ({
        artifactId: `home-${breakpoint}`,
        objectKey: `${prefix}/home-${breakpoint}.png`,
        sha256: String(breakpoint).padStart(64, "0"),
        sizeBytes: 128,
        mimeType: "image/png" as const,
        kind: "screenshot" as const,
        target: { locale: "en", pageId: "home", breakpoint },
      })),
    };
    const result = {
      artifactSet: {
        ...artifactDraft,
        artifactSetDigest: qualityArtifactSetDigest(artifactDraft),
      },
      hardFailures: [],
      findings: [],
    };
    let stored: Buffer | null = null;
    const storage = {
      head: vi.fn(async () =>
        stored
          ? { size: stored.length, contentType: "application/json" }
          : null,
      ),
      getBufferBounded: vi.fn(async () => stored!),
      putBufferImmutable: vi.fn(async (_key: string, bytes: Buffer) => {
        if (stored) return "exists";
        stored = Buffer.from(bytes);
        return "created";
      }),
    } as unknown as StorageService;
    const sink = new StorageQualityArtifactSink(storage);
    await expect(
      sink.commitCheckpoint(prefix, { ...identity, result }),
    ).resolves.toEqual(result);
    await expect(sink.loadCheckpoint(prefix, identity)).resolves.toEqual(
      result,
    );
    await expect(
      sink.commitCheckpoint(prefix, {
        ...identity,
        result: structuredClone(result),
      }),
    ).resolves.toEqual(result);
  });
});
