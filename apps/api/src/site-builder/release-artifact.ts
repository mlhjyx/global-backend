import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import {
  SITE_SPEC_V1_1_VERSION,
  SITE_SPEC_V1_VERSION,
  SITE_SPEC_RELEASE_COMPONENT_TYPES,
  AESTHETIC_UNAVAILABLE_REASONS,
  assertReleaseComponentEligible,
  canonicalDesignEvaluationV2Json,
  designEvaluationV2Digest,
  hasDesignEvaluationHardFailures,
  validateDesignBriefV2,
  validateBlock,
  validateDesignEvaluationV2,
  validateQualityArtifactSet,
  validateSiteSpec,
  type AestheticUnavailableReason,
  type DesignBriefV2,
  type DesignEvaluationV2,
  type QualityArtifactSetV1,
  type SiteSpec,
} from "@global/contracts";

export const RELEASE_MANIFEST_V1_SCHEMA_VERSION =
  "site-builder-release-manifest/v1" as const;
export const RELEASE_MANIFEST_V2_SCHEMA_VERSION =
  "site-builder-release-manifest/v2" as const;
export const RELEASE_MANIFEST_V3_SCHEMA_VERSION =
  "site-builder-release-manifest/v3" as const;
export const RELEASE_QUALITY_SCHEMA_VERSION =
  "site-builder-release-quality/v1" as const;
export const RELEASE_SCREENSHOT_SET_SCHEMA_VERSION =
  "site-builder-release-screenshot-set/v1" as const;
export const RELEASE_AESTHETIC_EVIDENCE_SCHEMA_VERSION =
  "site-builder-release-aesthetic-evidence/v1" as const;
/** @deprecated Immutable v1 alias retained for existing consumers. */
export const RELEASE_MANIFEST_SCHEMA_VERSION =
  RELEASE_MANIFEST_V1_SCHEMA_VERSION;

/** @deprecated Use the shared release-eligible registry from @global/contracts. */
export const R1_RENDERER_COMPONENT_TYPES = SITE_SPEC_RELEASE_COMPONENT_TYPES;

const MAX_RELEASE_FILES = 4096;
const MAX_RELEASE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RELEASE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RELEASE_DEPTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._+@:/-]{0,127}$/;

export interface ReleaseArtifactFile {
  path: string;
  objectKey: string;
  size: number;
  sha256: string;
  contentType: string;
  data: Buffer;
}

