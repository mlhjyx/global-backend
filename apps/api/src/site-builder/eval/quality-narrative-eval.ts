import { createHash } from "node:crypto";

import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
  type DesignEvaluationFindingV2,
  type DesignEvaluationV2,
  type DesignEvaluationV2RuleCode,
  type QualityArtifactRefV1,
  type QualityArtifactSetV1,
} from "@global/contracts";
import {
  buildQualityNarrativeFindingIndex,
  canonicalQualityNarrativeJson,
  deterministicQualityNarrativeOutput,
  partitionQualityNarrativeFindings,
  qualityNarrativeTaskInput,
  validateQualityNarrativeTaskOutput,
  type QualityNarrativeSeoReportEvidenceV1,
  type QualityNarrativeTaskId,
  type QualityNarrativeTaskInputV1,
  type QualityNarrativeTaskOutputV1,
} from "../quality/quality-narrative";

export const QUALITY_NARRATIVE_EVAL_FIXTURE_SCHEMA_VERSION =
  "site-builder-quality-narrative-eval-fixture/v1" as const;
export const QUALITY_NARRATIVE_EVALUATOR_VERSION =
  "site-builder-quality-narrative-evaluator/2026-08-04-v1" as const;
export const QUALITY_NARRATIVE_ROUTE_VALIDATION_VERSION =
  "site-builder-quality-narrative-route-validation/2026-08-04-v1" as const;
export const QUALITY_NARRATIVE_PROMPT_VERSION =
  "site-builder-quality-narrative-prompt/2026-08-04-v1" as const;

export const QUALITY_NARRATIVE_EVALUATOR_RUBRIC = Object.freeze({
  closedOutputShape: true,
  productionValidator: "validateQualityNarrativeTaskOutput",
  deterministicOutputEquivalence: true,
  completeFindingCoverage: true,
  freeFormProseAllowed: false,
  prohibitedBehavior: Object.freeze([
    "invent_finding",
    "omit_finding",
    "duplicate_finding",
    "change_group",
    "change_explanation",
    "reorder_closed_output",
    "add_free_form_text",
  ]),
} as const);

type FixtureTarget = { locale: string; pageId: string };
type FixtureFinding = {
  ruleCode: DesignEvaluationV2RuleCode;
  severity: "blocker" | "major" | "minor";
  targetIndex: number;
  artifactKind: "seo" | "deterministic" | "screenshot" | "axe" | "lighthouse";
};

export interface QualityNarrativeEvalFixture {
  schemaVersion: typeof QUALITY_NARRATIVE_EVAL_FIXTURE_SCHEMA_VERSION;
  fixtureId: string;
  taskId: QualityNarrativeTaskId;
  artifactSet: QualityArtifactSetV1;
  evaluation: DesignEvaluationV2;
  seoReports: QualityNarrativeSeoReportEvidenceV1[];
}

export interface PreparedQualityNarrativeEvalFixture {
  fixture: QualityNarrativeEvalFixture;
  input: QualityNarrativeTaskInputV1;
}

