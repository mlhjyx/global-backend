import type { Prisma } from "@prisma/client";
import type { QualityArtifactKind } from "@global/contracts";
import { releaseSpecDigest } from "./release-artifact";

export const BUILD_STEP_ARTIFACT_REFS_SCHEMA_VERSION =
  "site-builder-step-artifact-refs/v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const MAX_ARTIFACTS = 128;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const KINDS = new Set<QualityArtifactKind>([
  "screenshot",
  "axe_report",
  "lighthouse_report",
  "seo_report",
  "deterministic_evaluation",
  "aesthetic_request",
  "aesthetic_response",
  "design_evaluation",
]);

export interface BuildStepArtifactRefV1 {
  artifactId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: "image/png" | "application/json";
  kind: QualityArtifactKind;
}

export interface BuildStepArtifactRefsV1 {
  schemaVersion: typeof BUILD_STEP_ARTIFACT_REFS_SCHEMA_VERSION;
  collectionDigest: string;
  artifacts: BuildStepArtifactRefV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function privateObjectKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    value === value.trim() &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  );
}

function artifact(value: unknown): value is BuildStepArtifactRefV1 {
  if (!isRecord(value)) return false;
  return (
    onlyKeys(value, [
      "artifactId",
      "objectKey",
      "sha256",
      "sizeBytes",
      "mimeType",
      "kind",
    ]) &&
    typeof value.artifactId === "string" &&
    TOKEN.test(value.artifactId) &&
    privateObjectKey(value.objectKey) &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) &&
    (value.sizeBytes as number) >= 1 &&
    (value.sizeBytes as number) <= MAX_ARTIFACT_BYTES &&
    (value.mimeType === "image/png" || value.mimeType === "application/json") &&
    typeof value.kind === "string" &&
    KINDS.has(value.kind as QualityArtifactKind) &&
    (value.kind === "screenshot"
      ? value.mimeType === "image/png" &&
        (value.sizeBytes as number) <= 2 * 1024 * 1024
      : value.mimeType === "application/json")
  );
}

export function buildStepArtifactRefsDigest(
  artifacts: readonly BuildStepArtifactRefV1[],
): string {
  return releaseSpecDigest({
    schemaVersion: BUILD_STEP_ARTIFACT_REFS_SCHEMA_VERSION,
    artifacts: [...artifacts].sort((left, right) =>
      `${left.artifactId}\u0000${left.objectKey}`.localeCompare(
        `${right.artifactId}\u0000${right.objectKey}`,
      ),
    ),
  });
}

export function validateBuildStepArtifactRefs(
  value: unknown,
): BuildStepArtifactRefsV1 {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["schemaVersion", "collectionDigest", "artifacts"]) ||
    value.schemaVersion !== BUILD_STEP_ARTIFACT_REFS_SCHEMA_VERSION ||
    typeof value.collectionDigest !== "string" ||
    !SHA256.test(value.collectionDigest) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > MAX_ARTIFACTS ||
    !value.artifacts.every(artifact)
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID");
  }
  const artifacts = value.artifacts as BuildStepArtifactRefV1[];
  const ids = new Set(artifacts.map((entry) => entry.artifactId));
  const keys = new Set(artifacts.map((entry) => entry.objectKey));
  const totalBytes = artifacts.reduce(
    (total, entry) => total + entry.sizeBytes,
    0,
  );
  if (
    ids.size !== artifacts.length ||
    keys.size !== artifacts.length ||
    totalBytes > MAX_TOTAL_BYTES ||
    value.collectionDigest !== buildStepArtifactRefsDigest(artifacts)
  ) {
    throw new Error("QUALITY_ARTIFACT_INVALID");
  }
  return value as unknown as BuildStepArtifactRefsV1;
}

export function buildStepArtifactRefsJson(
  value: BuildStepArtifactRefsV1,
): Prisma.InputJsonObject {
  return validateBuildStepArtifactRefs(
    value,
  ) as unknown as Prisma.InputJsonObject;
}