export interface ReleaseManifestFile {
  path: string;
  objectKey: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface ReleaseManifestV1 {
  schemaVersion: typeof RELEASE_MANIFEST_V1_SCHEMA_VERSION;
  releaseId: string;
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  producerToken: string;
  artifactPrefix: string;
  artifactDigest: string;
  specVersion: typeof SITE_SPEC_V1_VERSION;
  specDigest: string;
  buildIdentity: string;
  createdAt: string;
  componentTypes: string[];
  files: ReleaseManifestFile[];
}

export interface ReleaseManifestV2 extends Omit<
  ReleaseManifestV1,
  "schemaVersion" | "specVersion"
> {
  schemaVersion: typeof RELEASE_MANIFEST_V2_SCHEMA_VERSION;
  specVersion: typeof SITE_SPEC_V1_1_VERSION;
  componentLibraryVersion: string;
  rendererVersion: string;
  designBrief: DesignBriefV2;
  designBriefDigest: string;
}

export type ReleaseQualityStatus =
  | "passed"
  | "passed_with_minor_findings"
  | "passed_deterministic_aesthetic_unavailable";

export interface ReleaseQualityObjectRefV1 {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: "application/json";
  kind: "design_evaluation" | "aesthetic_response";
}

export interface ReleaseQualityRoundProvenanceV1 {
  round: 0 | 1 | 2 | 3;
  candidateSpecDigest: string;
  artifactSetDigest: string;
  designEvaluationDigest: string;
  repairCatalogDigest: string | null;
  selectedRepairOptionId: string | null;
  repairSelectionMode: "model" | "deterministic_fallback" | null;
}

export interface ReleaseAestheticProvenanceV1 {
  status: "passed" | "unavailable";
  requestedModel: string;
  reportedModel: string | null;
  resolvedModel: string | null;
  transport: string;
  routePolicyVersion: string;
  errorClassification: AestheticUnavailableReason | null;
  evidenceDigest: string;
  evidenceRef: ReleaseQualityObjectRefV1;
}

export interface ReleaseAestheticEvidenceV1 {
  schemaVersion: typeof RELEASE_AESTHETIC_EVIDENCE_SCHEMA_VERSION;
  status: "passed" | "unavailable";
  requestedModel: string;
  reportedModel: string | null;
  resolvedModel: string | null;
  transport: string;
  routePolicyVersion: string;
  errorClassification: AestheticUnavailableReason | null;
}

export interface ReleaseManifestQualityV3 {
  schemaVersion: typeof RELEASE_QUALITY_SCHEMA_VERSION;
  status: ReleaseQualityStatus;
  deterministicEvaluatorVersion: string;
  finalRound: 0 | 1 | 2 | 3;
  artifactSet: QualityArtifactSetV1;
  screenshotSetDigest: string;
  designEvaluationDigest: string;
  designEvaluationRef: ReleaseQualityObjectRefV1;
  rounds: ReleaseQualityRoundProvenanceV1[];
  aesthetic: ReleaseAestheticProvenanceV1;
}

export interface ReleaseManifestV3 extends Omit<
  ReleaseManifestV2,
  "schemaVersion"
> {
  schemaVersion: typeof RELEASE_MANIFEST_V3_SCHEMA_VERSION;
  quality: ReleaseManifestQualityV3;
}

export type ReleaseManifest =
  ReleaseManifestV1 | ReleaseManifestV2 | ReleaseManifestV3;

export interface PreparedReleaseArtifact {
  files: ReleaseArtifactFile[];
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  manifestDigest: string;
  manifestObjectKey: string;
  artifactDigest: string;
}

export interface ReleaseArtifactStorage {
  putBufferImmutable(
    key: string,
    data: Buffer,
    contentType: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<"created" | "exists">;
  hashObject(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; head: Buffer; size: number }>;
}

export interface BuildReleaseQualityInputV3 {
  manifest: ReleaseManifestQualityV3;
  designEvaluation: DesignEvaluationV2;
  aestheticEvidence: ReleaseAestheticEvidenceV1;
}

export interface BuildReleaseArtifactInput {
  root: string;
  spec: SiteSpec;
  storedSpecVersion: string;
  releaseId: string;
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  producerToken: string;
  artifactPrefix: string;
  releaseCreatedAt: Date;
  buildIdentity: string;
  /** Required for SiteSpec 1.1; forbidden for immutable v1 releases. */
  designBrief?: DesignBriefV2;
  /**
   * Expand/write seam: omitted by the current workflow, so existing writers
   * keep producing v2 until M1-f quality materialization is connected.
   */
  quality?: BuildReleaseQualityInputV3;
}

export function assertReleaseContract(
  spec: SiteSpec,
  storedSpecVersion: string,
): void {
  if (
    ![SITE_SPEC_V1_VERSION, SITE_SPEC_V1_1_VERSION].includes(
      storedSpecVersion as
        typeof SITE_SPEC_V1_VERSION | typeof SITE_SPEC_V1_1_VERSION,
    ) ||
    spec.specVersion !== storedSpecVersion
  ) {
    throw new Error(
      `SITE_RELEASE_UNSUPPORTED_SPEC_VERSION: stored=${storedSpecVersion} embedded=${spec.specVersion}`,
    );
  }
  validateSiteSpec(spec);
  const pageIds = new Set(spec.pages.map((page) => page.id));
  const allowedOutboundDomains = new Set(
    (spec.site.outboundDomains ?? []).map((domain) => domain.toLowerCase()),
  );
  for (const page of spec.pages) {
    for (const block of page.puck.content) {
      validateBlock(block);
      assertReleaseComponentEligible(block.type);
      const props = block.props as Record<string, unknown>;
      const ctaFields =
        block.type === "PricingTable"
          ? ["primaryCta", "secondaryCta"]
          : block.type === "CtaCenter"
            ? ["primaryCta", "secondaryCta"]
            : block.type === "ServicesDark"
              ? ["allCta"]
              : block.type === "ServiceRows"
                ? ["cta"]
                : block.type === "AreaGallery"
                  ? ["allPageId"]
                  : block.type === "ProjectsGrid"
                    ? ["allPageId"]
                    : block.type === "CollectionCards"
                      ? ["allPageId"]
                      : block.type === "MaterialsLibrary"
                        ? ["ctaPrimaryPageId", "ctaSecondaryPageId"]
                        : block.type === "ProductShowcaseAlt"
                          ? ["configureCta", "configurePageId"]
                          : block.type === "EditorialHero"
                            ? ["ctaPageId"]
                            : block.type === "SplitAbout"
                              ? ["ctaPageId"]
                              : block.type === "WarmHero"
                                ? ["primaryCta", "secondaryCta"]
                                : block.type === "DishesShowcase"
                                  ? ["addPageId"]
                                  : block.type === "PhotoGallery"
                                    ? props.allLabelKey
                                      ? ["allPageId"]
                                      : []
                                    : block.type === "MediaCta"
                                      ? ["primaryCta", "secondaryCta"]
                                      : block.type === "FarmhouseHero"
                                        ? ["primaryCta", "secondaryCta"]
                                        : block.type === "FeaturedSpotlight"
                                          ? props.allLabelKey
                                            ? ["allPageId"]
                                            : []
                                          : block.type === "DispatchHero"
                                            ? ["cta1PageId"]
                                            : block.type === "ServicesEditorial"
                                              ? props.bookLabelKey ||
                                                (props.notListKey &&
                                                  props.notListBodyKey &&
                                                  props.notListCtaKey)
                                                ? ["bookPageId"]
                                                : []
                                              : block.type ===
                                                  "DispatchTimeline"
                                                ? ["ctaPageId"]
                                                : block.type === "CrewGrid"
                                                  ? ["requestPageId"]
                                                  : block.type === "HeroFull"
                                                    ? [
                                                        "primaryCta",
                                                        ...(props.secondaryCta
                                                          ? ["secondaryCta"]
                                                          : []),
                                                        ...(props.revealCta
                                                          ? ["revealCta"]
                                                          : []),
                                                      ]
                                                    : block.type ===
                                                        "ColorwayPicker"
                                                      ? props.reserveCta
                                                        ? ["reserveCta"]
                                                        : props.reserveLabelKey
                                                          ? ["reservePageId"]
                                                          : []
                                                      : block.type ===
                                                            "SaaSHero" ||
                                                          block.type ===
                                                            "IndustrialHero" ||
                                                          block.type ===
                                                            "MinimalHero"
                                                        ? props.primaryCta
                                                          ? [
                                                              "primaryCta",
                                                              ...(props.secondaryCta
                                                                ? [
                                                                    "secondaryCta",
                                                                  ]
                                                                : []),
                                                            ]
                                                          : [
                                                              "cta1PageId",
                                                              ...(props.cta2Key
                                                                ? ["cta2PageId"]
                                                                : []),
                                                              ...(props.secondaryCta
                                                                ? [
                                                                    "secondaryCta",
                                                                  ]
                                                                : []),
                                                            ]
                                                        : [];
      for (const field of ctaFields) {
        const value =
          props[field] ??
          (block.type === "MaterialsLibrary" ? "contact" : undefined) ??
          (block.type === "AreaGallery" && props.allLabelKey
            ? "area"
            : undefined) ??
          (block.type === "ProjectsGrid" && props.allLabelKey
            ? "projects"
            : undefined) ??
          (block.type === "CollectionCards" ? "home" : undefined);
        const defaultPageId =
          block.type === "EditorialHero"
            ? "services"
            : block.type === "SplitAbout"
              ? "contact"
              : block.type === "DishesShowcase"
                ? "services"
                : block.type === "PhotoGallery"
                  ? "gallery"
                  : block.type === "FeaturedSpotlight"
                    ? "home"
                    : block.type === "DispatchHero"
                      ? "book"
                      : block.type === "ServicesEditorial"
                        ? "book"
                        : block.type === "DispatchTimeline"
                          ? "book"
                          : block.type === "CrewGrid"
                            ? "book"
                            : block.type === "SaaSHero" ||
                                block.type === "IndustrialHero" ||
                                block.type === "MinimalHero"
                              ? "book"
                              : block.type === "ColorwayPicker"
                                ? "book"
                                : undefined;
        const resolvedValue = value ?? defaultPageId;
        const cta =
          typeof resolvedValue === "string"
            ? { pageId: resolvedValue }
            : (resolvedValue as { pageId?: string; url?: string } | undefined);
        if (cta?.url) {
          const parsed = new URL(cta.url);
          if (
            parsed.protocol !== "https:" ||
            !allowedOutboundDomains.has(parsed.hostname.toLowerCase())
          ) {
            throw new Error(
              `SITE_RELEASE_OUTBOUND_DOMAIN_FORBIDDEN: ${block.type}.${field}`,
            );
          }
        } else if (cta && !pageIds.has(cta.pageId ?? "")) {
          throw new Error(
            `SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: ${block.type}.${field}.pageId=${cta.pageId ?? ""}`,
          );
        }
      }
      if (
        block.type === "MediaCta" &&
        (props.whatsappLabelKey || props.whatsappUrl)
      ) {
        if (
          typeof props.whatsappLabelKey !== "string" ||
          typeof props.whatsappUrl !== "string"
        ) {
          throw new Error(
            "SITE_RELEASE_OUTBOUND_DOMAIN_FORBIDDEN: MediaCta.whatsappUrl",
          );
        }
        const parsed = new URL(props.whatsappUrl);
        if (
          parsed.protocol !== "https:" ||
          !allowedOutboundDomains.has(parsed.hostname.toLowerCase())
        ) {
          throw new Error(
            "SITE_RELEASE_OUTBOUND_DOMAIN_FORBIDDEN: MediaCta.whatsappUrl",
          );
        }
      }
    }
  }
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SITE_RELEASE_NON_JSON_VALUE");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const item = record[key];
        if (item === undefined) throw new Error("SITE_RELEASE_NON_JSON_VALUE");
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  throw new Error("SITE_RELEASE_NON_JSON_VALUE");
}

export function releaseSpecDigest(spec: unknown): string {
  return sha256(canonicalJson(spec));
}

export function releaseManifestDigest(manifest: ReleaseManifest): string {
  return sha256(canonicalJson(manifest));
}

export function releaseArtifactDigest(
  files: readonly ReleaseManifestFile[],
): string {
  return sha256(canonicalJson(files));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && BUILD_IDENTITY.test(value);
}

export function validateReleaseAestheticEvidence(
  value: unknown,
): ReleaseAestheticEvidenceV1 {
  if (
    !record(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "status",
      "requestedModel",
      "reportedModel",
      "resolvedModel",
      "transport",
      "routePolicyVersion",
      "errorClassification",
    ]) ||
    value.schemaVersion !== RELEASE_AESTHETIC_EVIDENCE_SCHEMA_VERSION ||
    !boundedIdentity(value.requestedModel) ||
    !boundedIdentity(value.transport) ||
    !boundedIdentity(value.routePolicyVersion) ||
    (value.reportedModel !== null && !boundedIdentity(value.reportedModel)) ||
    (value.resolvedModel !== null && !boundedIdentity(value.resolvedModel))
  ) {
    throw new Error("SITE_RELEASE_AESTHETIC_EVIDENCE_INVALID");
  }
  const passed =
    value.status === "passed" &&
    value.reportedModel === value.requestedModel &&
    value.resolvedModel === value.requestedModel &&
    value.errorClassification === null;
  const unavailable =
    value.status === "unavailable" &&
    AESTHETIC_UNAVAILABLE_REASONS.includes(
      value.errorClassification as AestheticUnavailableReason,
    );
  if (!passed && !unavailable) {
    throw new Error("SITE_RELEASE_AESTHETIC_EVIDENCE_INVALID");
  }
  return value as unknown as ReleaseAestheticEvidenceV1;
}

/** Exact UTF-8 bytes that must be persisted at the aesthetic evidence ref. */
export function releaseAestheticEvidenceBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(validateReleaseAestheticEvidence(value)));
}

