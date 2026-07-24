import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type {
  DesignEvaluationDimension,
  DesignEvaluationSeverity,
  DesignEvaluationV2RuleCode,
  QualityBreakpoint,
} from "@global/contracts";
import type { VisionReviewImage } from "../../model-gateway/types";

export const AESTHETIC_REVIEW_EVALUATOR_VERSION =
  "site-builder-aesthetic-review-eval@2.0.0";
export const AESTHETIC_REVIEW_EVAL_SCHEMA_VERSION =
  "site-builder-model1-aesthetic-review-report/v1";
export const AESTHETIC_REVIEW_PROMPT_VERSION =
  "site-builder-aesthetic-review-prompt/v2";
export const AESTHETIC_REVIEW_DEGRADATION_VERSION =
  "site-builder-aesthetic-degradation/v1";

export const AESTHETIC_DIMENSIONS = [
  "hierarchy",
  "consistency",
  "spacing",
  "contrast",
  "imagery",
  "mobileComposition",
  "ctaClarity",
  "credibility",
  "originality",
] as const satisfies readonly DesignEvaluationDimension[];

export const AESTHETIC_DIMENSION_WEIGHTS = Object.freeze({
  hierarchy: 15,
  consistency: 15,
  spacing: 10,
  contrast: 10,
  imagery: 10,
  mobileComposition: 15,
  ctaClarity: 10,
  credibility: 10,
  originality: 5,
} as const satisfies Readonly<Record<DesignEvaluationDimension, number>>);

export const AESTHETIC_RULE_CODES = [
  "AESTHETIC_HIERARCHY",
  "AESTHETIC_CONSISTENCY",
  "AESTHETIC_SPACING",
  "AESTHETIC_CONTRAST",
  "AESTHETIC_IMAGERY",
  "AESTHETIC_MOBILE_COMPOSITION",
  "AESTHETIC_CTA_CLARITY",
  "AESTHETIC_CREDIBILITY",
  "AESTHETIC_ORIGINALITY",
] as const satisfies readonly DesignEvaluationV2RuleCode[];

export type AestheticRuleCode = (typeof AESTHETIC_RULE_CODES)[number];

const BREAKPOINTS = [375, 768, 1440] as const;
const OUTPUT_KEYS = [
  "verdict",
  "overallScore",
  "dimensions",
  "findings",
] as const;
const FINDING_KEYS = ["severity", "ruleCode", "target", "evidenceRef"] as const;
const TARGET_KEYS = ["locale", "pageId", "breakpoint"] as const;
const EVIDENCE_REF_KEYS = ["artifactId"] as const;
const VIEWPORT_BY_BREAKPOINT = {
  375: "mobile-375",
  768: "tablet-768",
  1440: "desktop-1440",
} as const;

const FAMILY_DEGRADATIONS = Object.freeze({
  "natural-origin": "AESTHETIC_IMAGERY",
  "oem-capability": "AESTHETIC_CONTRAST",
  "precision-industrial": "AESTHETIC_SPACING",
  "premium-innovation": "AESTHETIC_HIERARCHY",
  "scientific-trust": "AESTHETIC_CONSISTENCY",
  "technical-catalog": "AESTHETIC_MOBILE_COMPOSITION",
} as const satisfies Readonly<Record<string, AestheticRuleCode>>);