export interface QualityNarrativeEvaluationOutcome {
  exactDeterministicOutput: boolean;
  rejectedFindingIds: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function artifact(
  fixtureId: string,
  id: string,
  kind: QualityArtifactRefV1["kind"],
  target: FixtureTarget & { breakpoint?: 375 | 768 | 1440 },
): QualityArtifactRefV1 {
  const payload = `${fixtureId}:${id}`;
  return {
    artifactId: id,
    objectKey: `private/eval/quality-narrative/${fixtureId}/${id}`,
    sha256: sha256(payload),
    sizeBytes: Buffer.byteLength(payload),
    mimeType: kind === "screenshot" ? "image/png" : "application/json",
    kind,
    target,
  };
}

function reportFor(
  fixtureId: string,
  target: FixtureTarget,
  artifactRef: QualityArtifactRefV1,
): QualityNarrativeSeoReportEvidenceV1 {
  return {
    artifactId: artifactRef.artifactId,
    sha256: artifactRef.sha256,
    target,
    checks: {
      h1Count: 2,
      canonicalPresent: false,
      hreflangCount: 0,
      previewNoindex: false,
      robotsTxtOk: false,
      sitemapOk: false,
      jsonLdValid: false,
      jsonLdUnsupportedFacts: true,
    },
  };
}

function makeFixture(input: {
  fixtureId: string;
  taskId: QualityNarrativeTaskId;
  targets: readonly FixtureTarget[];
  findings: readonly FixtureFinding[];
}): QualityNarrativeEvalFixture {
  const artifacts: QualityArtifactRefV1[] = [];
  const byTarget = input.targets.map((target, targetIndex) => {
    for (const breakpoint of [375, 768, 1440] as const) {
      artifacts.push(
        artifact(
          input.fixtureId,
          `screenshot-${targetIndex}-${breakpoint}`,
          "screenshot",
          {
            ...target,
            breakpoint,
          },
        ),
      );
    }
    const seo = artifact(
      input.fixtureId,
      `seo-${targetIndex}`,
      "seo_report",
      target,
    );
    const deterministic = artifact(
      input.fixtureId,
      `deterministic-${targetIndex}`,
      "deterministic_evaluation",
      target,
    );
    const axe = artifact(
      input.fixtureId,
      `axe-${targetIndex}`,
      "axe_report",
      target,
    );
    const lighthouse = artifact(
      input.fixtureId,
      `lighthouse-${targetIndex}`,
      "lighthouse_report",
      target,
    );
    artifacts.push(seo, deterministic, axe, lighthouse);
    return { seo, deterministic, axe, lighthouse };
  });
  const draft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: sha256(`${input.fixtureId}:candidate`),
    designBriefDigest: sha256(`${input.fixtureId}:brief`),
    round: 0 as const,
    expectedTargets: input.targets.map((target) => ({ ...target })),
    artifacts,
  };
  const artifactSet: QualityArtifactSetV1 = {
    ...draft,
    artifactSetDigest: qualityArtifactSetDigest(draft),
  };
  const findings: DesignEvaluationFindingV2[] = input.findings.map(
    (finding, index) => {
      const target = input.targets[finding.targetIndex];
      if (!target)
        throw new Error(
          `quality narrative fixture target missing: ${input.fixtureId}`,
        );
      const artifactsForTarget = byTarget[finding.targetIndex]!;
      const evidenceRef =
        finding.artifactKind === "seo"
          ? artifactsForTarget.seo
          : finding.artifactKind === "deterministic"
            ? artifactsForTarget.deterministic
            : finding.artifactKind === "axe"
              ? artifactsForTarget.axe
              : finding.artifactKind === "lighthouse"
                ? artifactsForTarget.lighthouse
                : artifacts.find(
                    (entry) =>
                      entry.kind === "screenshot" &&
                      entry.target?.locale === target.locale &&
                      entry.target?.pageId === target.pageId &&
                      entry.target?.breakpoint ===
                        (index % 2 === 0 ? 375 : 1440),
                  );
      if (!evidenceRef)
        throw new Error(
          `quality narrative fixture evidence missing: ${input.fixtureId}`,
        );
      return {
        source: "deterministic",
        severity: finding.severity,
        ruleCode: finding.ruleCode,
        target: {
          ...target,
          ...(finding.artifactKind === "screenshot"
            ? { breakpoint: index % 2 === 0 ? (375 as const) : (1440 as const) }
            : {}),
        },
        evidenceRef: { artifactId: evidenceRef.artifactId },
      };
    },
  );
  const evaluation: DesignEvaluationV2 = {
    schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
    candidateSpecDigest: draft.candidateSpecDigest,
    designBriefDigest: draft.designBriefDigest,
    artifactSetDigest: artifactSet.artifactSetDigest,
    round: 0,
    evaluatorVersion: QUALITY_NARRATIVE_EVALUATOR_VERSION,
    deterministic: {
      status: "failed",
      hardFailures: findings.filter(({ severity }) => severity === "blocker"),
      findings: findings.filter(({ severity }) => severity !== "blocker"),
    },
    aesthetic: {
      status: "unavailable",
      overallScore: null,
      dimensions: null,
      unavailableReason: "model_not_listed",
      findings: [],
    },
  };
  const seoReports =
    input.taskId === "site_builder.seo_review"
      ? input.targets.map((target, index) =>
          reportFor(input.fixtureId, target, byTarget[index]!.seo),
        )
      : [];
  return deepFreeze({
    schemaVersion: QUALITY_NARRATIVE_EVAL_FIXTURE_SCHEMA_VERSION,
    fixtureId: input.fixtureId,
    taskId: input.taskId,
    artifactSet,
    evaluation,
    seoReports,
  });
}