export function releaseAestheticEvidenceDigest(value: unknown): string {
  return sha256(releaseAestheticEvidenceBytes(value));
}

function round(value: unknown): value is 0 | 1 | 2 | 3 {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function releaseQualityObjectRef(
  value: unknown,
  artifactPrefix: string,
  producerToken: string,
  kind: ReleaseQualityObjectRefV1["kind"],
): value is ReleaseQualityObjectRefV1 {
  if (!record(value)) return false;
  const expectedPrefix = `${artifactPrefix}/attempts/${producerToken}/quality/`;
  return (
    exactKeys(value, [
      "objectKey",
      "sha256",
      "sizeBytes",
      "mimeType",
      "kind",
    ]) &&
    typeof value.objectKey === "string" &&
    value.objectKey.length <= 512 &&
    value.objectKey === value.objectKey.trim() &&
    value.objectKey.startsWith(expectedPrefix) &&
    !value.objectKey.includes("\\") &&
    !value.objectKey.split("/").includes("..") &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) &&
    (value.sizeBytes as number) >= 1 &&
    (value.sizeBytes as number) <= MAX_RELEASE_TOTAL_BYTES &&
    value.mimeType === "application/json" &&
    value.kind === kind
  );
}

export function releaseScreenshotSetDigest(
  artifactSet: QualityArtifactSetV1,
): string {
  const validated = validateQualityArtifactSet(artifactSet);
  const screenshots = validated.artifacts
    .filter((artifact) => artifact.kind === "screenshot")
    .map((artifact) => ({
      artifactId: artifact.artifactId,
      objectKey: artifact.objectKey,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      target: artifact.target,
    }))
    .sort((left, right) => {
      const leftKey = `${left.target!.locale}\u0000${left.target!.pageId}\u0000${left.target!.breakpoint}`;
      const rightKey = `${right.target!.locale}\u0000${right.target!.pageId}\u0000${right.target!.breakpoint}`;
      return leftKey.localeCompare(rightKey);
    });
  return releaseSpecDigest({
    schemaVersion: RELEASE_SCREENSHOT_SET_SCHEMA_VERSION,
    screenshots,
  });
}