export const AESTHETIC_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "overallScore", "dimensions", "findings"],
  properties: {
    verdict: { type: "string", enum: ["passed", "failed"] },
    overallScore: { type: "integer", minimum: 0, maximum: 100 },
    dimensions: {
      type: "object",
      additionalProperties: false,
      required: [...AESTHETIC_DIMENSIONS],
      properties: Object.fromEntries(
        AESTHETIC_DIMENSIONS.map((dimension) => [
          dimension,
          { type: "integer", minimum: 0, maximum: 100 },
        ]),
      ),
    },
    findings: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "ruleCode", "target", "evidenceRef"],
        properties: {
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor"],
          },
          ruleCode: { type: "string", enum: [...AESTHETIC_RULE_CODES] },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["locale", "pageId", "breakpoint"],
            properties: {
              locale: { type: "string", const: "en" },
              pageId: {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$",
              },
              breakpoint: { type: "integer", enum: [...BREAKPOINTS] },
            },
          },
          evidenceRef: {
            type: "object",
            additionalProperties: false,
            required: ["artifactId"],
            properties: {
              artifactId: {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$",
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface AestheticReviewOutput {
  verdict: "passed" | "failed";
  overallScore: number;
  dimensions: Record<DesignEvaluationDimension, number>;
  findings: Array<{
    severity: DesignEvaluationSeverity;
    ruleCode: AestheticRuleCode;
    target: {
      locale: "en";
      pageId: string;
      breakpoint: QualityBreakpoint;
    };
    evidenceRef: { artifactId: string };
  }>;
}

export interface AestheticEvalCase {
  caseId: string;
  familyId: keyof typeof FAMILY_DEGRADATIONS;
  kind: "approved" | "degraded";
  expectedIssue: AestheticRuleCode | null;
  images: readonly VisionReviewImage[];
  prompt: string;
}

interface VisualManifest {
  schemaVersion: string;
  screenshotCount: number;
  screenshots: Array<{
    fixtureId: string;
    viewport: string;
    path: string;
    sha256: string;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPng(bytes: Uint8Array): void {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < signature.length ||
    signature.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new Error("AESTHETIC_EVAL_FIXTURE_INVALID: png signature");
  }
}

async function overlay(
  input: Uint8Array,
  fill: string,
  top: number,
  height: number,
): Promise<Buffer> {
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("AESTHETIC_EVAL_FIXTURE_INVALID: image dimensions");
  }
  const svg = Buffer.from(
    `<svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${top}" width="${metadata.width}" height="${height}" fill="${fill}"/></svg>`,
  );
  return sharp(input)
    .composite([{ input: svg }])
    .png()
    .toBuffer();
}

export async function degradeAestheticScreenshot(
  input: Uint8Array,
  issue: AestheticRuleCode,
  breakpoint: QualityBreakpoint,
): Promise<Buffer> {
  assertPng(input);
  const metadata = await sharp(input).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("AESTHETIC_EVAL_FIXTURE_INVALID: image dimensions");
  }
  let output: Buffer;
  switch (issue) {
    case "AESTHETIC_IMAGERY":
      output = await sharp(input).blur(16).png().toBuffer();
      break;
    case "AESTHETIC_CONTRAST":
      output = await overlay(
        input,
        "rgba(255,255,255,0.78)",
        0,
        metadata.height,
      );
      break;
    case "AESTHETIC_SPACING": {
      const compressedWidth = Math.max(1, Math.floor(metadata.width * 0.62));
      output = await sharp(input)
        .resize({
          width: compressedWidth,
          height: metadata.height,
          fit: "fill",
        })
        .extend({
          top: 0,
          bottom: 0,
          left: 0,
          right: metadata.width - compressedWidth,
          background: "#ffffff",
        })
        .png()
        .toBuffer();
      break;
    }
    case "AESTHETIC_HIERARCHY":
      output = await overlay(
        input,
        "rgba(246,246,246,0.96)",
        Math.floor(metadata.height * 0.04),
        Math.max(1, Math.floor(metadata.height * 0.32)),
      );
      break;
    case "AESTHETIC_CONSISTENCY": {
      const fill =
        breakpoint === 375
          ? "rgba(208,36,36,0.38)"
          : breakpoint === 768
            ? "rgba(35,167,75,0.38)"
            : "rgba(40,85,220,0.38)";
      output = await overlay(input, fill, 0, metadata.height);
      break;
    }
    case "AESTHETIC_MOBILE_COMPOSITION":
      if (breakpoint !== 375) {
        output = Buffer.from(input);
        break;
      }
      {
        const compressedWidth = Math.max(1, Math.floor(metadata.width * 0.54));
        output = await sharp(input)
          .resize({
            width: compressedWidth,
            height: metadata.height,
            fit: "fill",
          })
          .extend({
            top: 0,
            bottom: 0,
            left: 0,
            right: metadata.width - compressedWidth,
            background: "#111111",
          })
          .png()
          .toBuffer();
        break;
      }
    default:
      throw new Error(`AESTHETIC_EVAL_DEGRADATION_UNKNOWN: ${issue}`);
  }
  assertPng(output);
  if (output.byteLength > 2 * 1024 * 1024) {
    throw new Error("AESTHETIC_EVAL_FIXTURE_INVALID: image too large");
  }
  return output;
}

function promptForCase(
  caseId: string,
  images: readonly VisionReviewImage[],
): string {
  return [
    `Review the three screenshots for evaluation case ${caseId}.`,
    "They show one site at mobile 375, tablet 768, and desktop 1440.",
    "Judge only visible design quality. Return the exact JSON schema.",
    "Use only the frozen AESTHETIC_* rule codes. Do not propose repairs, code, components, variants, CSS, HTML, Astro, paths, or free-form targets.",
    "Set overallScore to the nearest integer of the weighted dimension score: hierarchy 15%, consistency 15%, spacing 10%, contrast 10%, imagery 10%, mobileComposition 15%, ctaClarity 10%, credibility 10%, originality 5%.",
    "passed requires that deterministic weighted overallScore >= 85, every dimension >= 60, and no blocker or major finding; otherwise return failed.",
    `Evidence artifact ids: ${images.map((image) => image.artifactId).join(", ")}`,
  ].join("\n");
}

export async function loadAestheticEvalCases(
  repositoryRoot: string,
): Promise<AestheticEvalCase[]> {
  const screenshotRoot = path.join(
    repositoryRoot,
    "apps/site-renderer/visual-tests/__screenshots__/m1-e-b",
  );
  const manifest = JSON.parse(
    await readFile(path.join(screenshotRoot, "manifest.json"), "utf8"),
  ) as VisualManifest;
  if (
    manifest.schemaVersion !== "site-builder-m1-e-b-visual-evidence/v1" ||
    manifest.screenshotCount !== 36 ||
    manifest.screenshots.length !== 36
  ) {
    throw new Error("AESTHETIC_EVAL_FIXTURE_INVALID: visual manifest");
  }

  const cases: AestheticEvalCase[] = [];
  for (const [familyId, issue] of Object.entries(FAMILY_DEGRADATIONS) as Array<
    [keyof typeof FAMILY_DEGRADATIONS, AestheticRuleCode]
  >) {
    const approvedImages: VisionReviewImage[] = [];
    const degradedImages: VisionReviewImage[] = [];
    for (const breakpoint of BREAKPOINTS) {
      const fixtureId = `${familyId}-rich`;
      const viewport = VIEWPORT_BY_BREAKPOINT[breakpoint];
      const entry = manifest.screenshots.find(
        (candidate) =>
          candidate.fixtureId === fixtureId && candidate.viewport === viewport,
      );
      if (!entry) {
        throw new Error(
          `AESTHETIC_EVAL_FIXTURE_INVALID: ${fixtureId}/${viewport}`,
        );
      }
      const source = await readFile(path.join(screenshotRoot, entry.path));
      if (sha256(source) !== entry.sha256) {
        throw new Error(
          `AESTHETIC_EVAL_FIXTURE_DIGEST_MISMATCH: ${entry.path}`,
        );
      }
      const approvedArtifactId = `m1f:${familyId}:approved:${breakpoint}`;
      approvedImages.push({
        materialClass: "model_eval_fixture",
        artifactId: approvedArtifactId,
        sha256: entry.sha256,
        mimeType: "image/png",
        bytes: new Uint8Array(source),
        target: { locale: "en", pageId: familyId, breakpoint },
      });
      const degraded = await degradeAestheticScreenshot(
        source,
        issue,
        breakpoint,
      );
      degradedImages.push({
        materialClass: "model_eval_fixture",
        artifactId: `m1f:${familyId}:degraded:${breakpoint}`,
        sha256: sha256(degraded),
        mimeType: "image/png",
        bytes: new Uint8Array(degraded),
        target: { locale: "en", pageId: familyId, breakpoint },
      });
    }
    cases.push({
      caseId: `${familyId}-approved`,
      familyId,
      kind: "approved",
      expectedIssue: null,
      images: approvedImages,
      prompt: promptForCase(`${familyId}-approved`, approvedImages),
    });
    cases.push({
      caseId: `${familyId}-degraded`,
      familyId,
      kind: "degraded",
      expectedIssue: issue,
      images: degradedImages,
      prompt: promptForCase(`${familyId}-degraded`, degradedImages),
    });
  }
  return cases.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const frozen = [...expected].sort();
  return (
    actual.length === frozen.length &&
    actual.every((key, index) => key === frozen[index])
  );
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value)
  );
}

