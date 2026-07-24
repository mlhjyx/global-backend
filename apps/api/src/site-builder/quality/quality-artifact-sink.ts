import { Injectable } from "@nestjs/common";
import type { QualityArtifactRefV1 } from "@global/contracts";
import { StorageService } from "../storage.service";
import {
  MAX_QUALITY_EVIDENCE_BYTES,
  MAX_QUALITY_SCREENSHOT_BYTES,
  sha256Bytes,
  type QualityArtifactDraft,
  type QualityArtifactSink,
} from "./deterministic-quality";

function validPrefix(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 384 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  );
}

@Injectable()
export class StorageQualityArtifactSink implements QualityArtifactSink {
  constructor(private readonly storage: StorageService) {}

  async persist(
    prefix: string,
    artifact: QualityArtifactDraft,
    signal?: AbortSignal,
  ): Promise<QualityArtifactRefV1> {
    if (!validPrefix(prefix) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifact.artifactId)) {
      throw new Error("QUALITY_ARTIFACT_INVALID: object identity");
    }
    if (
      artifact.bytes.length < 1 ||
      artifact.bytes.length > MAX_QUALITY_EVIDENCE_BYTES ||
      (artifact.kind === "screenshot" &&
        artifact.bytes.length > MAX_QUALITY_SCREENSHOT_BYTES)
    ) {
      throw new Error("QUALITY_ARTIFACT_INVALID: object size");
    }
    const extension = artifact.mimeType === "image/png" ? "png" : "json";
    const objectKey = `${prefix}/${artifact.artifactId}.${extension}`;
    const sha256 = sha256Bytes(artifact.bytes);
    const result = await this.storage.putBufferImmutable(
      objectKey,
      artifact.bytes,
      artifact.mimeType,
      sha256,
      signal,
    );
    if (result === "exists") {
      const existing = await this.storage.hashObject(objectKey, signal);
      if (existing.sha256 !== sha256 || existing.size !== artifact.bytes.length) {
        throw new Error("QUALITY_ARTIFACT_INVALID: immutable collision");
      }
    }
    return {
      artifactId: artifact.artifactId,
      objectKey,
      sha256,
      sizeBytes: artifact.bytes.length,
      mimeType: artifact.mimeType,
      kind: artifact.kind,
      ...(artifact.target ? { target: artifact.target } : {}),
    };
  }
}