export function validateReleaseManifestQuality(
  value: unknown,
  context: {
    artifactPrefix: string;
    producerToken: string;
    specDigest: string;
    designBriefDigest: string;
  },
): ReleaseManifestQualityV3 {
  if (
    !record(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "status",
      "deterministicEvaluatorVersion",
      "finalRound",
      "artifactSet",
      "screenshotSetDigest",
      "designEvaluationDigest",
      "designEvaluationRef",
      "rounds",
      "aesthetic",
    ]) ||
    value.schemaVersion !== RELEASE_QUALITY_SCHEMA_VERSION ||
    ![
      "passed",
      "passed_with_minor_findings",
      "passed_deterministic_aesthetic_unavailable",
    ].includes(String(value.status)) ||
    !boundedIdentity(value.deterministicEvaluatorVersion) ||
    !round(value.finalRound) ||
    typeof value.screenshotSetDigest !== "string" ||
    !SHA256.test(value.screenshotSetDigest) ||
    typeof value.designEvaluationDigest !== "string" ||
    !SHA256.test(value.designEvaluationDigest) ||
    !releaseQualityObjectRef(
      value.designEvaluationRef,
      context.artifactPrefix,
      context.producerToken,
      "design_evaluation",
    ) ||
    !Array.isArray(value.rounds) ||
    !record(value.aesthetic)
  ) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }

  let artifactSet: QualityArtifactSetV1;
  try {
    artifactSet = validateQualityArtifactSet(value.artifactSet);
  } catch {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }
  const qualityPrefix = `${context.artifactPrefix}/attempts/${context.producerToken}/quality/`;
  if (
    artifactSet.candidateSpecDigest !== context.specDigest ||
    artifactSet.designBriefDigest !== context.designBriefDigest ||
    artifactSet.round !== value.finalRound ||
    artifactSet.artifacts.some(
      (artifact) =>
        artifact.kind === "design_evaluation" ||
        !artifact.objectKey.startsWith(
          `${qualityPrefix}round-${value.finalRound}/`,
        ),
    ) ||
    !(
      value.designEvaluationRef as ReleaseQualityObjectRefV1
    ).objectKey.startsWith(`${qualityPrefix}round-${value.finalRound}/`) ||
    value.screenshotSetDigest !== releaseScreenshotSetDigest(artifactSet) ||
    value.designEvaluationDigest !== value.designEvaluationRef.sha256
  ) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }

  const rounds = value.rounds as unknown[];
  if (rounds.length !== (value.finalRound as number) + 1) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }
  for (let index = 0; index < rounds.length; index += 1) {
    const entry = rounds[index];
    if (
      !record(entry) ||
      !exactKeys(entry, [
        "round",
        "candidateSpecDigest",
        "artifactSetDigest",
        "designEvaluationDigest",
        "repairCatalogDigest",
        "selectedRepairOptionId",
        "repairSelectionMode",
      ]) ||
      entry.round !== index ||
      typeof entry.candidateSpecDigest !== "string" ||
      !SHA256.test(entry.candidateSpecDigest) ||
      typeof entry.artifactSetDigest !== "string" ||
      !SHA256.test(entry.artifactSetDigest) ||
      typeof entry.designEvaluationDigest !== "string" ||
      !SHA256.test(entry.designEvaluationDigest)
    ) {
      throw new Error("SITE_RELEASE_QUALITY_INVALID");
    }
    const final = index === value.finalRound;
    if (
      (final &&
        (entry.repairCatalogDigest !== null ||
          entry.selectedRepairOptionId !== null ||
          entry.repairSelectionMode !== null)) ||
      (!final &&
        (typeof entry.repairCatalogDigest !== "string" ||
          !SHA256.test(entry.repairCatalogDigest) ||
          !boundedIdentity(entry.selectedRepairOptionId) ||
          !["model", "deterministic_fallback"].includes(
            String(entry.repairSelectionMode),
          )))
    ) {
      throw new Error("SITE_RELEASE_QUALITY_INVALID");
    }
  }
  const qualityObjectKeys = new Set(
    artifactSet.artifacts.map((artifact) => artifact.objectKey),
  );
  const totalQualityBytes =
    artifactSet.artifacts.reduce(
      (total, artifact) => total + artifact.sizeBytes,
      0,
    ) + (value.designEvaluationRef as ReleaseQualityObjectRefV1).sizeBytes;
  if (
    qualityObjectKeys.has(
      (value.designEvaluationRef as ReleaseQualityObjectRefV1).objectKey,
    ) ||
    totalQualityBytes > MAX_RELEASE_TOTAL_BYTES
  ) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }
  const finalRound = rounds.at(-1) as Record<string, unknown>;
  if (
    finalRound.candidateSpecDigest !== context.specDigest ||
    finalRound.artifactSetDigest !== artifactSet.artifactSetDigest ||
    finalRound.designEvaluationDigest !== value.designEvaluationDigest
  ) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }

  const aesthetic = value.aesthetic;
  if (
    !exactKeys(aesthetic, [
      "status",
      "requestedModel",
      "reportedModel",
      "resolvedModel",
      "transport",
      "routePolicyVersion",
      "errorClassification",
      "evidenceDigest",
      "evidenceRef",
    ]) ||
    !boundedIdentity(aesthetic.requestedModel) ||
    !boundedIdentity(aesthetic.transport) ||
    !boundedIdentity(aesthetic.routePolicyVersion) ||
    (aesthetic.reportedModel !== null &&
      !boundedIdentity(aesthetic.reportedModel)) ||
    (aesthetic.resolvedModel !== null &&
      !boundedIdentity(aesthetic.resolvedModel)) ||
    typeof aesthetic.evidenceDigest !== "string" ||
    !SHA256.test(aesthetic.evidenceDigest) ||
    !releaseQualityObjectRef(
      aesthetic.evidenceRef,
      context.artifactPrefix,
      context.producerToken,
      "aesthetic_response",
    ) ||
    aesthetic.evidenceDigest !==
      (aesthetic.evidenceRef as ReleaseQualityObjectRefV1).sha256 ||
    !(aesthetic.evidenceRef as ReleaseQualityObjectRefV1).objectKey.startsWith(
      `${qualityPrefix}round-${value.finalRound}/`,
    )
  ) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }
  const aestheticEvidenceRef =
    aesthetic.evidenceRef as ReleaseQualityObjectRefV1;
  const aestheticEvidenceArtifact = artifactSet.artifacts.find(
    (artifact) =>
      artifact.kind === "aesthetic_response" &&
      artifact.objectKey === aestheticEvidenceRef.objectKey,
  );
  if (
    !aestheticEvidenceArtifact ||
    aestheticEvidenceArtifact.target !== undefined ||
    aestheticEvidenceArtifact.sha256 !== aestheticEvidenceRef.sha256 ||
    aestheticEvidenceArtifact.sizeBytes !== aestheticEvidenceRef.sizeBytes ||
    aestheticEvidenceArtifact.mimeType !== aestheticEvidenceRef.mimeType
  ) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }
  const passedAesthetic =
    aesthetic.status === "passed" &&
    aesthetic.reportedModel === aesthetic.requestedModel &&
    aesthetic.resolvedModel === aesthetic.requestedModel &&
    aesthetic.errorClassification === null &&
    value.status !== "passed_deterministic_aesthetic_unavailable";
  const unavailableAesthetic =
    aesthetic.status === "unavailable" &&
    AESTHETIC_UNAVAILABLE_REASONS.includes(
      aesthetic.errorClassification as AestheticUnavailableReason,
    ) &&
    value.status === "passed_deterministic_aesthetic_unavailable";
  if (!passedAesthetic && !unavailableAesthetic) {
    throw new Error("SITE_RELEASE_QUALITY_INVALID");
  }

  return value as unknown as ReleaseManifestQualityV3;
}