export const QUALITY_NARRATIVE_EVAL_FIXTURES = deepFreeze([
  makeFixture({
    fixtureId: "qa-multigroup",
    taskId: "site_builder.qa_summarize",
    targets: [{ locale: "en", pageId: "home" }],
    findings: [
      {
        ruleCode: "CONTRACT_INVALID",
        severity: "blocker",
        targetIndex: 0,
        artifactKind: "deterministic",
      },
      {
        ruleCode: "OUTBOUND_REQUEST_FORBIDDEN",
        severity: "major",
        targetIndex: 0,
        artifactKind: "deterministic",
      },
      {
        ruleCode: "AXE_SERIOUS",
        severity: "major",
        targetIndex: 0,
        artifactKind: "axe",
      },
      {
        ruleCode: "LIGHTHOUSE_PERFORMANCE_BELOW_THRESHOLD",
        severity: "minor",
        targetIndex: 0,
        artifactKind: "lighthouse",
      },
      {
        ruleCode: "GENERICNESS_HERO_REPEAT",
        severity: "minor",
        targetIndex: 0,
        artifactKind: "deterministic",
      },
      {
        ruleCode: "HORIZONTAL_OVERFLOW",
        severity: "major",
        targetIndex: 0,
        artifactKind: "screenshot",
      },
    ],
  }),
  makeFixture({
    fixtureId: "qa-ordering",
    taskId: "site_builder.qa_summarize",
    targets: [
      { locale: "de", pageId: "product" },
      { locale: "en", pageId: "home" },
    ],
    findings: [
      {
        ruleCode: "AXE_CRITICAL",
        severity: "blocker",
        targetIndex: 1,
        artifactKind: "axe",
      },
      {
        ruleCode: "CTA_UNREACHABLE",
        severity: "major",
        targetIndex: 0,
        artifactKind: "screenshot",
      },
      {
        ruleCode: "EXTERNAL_FONT_FORBIDDEN",
        severity: "major",
        targetIndex: 1,
        artifactKind: "deterministic",
      },
      {
        ruleCode: "TEXT_CLIPPED",
        severity: "minor",
        targetIndex: 0,
        artifactKind: "screenshot",
      },
    ],
  }),
  makeFixture({
    fixtureId: "seo-full-rule-matrix",
    taskId: "site_builder.seo_review",
    targets: [{ locale: "en", pageId: "home" }],
    findings: [
      {
        ruleCode: "H1_COUNT_INVALID",
        severity: "blocker",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "CANONICAL_INVALID",
        severity: "major",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "HREFLANG_INVALID",
        severity: "major",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "PREVIEW_NOINDEX_INVALID",
        severity: "major",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "ROBOTS_INVALID",
        severity: "minor",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "SITEMAP_INVALID",
        severity: "minor",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "JSON_LD_INVALID",
        severity: "major",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "JSON_LD_FACT_UNSUPPORTED",
        severity: "blocker",
        targetIndex: 0,
        artifactKind: "seo",
      },
    ],
  }),
  makeFixture({
    fixtureId: "seo-multilocale-reports",
    taskId: "site_builder.seo_review",
    targets: [
      { locale: "de", pageId: "product" },
      { locale: "en", pageId: "home" },
    ],
    findings: [
      {
        ruleCode: "H1_COUNT_INVALID",
        severity: "blocker",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "HREFLANG_INVALID",
        severity: "major",
        targetIndex: 1,
        artifactKind: "seo",
      },
      {
        ruleCode: "SITEMAP_INVALID",
        severity: "minor",
        targetIndex: 0,
        artifactKind: "seo",
      },
      {
        ruleCode: "JSON_LD_INVALID",
        severity: "major",
        targetIndex: 1,
        artifactKind: "seo",
      },
    ],
  }),
] as const);