export function calculateAestheticWeightedScore(
  dimensions: Readonly<Record<DesignEvaluationDimension, number>>,
): number {
  const weightedHundredths = AESTHETIC_DIMENSIONS.reduce(
    (total, dimension) =>
      total + dimensions[dimension] * AESTHETIC_DIMENSION_WEIGHTS[dimension],
    0,
  );
  return Math.round(weightedHundredths / 100);
}

export function assertAestheticReviewOutput(
  value: unknown,
  inputImages: readonly VisionReviewImage[],
): AestheticReviewOutput {
  if (!isRecord(value) || !hasExactKeys(value, OUTPUT_KEYS)) {
    throw new Error("AESTHETIC_REVIEW_OUTPUT_INVALID");
  }
  const allowedArtifactIds = new Set(
    inputImages.map((image) => image.artifactId),
  );
  const targetByArtifactId = new Map(
    inputImages.map((image) => [image.artifactId, image.target]),
  );
  const dimensions = value.dimensions;
  const findings = value.findings;
  if (
    !["passed", "failed"].includes(String(value.verdict)) ||
    !Number.isInteger(value.overallScore) ||
    Number(value.overallScore) < 0 ||
    Number(value.overallScore) > 100 ||
    !isRecord(dimensions) ||
    !hasExactKeys(dimensions, AESTHETIC_DIMENSIONS) ||
    !AESTHETIC_DIMENSIONS.every(
      (dimension) =>
        Number.isInteger(dimensions[dimension]) &&
        Number(dimensions[dimension]) >= 0 &&
        Number(dimensions[dimension]) <= 100,
    ) ||
    !Array.isArray(findings) ||
    findings.length > 32
  ) {
    throw new Error("AESTHETIC_REVIEW_OUTPUT_INVALID");
  }
  for (const finding of findings) {
    const evidenceRef = isRecord(finding) ? finding.evidenceRef : undefined;
    const evidenceArtifactId = isRecord(evidenceRef)
      ? evidenceRef.artifactId
      : undefined;
    const evidenceTarget =
      typeof evidenceArtifactId === "string"
        ? targetByArtifactId.get(evidenceArtifactId)
        : undefined;
    if (
      !isRecord(finding) ||
      !hasExactKeys(finding, FINDING_KEYS) ||
      !["blocker", "major", "minor"].includes(String(finding.severity)) ||
      !AESTHETIC_RULE_CODES.includes(finding.ruleCode as AestheticRuleCode) ||
      !isRecord(finding.target) ||
      !hasExactKeys(finding.target, TARGET_KEYS) ||
      finding.target.locale !== "en" ||
      !isBoundedToken(finding.target.pageId) ||
      !BREAKPOINTS.includes(finding.target.breakpoint as QualityBreakpoint) ||
      !isRecord(finding.evidenceRef) ||
      !hasExactKeys(finding.evidenceRef, EVIDENCE_REF_KEYS) ||
      !isBoundedToken(finding.evidenceRef.artifactId) ||
      !allowedArtifactIds.has(finding.evidenceRef.artifactId) ||
      !evidenceTarget ||
      finding.target.locale !== evidenceTarget.locale ||
      finding.target.pageId !== evidenceTarget.pageId ||
      finding.target.breakpoint !== evidenceTarget.breakpoint
    ) {
      throw new Error("AESTHETIC_REVIEW_OUTPUT_INVALID");
    }
  }
  const output = value as unknown as AestheticReviewOutput;
  if (
    output.overallScore !== calculateAestheticWeightedScore(output.dimensions)
  ) {
    throw new Error("AESTHETIC_REVIEW_OUTPUT_SCORE_INCONSISTENT");
  }
  const hasHardFinding = output.findings.some(
    (finding) => finding.severity === "blocker" || finding.severity === "major",
  );
  const hasLowDimension = AESTHETIC_DIMENSIONS.some(
    (dimension) => output.dimensions[dimension] < 60,
  );
  const mustFail =
    output.overallScore < 85 || hasHardFinding || hasLowDimension;
  if (
    (output.verdict === "passed" && mustFail) ||
    (output.verdict === "failed" && !mustFail)
  ) {
    throw new Error("AESTHETIC_REVIEW_OUTPUT_INCONSISTENT");
  }
  return structuredClone(output);
}

export function evaluateAestheticCaseOutput(
  evalCase: AestheticEvalCase,
  output: AestheticReviewOutput,
): {
  falseBlocker: boolean;
  seededIssueDetected: boolean | null;
  accepted: boolean;
} {
  const falseBlocker =
    evalCase.kind === "approved" &&
    (output.verdict === "failed" ||
      output.findings.some((finding) => finding.severity === "blocker"));
  const seededIssueDetected =
    evalCase.expectedIssue === null
      ? null
      : output.verdict === "failed" &&
        output.findings.some(
          (finding) =>
            finding.ruleCode === evalCase.expectedIssue &&
            (finding.severity === "blocker" || finding.severity === "major"),
        );
  return {
    falseBlocker,
    seededIssueDetected,
    accepted:
      !falseBlocker && (seededIssueDetected === null || seededIssueDetected),
  };
}