function releaseManifestCommonValid(value: Record<string, unknown>): boolean {
  const required = [
    "schemaVersion",
    "releaseId",
    "workspaceId",
    "siteId",
    "siteVersionId",
    "buildRunId",
    "producerToken",
    "artifactPrefix",
    "artifactDigest",
    "specVersion",
    "specDigest",
    "buildIdentity",
    "createdAt",
    "componentTypes",
    "files",
  ];
  const shapeValid =
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Array.isArray(value.files) &&
    Array.isArray(value.componentTypes) &&
    [
      value.releaseId,
      value.workspaceId,
      value.siteId,
      value.siteVersionId,
      value.buildRunId,
      value.producerToken,
    ].every(
      (identity) => typeof identity === "string" && UUID.test(identity),
    ) &&
    typeof value.artifactPrefix === "string" &&
    typeof value.artifactDigest === "string" &&
    SHA256.test(value.artifactDigest) &&
    typeof value.specDigest === "string" &&
    SHA256.test(value.specDigest) &&
    typeof value.buildIdentity === "string" &&
    BUILD_IDENTITY.test(value.buildIdentity) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    value.componentTypes.every(
      (type) => typeof type === "string" && type.length > 0,
    ) &&
    value.files.every((file) => {
      if (!file || typeof file !== "object" || Array.isArray(file))
        return false;
      const entry = file as Record<string, unknown>;
      return (
        Object.keys(entry).length === 5 &&
        Object.keys(entry).every((key) =>
          ["path", "objectKey", "size", "sha256", "contentType"].includes(key),
        ) &&
        typeof entry.path === "string" &&
        entry.path.length > 0 &&
        !entry.path.startsWith("/") &&
        !entry.path.split("/").includes("..") &&
        typeof entry.objectKey === "string" &&
        Number.isSafeInteger(entry.size) &&
        (entry.size as number) >= 0 &&
        typeof entry.sha256 === "string" &&
        SHA256.test(entry.sha256) &&
        typeof entry.contentType === "string" &&
        entry.contentType.length > 0
      );
    });
  if (!shapeValid) return false;
  const files = value.files as ReleaseManifestFile[];
  const componentTypes = value.componentTypes as string[];
  return (
    value.artifactPrefix ===
      `sites/${value.siteId}/releases/${value.releaseId}` &&
    value.artifactDigest === releaseArtifactDigest(files) &&
    new Set(componentTypes).size === componentTypes.length &&
    new Set(files.map((file) => file.path)).size === files.length &&
    new Set(files.map((file) => file.objectKey)).size === files.length &&
    files.every(
      (file) =>
        file.objectKey ===
        `${value.artifactPrefix}/attempts/${value.producerToken}/files/${file.path}`,
    )
  );
}