function assertSeoReportBindings(fixture: QualityNarrativeEvalFixture): void {
  if (fixture.taskId === "site_builder.qa_summarize") {
    if (fixture.seoReports.length !== 0) {
      throw new Error(
        "quality narrative QA fixture must not include SEO reports",
      );
    }
    return;
  }
  const artifacts = new Map(
    fixture.artifactSet.artifacts.map((entry) => [entry.artifactId, entry]),
  );
  const seoArtifacts = [...artifacts.values()].filter(
    (artifact) => artifact.kind === "seo_report",
  );
  if (fixture.seoReports.length !== seoArtifacts.length) {
    throw new Error(
      "quality narrative SEO fixture must bind one report to every target",
    );
  }
  const seenTargets = new Set<string>();
  for (const report of fixture.seoReports) {
    const artifact = artifacts.get(report.artifactId);
    const targetKey = `${report.target.locale}:${report.target.pageId}`;
    if (
      !artifact ||
      artifact.kind !== "seo_report" ||
      artifact.sha256 !== report.sha256 ||
      artifact.target?.locale !== report.target.locale ||
      artifact.target?.pageId !== report.target.pageId ||
      !seoArtifacts.some(
        (seoArtifact) =>
          seoArtifact.target?.locale === report.target.locale &&
          seoArtifact.target?.pageId === report.target.pageId,
      ) ||
      seenTargets.has(targetKey)
    ) {
      throw new Error("quality narrative SEO report is not artifact-bound");
    }
    seenTargets.add(targetKey);
  }
}

export function prepareQualityNarrativeEvalFixture(
  fixture: QualityNarrativeEvalFixture,
): PreparedQualityNarrativeEvalFixture {
  if (
    fixture.schemaVersion !== QUALITY_NARRATIVE_EVAL_FIXTURE_SCHEMA_VERSION ||
    !["site_builder.qa_summarize", "site_builder.seo_review"].includes(
      fixture.taskId,
    )
  ) {
    throw new Error("quality narrative evaluation fixture is invalid");
  }
  assertSeoReportBindings(fixture);
  const allFindings = buildQualityNarrativeFindingIndex(
    fixture.evaluation,
    fixture.artifactSet,
  );
  const partitioned = partitionQualityNarrativeFindings(allFindings);
  const findings =
    fixture.taskId === "site_builder.qa_summarize"
      ? partitioned.qa
      : partitioned.seo;
  if (findings.length === 0) {
    throw new Error(
      "quality narrative evaluation fixture has no task findings",
    );
  }
  if (
    fixture.taskId === "site_builder.seo_review" &&
    findings.some(
      (finding) =>
        !fixture.seoReports.some(
          (report) =>
            report.artifactId === finding.evidenceArtifactId &&
            report.target.locale === finding.target.locale &&
            report.target.pageId === finding.target.pageId,
        ),
    )
  ) {
    throw new Error(
      "quality narrative SEO finding is not bound to its report artifact",
    );
  }
  return deepFreeze({
    fixture,
    input: qualityNarrativeTaskInput(
      fixture.taskId,
      fixture.evaluation,
      fixture.artifactSet,
      findings,
      fixture.seoReports,
    ),
  });
}

export function evaluateQualityNarrativeOutput(
  prepared: PreparedQualityNarrativeEvalFixture,
  output: QualityNarrativeTaskOutputV1,
): QualityNarrativeEvaluationOutcome {
  validateQualityNarrativeTaskOutput(prepared.input, output);
  return {
    exactDeterministicOutput:
      canonicalQualityNarrativeJson(output) ===
      canonicalQualityNarrativeJson(
        deterministicQualityNarrativeOutput(prepared.input),
      ),
    rejectedFindingIds: [],
  };
}
