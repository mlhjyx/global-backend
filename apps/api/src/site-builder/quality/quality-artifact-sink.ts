import { Injectable } from "@nestjs/common";
import type { QualityArtifactRefV1 } from "@global/contracts";
import { validateQualityArtifactSet } from "@global/contracts";
import { StorageService } from "../storage.service";
import {
  MAX_QUALITY_EVIDENCE_BYTES,
  MAX_QUALITY_SCREENSHOT_BYTES,
  sha256Bytes,
  type QualityArtifactDraft,
  type QualityArtifactSink,
  type DeterministicQualityResult,
} from "./deterministic-quality";

const MAX_CHECKPOINT_BYTES = 1024 * 1024;

interface DeterministicQualityCheckpoint {
  schemaVersion: "site-builder-deterministic-quality-checkpoint/v1";
  candidateSpecDigest: string;
  designBriefDigest: string;
  basePath: string;
  siteOrigin: string;
  round: 0 | 1 | 2 | 3;
  result: DeterministicQualityResult;
}

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
    if (
      !validPrefix(prefix) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifact.artifactId)
    ) {
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
    const sha256 = sha256Bytes(artifact.bytes);
    const extension = artifact.mimeType === "image/png" ? "png" : "json";
    // Content-addressing makes an Activity retry after ACK loss idempotent even
    // when Chrome emits byte-different but semantically equivalent evidence.
    const objectKey = `${prefix}/${artifact.artifactId}-${sha256}.${extension}`;
    const result = await this.storage.putBufferImmutable(
      objectKey,
      artifact.bytes,
      artifact.mimeType,
      sha256,
      signal,
    );
    if (result === "exists") {
      const existing = await this.storage.hashObject(objectKey, signal);
      if (
        existing.sha256 !== sha256 ||
        existing.size !== artifact.bytes.length
      ) {
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

  private checkpointKey(prefix: string): string {
    if (!validPrefix(prefix)) {
      throw new Error("QUALITY_ARTIFACT_INVALID: checkpoint prefix");
    }
    return `${prefix}/deterministic-result.json`;
  }

  async loadCheckpoint(
    prefix: string,
    identity: Pick<
      DeterministicQualityCheckpoint,
      | "candidateSpecDigest"
      | "designBriefDigest"
      | "round"
      | "basePath"
      | "siteOrigin"
    >,
    signal?: AbortSignal,
  ): Promise<DeterministicQualityResult | null> {
    const key = this.checkpointKey(prefix);
    if (!(await this.storage.head(key, signal))) return null;
    const bytes = await this.storage.getBufferBounded(
      key,
      MAX_CHECKPOINT_BYTES,
      signal,
    );
    let parsed: DeterministicQualityCheckpoint;
    try {
      parsed = JSON.parse(
        bytes.toString("utf8"),
      ) as DeterministicQualityCheckpoint;
    } catch {
      throw new Error("QUALITY_ARTIFACT_INVALID: checkpoint json");
    }
    if (
      parsed?.schemaVersion !==
        "site-builder-deterministic-quality-checkpoint/v1" ||
      Object.keys(parsed).sort().join(",") !==
        "basePath,candidateSpecDigest,designBriefDigest,result,round,schemaVersion,siteOrigin" ||
      parsed.candidateSpecDigest !== identity.candidateSpecDigest ||
      parsed.designBriefDigest !== identity.designBriefDigest ||
      parsed.basePath !== identity.basePath ||
      parsed.siteOrigin !== identity.siteOrigin ||
      parsed.round !== identity.round ||
      !parsed.result ||
      typeof parsed.result !== "object" ||
      Object.keys(parsed.result).sort().join(",") !==
        "artifactSet,findings,hardFailures" ||
      !Array.isArray(parsed.result.hardFailures) ||
      !Array.isArray(parsed.result.findings)
    ) {
      throw new Error("QUALITY_ARTIFACT_INVALID: checkpoint identity");
    }
    parsed.result.artifactSet = validateQualityArtifactSet(
      parsed.result.artifactSet,
    );
    if (
      parsed.result.artifactSet.candidateSpecDigest !==
        identity.candidateSpecDigest ||
      parsed.result.artifactSet.designBriefDigest !==
        identity.designBriefDigest ||
      parsed.result.artifactSet.round !== identity.round ||
      parsed.result.artifactSet.artifacts.some(
        ({ objectKey }) => !objectKey.startsWith(`${prefix}/`),
      )
    ) {
      throw new Error("QUALITY_ARTIFACT_INVALID: checkpoint artifact binding");
    }
    return parsed.result;
  }

  async commitCheckpoint(
    prefix: string,
    checkpoint: Omit<DeterministicQualityCheckpoint, "schemaVersion">,
    signal?: AbortSignal,
  ): Promise<DeterministicQualityResult> {
    const key = this.checkpointKey(prefix);
    const value: DeterministicQualityCheckpoint = {
      schemaVersion: "site-builder-deterministic-quality-checkpoint/v1",
      ...checkpoint,
    };
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.length > MAX_CHECKPOINT_BYTES) {
      throw new Error("QUALITY_ARTIFACT_INVALID: checkpoint size");
    }
    const digest = sha256Bytes(bytes);
    const written = await this.storage.putBufferImmutable(
      key,
      bytes,
      "application/json",
      digest,
      signal,
    );
    if (written === "created") return checkpoint.result;
    const winner = await this.loadCheckpoint(prefix, checkpoint, signal);
    if (!winner) {
      throw new Error("QUALITY_ARTIFACT_INVALID: checkpoint ACK loss");
    }
    return winner;
  }
}