/** Closed-shape parser used by preview and replay surfaces. */
export function validateReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SITE_RELEASE_MANIFEST_INVALID");
  }
  const manifest = value as Record<string, unknown>;
  if (!releaseManifestCommonValid(manifest)) {
    throw new Error("SITE_RELEASE_MANIFEST_INVALID");
  }
  const commonKeys = [
    "schemaVersion",
    "releaseId",
    "workspaceId",
    "siteId",
    "siteVersionId",
    "buildRunId",
    "producerToken",
    "artifactPrefix",
    "artifactDigest",
    "specVersion",
    "specDigest",
    "buildIdentity",
    "createdAt",
    "componentTypes",
    "files",
  ];
  if (manifest.schemaVersion === RELEASE_MANIFEST_V1_SCHEMA_VERSION) {
    if (
      manifest.specVersion !== SITE_SPEC_V1_VERSION ||
      Object.keys(manifest).some((key) => !commonKeys.includes(key))
    ) {
      throw new Error("SITE_RELEASE_MANIFEST_INVALID");
    }
    return manifest as unknown as ReleaseManifestV1;
  }
  if (
    manifest.schemaVersion === RELEASE_MANIFEST_V2_SCHEMA_VERSION ||
    manifest.schemaVersion === RELEASE_MANIFEST_V3_SCHEMA_VERSION
  ) {
    const versionedKeys = [
      ...commonKeys,
      "componentLibraryVersion",
      "rendererVersion",
      "designBrief",
      "designBriefDigest",
      ...(manifest.schemaVersion === RELEASE_MANIFEST_V3_SCHEMA_VERSION
        ? ["quality"]
        : []),
    ];
    if (
      manifest.specVersion !== SITE_SPEC_V1_1_VERSION ||
      Object.keys(manifest).length !== versionedKeys.length ||
      Object.keys(manifest).some((key) => !versionedKeys.includes(key)) ||
      typeof manifest.componentLibraryVersion !== "string" ||
      typeof manifest.rendererVersion !== "string" ||
      typeof manifest.designBriefDigest !== "string" ||
      !SHA256.test(manifest.designBriefDigest)
    ) {
      throw new Error("SITE_RELEASE_MANIFEST_INVALID");
    }
    const brief = validateDesignBriefV2(manifest.designBrief);
    if (
      brief.digest !== manifest.designBriefDigest ||
      brief.componentLibraryVersion !== manifest.componentLibraryVersion ||
      brief.rendererVersion !== manifest.rendererVersion
    ) {
      throw new Error("SITE_RELEASE_DESIGN_BRIEF_DIGEST_MISMATCH");
    }
    if (manifest.schemaVersion === RELEASE_MANIFEST_V3_SCHEMA_VERSION) {
      try {
        validateReleaseManifestQuality(manifest.quality, {
          artifactPrefix: String(manifest.artifactPrefix),
          producerToken: String(manifest.producerToken),
          specDigest: String(manifest.specDigest),
          designBriefDigest: String(manifest.designBriefDigest),
        });
      } catch {
        throw new Error("SITE_RELEASE_MANIFEST_INVALID");
      }
      return manifest as unknown as ReleaseManifestV3;
    }
    return manifest as unknown as ReleaseManifestV2;
  }
  throw new Error("SITE_RELEASE_MANIFEST_INVALID");
}

function contentTypeFor(relativePath: string): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return (
    (
      {
        ".avif": "image/avif",
        ".css": "text/css; charset=utf-8",
        ".gif": "image/gif",
        ".htm": "text/html; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".otf": "font/otf",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ttf": "font/ttf",
        ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".xml": "application/xml; charset=utf-8",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

function validateIdentity(input: BuildReleaseArtifactInput): void {
  for (const value of [
    input.releaseId,
    input.workspaceId,
    input.siteId,
    input.siteVersionId,
    input.buildRunId,
    input.producerToken,
  ]) {
    if (!UUID.test(value)) throw new Error("SITE_RELEASE_INVALID_IDENTITY");
  }
  const expectedPrefix = `sites/${input.siteId}/releases/${input.releaseId}`;
  if (input.artifactPrefix !== expectedPrefix) {
    throw new Error("SITE_RELEASE_INVALID_ARTIFACT_PREFIX");
  }
  if (!BUILD_IDENTITY.test(input.buildIdentity)) {
    throw new Error("SITE_RELEASE_INVALID_BUILD_IDENTITY");
  }
  if (!Number.isFinite(input.releaseCreatedAt.getTime())) {
    throw new Error("SITE_RELEASE_INVALID_CREATED_AT");
  }
}

async function collectFiles(
  root: string,
  objectRoot: string,
): Promise<ReleaseArtifactFile[]> {
  const files: ReleaseArtifactFile[] = [];
  let totalBytes = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_RELEASE_DEPTH) {
      throw new Error("SITE_RELEASE_DIRECTORY_DEPTH_EXCEEDED");
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error("SITE_RELEASE_SYMLINK_FORBIDDEN");
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error("SITE_RELEASE_NON_REGULAR_FILE");
      const relativePath = path
        .relative(root, absolute)
        .split(path.sep)
        .join("/");
      // P4 verifies this private producer binding before materialization; it is
      // never part of the public static release file set.
      if (relativePath === ".site-builder-render-output.json") continue;
      if (relativePath === ".site-builder-render-output.json.tmp") {
        throw new Error("SITE_RELEASE_RENDER_MANIFEST_INCOMPLETE");
      }
      if (
        relativePath.length === 0 ||
        relativePath.startsWith("../") ||
        relativePath.includes("/../") ||
        relativePath.includes("\\") ||
        relativePath.includes("\0")
      ) {
        throw new Error("SITE_RELEASE_INVALID_FILE_PATH");
      }
      const handle = await open(absolute, "r");
      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile())
          throw new Error("SITE_RELEASE_NON_REGULAR_FILE");
        if (fileStat.size > MAX_RELEASE_FILE_BYTES) {
          throw new Error("SITE_RELEASE_FILE_SIZE_EXCEEDED");
        }
        totalBytes += fileStat.size;
        if (totalBytes > MAX_RELEASE_TOTAL_BYTES) {
          throw new Error("SITE_RELEASE_TOTAL_SIZE_EXCEEDED");
        }
        const data = await handle.readFile();
        if (data.length !== fileStat.size) {
          throw new Error("SITE_RELEASE_FILE_CHANGED_DURING_READ");
        }
        files.push({
          path: relativePath,
          objectKey: `${objectRoot}/files/${relativePath}`,
          size: data.length,
          sha256: sha256(data),
          contentType: contentTypeFor(relativePath),
          data,
        });
        if (files.length > MAX_RELEASE_FILES) {
          throw new Error("SITE_RELEASE_FILE_COUNT_EXCEEDED");
        }
      } finally {
        await handle.close();
      }
    }
  };

  await visit(root, 0);
  if (files.length === 0) throw new Error("SITE_RELEASE_EMPTY_ARTIFACT");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildReleaseArtifact(
  input: BuildReleaseArtifactInput,
): Promise<PreparedReleaseArtifact> {
  assertReleaseContract(input.spec, input.storedSpecVersion);
  if (
    (input.spec.specVersion === SITE_SPEC_V1_VERSION &&
      (input.designBrief || input.quality)) ||
    (input.spec.specVersion === SITE_SPEC_V1_1_VERSION && !input.designBrief)
  ) {
    throw new Error("SITE_RELEASE_DESIGN_BRIEF_VERSION_MISMATCH");
  }
  const designBrief = input.designBrief
    ? validateDesignBriefV2(input.designBrief)
    : undefined;
  if (
    input.spec.specVersion === SITE_SPEC_V1_1_VERSION &&
    (designBrief!.componentLibraryVersion !==
      input.spec.componentLibraryVersion ||
      designBrief!.rendererVersion !== input.spec.rendererVersion ||
      designBrief!.archetype !== input.spec.site.archetype ||
      designBrief!.familyId !== input.spec.site.familyId)
  ) {
    throw new Error("SITE_RELEASE_DESIGN_BRIEF_IDENTITY_MISMATCH");
  }
  validateIdentity(input);
  const objectRoot = `${input.artifactPrefix}/attempts/${input.producerToken}`;
  const files = await collectFiles(input.root, objectRoot);
  const manifestFiles = files.map(({ data: _data, ...file }) => file);
  const artifactDigest = releaseArtifactDigest(manifestFiles);
  const common = {
    releaseId: input.releaseId,
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    siteVersionId: input.siteVersionId,
    buildRunId: input.buildRunId,
    producerToken: input.producerToken,
    artifactPrefix: input.artifactPrefix,
    artifactDigest,
    specVersion: input.storedSpecVersion,
    specDigest: releaseSpecDigest(input.spec),
    buildIdentity: input.buildIdentity,
    createdAt: input.releaseCreatedAt.toISOString(),
    componentTypes: [
      ...new Set(
        input.spec.pages.flatMap((page) =>
          page.puck.content.map((block) => block.type),
        ),
      ),
    ].sort(),
    files: manifestFiles,
  };
  const quality = input.quality
    ? validateReleaseManifestQuality(input.quality.manifest, {
        artifactPrefix: input.artifactPrefix,
        producerToken: input.producerToken,
        specDigest: common.specDigest,
        designBriefDigest: designBrief!.digest,
      })
    : undefined;
  if (quality) {
    let evaluation: DesignEvaluationV2;
    try {
      evaluation = validateDesignEvaluationV2(
        input.quality!.designEvaluation,
        quality.artifactSet,
      );
    } catch {
      throw new Error("SITE_RELEASE_QUALITY_GATE_NOT_PASSED");
    }
    let aestheticEvidence: ReleaseAestheticEvidenceV1;
    try {
      aestheticEvidence = validateReleaseAestheticEvidence(
        input.quality!.aestheticEvidence,
      );
    } catch {
      throw new Error("SITE_RELEASE_QUALITY_GATE_NOT_PASSED");
    }
    const evaluationBytes = Buffer.from(
      canonicalDesignEvaluationV2Json(evaluation, quality.artifactSet),
    );
    const aestheticEvidenceBytes =
      releaseAestheticEvidenceBytes(aestheticEvidence);
    const manifestAestheticEvidence = {
      status: quality.aesthetic.status,
      requestedModel: quality.aesthetic.requestedModel,
      reportedModel: quality.aesthetic.reportedModel,
      resolvedModel: quality.aesthetic.resolvedModel,
      transport: quality.aesthetic.transport,
      routePolicyVersion: quality.aesthetic.routePolicyVersion,
      errorClassification: quality.aesthetic.errorClassification,
    };
    const unavailable =
      evaluation.aesthetic.status === "unavailable" &&
      quality.aesthetic.status === "unavailable" &&
      quality.aesthetic.errorClassification ===
        evaluation.aesthetic.unavailableReason &&
      quality.status === "passed_deterministic_aesthetic_unavailable";
    const aestheticallyPassed =
      evaluation.aesthetic.status === "passed" &&
      quality.aesthetic.status === "passed" &&
      quality.status !== "passed_deterministic_aesthetic_unavailable";
    const findings = [
      ...evaluation.deterministic.findings,
      ...evaluation.aesthetic.findings,
    ];
    const hasMajorFinding = findings.some(
      (finding) => finding.severity === "major",
    );
    const hasMinorFinding = findings.some(
      (finding) => finding.severity === "minor",
    );
    const statusMatchesFindings = unavailable
      ? quality.status === "passed_deterministic_aesthetic_unavailable"
      : hasMinorFinding
        ? quality.status === "passed_with_minor_findings"
        : quality.status === "passed";
    if (
      hasDesignEvaluationHardFailures(evaluation) ||
      hasMajorFinding ||
      evaluation.deterministic.status !== "passed" ||
      evaluation.candidateSpecDigest !== common.specDigest ||
      evaluation.designBriefDigest !== designBrief!.digest ||
      evaluation.artifactSetDigest !== quality.artifactSet.artifactSetDigest ||
      evaluation.round !== quality.finalRound ||
      evaluation.evaluatorVersion !== quality.deterministicEvaluatorVersion ||
      designEvaluationV2Digest(evaluation, quality.artifactSet) !==
        quality.designEvaluationDigest ||
      evaluationBytes.length !== quality.designEvaluationRef.sizeBytes ||
      releaseAestheticEvidenceDigest(aestheticEvidence) !==
        quality.aesthetic.evidenceDigest ||
      aestheticEvidenceBytes.length !==
        quality.aesthetic.evidenceRef.sizeBytes ||
      canonicalJson(aestheticEvidence) !==
        canonicalJson({
          schemaVersion: RELEASE_AESTHETIC_EVIDENCE_SCHEMA_VERSION,
          ...manifestAestheticEvidence,
        }) ||
      !statusMatchesFindings ||
      (!unavailable && !aestheticallyPassed)
    ) {
      throw new Error("SITE_RELEASE_QUALITY_GATE_NOT_PASSED");
    }
    const expectedTargets = new Set(
      input.spec.site.locales.flatMap((locale) =>
        input.spec.pages.map((page) => `${locale}\u0000${page.id}`),
      ),
    );
    const declaredTargets = new Set(
      quality.artifactSet.expectedTargets.map(
        (target) => `${target.locale}\u0000${target.pageId}`,
      ),
    );
    if (
      expectedTargets.size !== declaredTargets.size ||
      [...expectedTargets].some((target) => !declaredTargets.has(target))
    ) {
      throw new Error("SITE_RELEASE_QUALITY_SCOPE_MISMATCH");
    }
  }
  const manifest: ReleaseManifest =
    input.spec.specVersion === SITE_SPEC_V1_1_VERSION
      ? quality
        ? {
            ...common,
            schemaVersion: RELEASE_MANIFEST_V3_SCHEMA_VERSION,
            specVersion: SITE_SPEC_V1_1_VERSION,
            componentLibraryVersion: input.spec.componentLibraryVersion,
            rendererVersion: input.spec.rendererVersion,
            designBrief: designBrief!,
            designBriefDigest: designBrief!.digest,
            quality,
          }
        : {
            ...common,
            schemaVersion: RELEASE_MANIFEST_V2_SCHEMA_VERSION,
            specVersion: SITE_SPEC_V1_1_VERSION,
            componentLibraryVersion: input.spec.componentLibraryVersion,
            rendererVersion: input.spec.rendererVersion,
            designBrief: designBrief!,
            designBriefDigest: designBrief!.digest,
          }
      : {
          ...common,
          schemaVersion: RELEASE_MANIFEST_V1_SCHEMA_VERSION,
          specVersion: SITE_SPEC_V1_VERSION,
        };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  return {
    files,
    manifest,
    manifestBytes,
    manifestDigest: releaseManifestDigest(manifest),
    manifestObjectKey: `${objectRoot}/release-manifest.json`,
    artifactDigest,
  };
}

async function putAndVerify(
  storage: ReleaseArtifactStorage,
  input: {
    key: string;
    data: Buffer;
    contentType: string;
    sha256: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  await storage.putBufferImmutable(
    input.key,
    input.data,
    input.contentType,
    input.sha256,
    signal,
  );
  const observed = await storage.hashObject(input.key, signal);
  if (observed.size !== input.data.length || observed.sha256 !== input.sha256) {
    throw new Error(`SITE_RELEASE_OBJECT_INTEGRITY_MISMATCH: ${input.key}`);
  }
}

export async function uploadReleaseArtifact(
  release: PreparedReleaseArtifact,
  storage: ReleaseArtifactStorage,
  signal?: AbortSignal,
): Promise<void> {
  for (const file of release.files) {
    await putAndVerify(
      storage,
      {
        key: file.objectKey,
        data: file.data,
        contentType: file.contentType,
        sha256: file.sha256,
      },
      signal,
    );
  }
  if (release.manifest.schemaVersion === RELEASE_MANIFEST_V3_SCHEMA_VERSION) {
    const qualityRefs = [
      ...release.manifest.quality.artifactSet.artifacts.map((artifact) => ({
        objectKey: artifact.objectKey,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      })),
      release.manifest.quality.designEvaluationRef,
    ];
    for (const reference of qualityRefs) {
      let observed: { sha256: string; head: Buffer; size: number };
      try {
        observed = await storage.hashObject(reference.objectKey, signal);
      } catch {
        throw new Error(`QUALITY_ARTIFACT_INVALID: ${reference.objectKey}`);
      }
      if (
        observed.size !== reference.sizeBytes ||
        observed.sha256 !== reference.sha256
      ) {
        throw new Error(`QUALITY_ARTIFACT_INVALID: ${reference.objectKey}`);
      }
    }
  }
  await putAndVerify(
    storage,
    {
      key: release.manifestObjectKey,
      data: release.manifestBytes,
      contentType: "application/json; charset=utf-8",
      sha256: release.manifestDigest,
    },
    signal,
  );
}
