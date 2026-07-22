import { hasOnlyKeys, isNonBlankString, isRecord } from "./design-integrity";

export const DESIGN_EVALUATION_SCHEMA_VERSION =
  "site-builder-design-evaluation/v1" as const;

export interface DesignEvaluation {
  schemaVersion: typeof DESIGN_EVALUATION_SCHEMA_VERSION;
  overallScore: number;
  dimensions: Record<
    | "hierarchy"
    | "consistency"
    | "spacing"
    | "contrast"
    | "imagery"
    | "mobileComposition"
    | "ctaClarity"
    | "credibility"
    | "originality",
    number
  >;
  hardFailures: Array<{
    code: string;
    page: string;
    breakpoint: 375 | 768 | 1440;
    selector?: string;
    evidencePath: string;
  }>;
  findings: Array<{
    id: string;
    severity: "blocker" | "major" | "minor";
    target: string;
    rule: string;
    suggestedPatch: object;
  }>;
}

const DIMENSIONS = [
  "hierarchy",
  "consistency",
  "spacing",
  "contrast",
  "imagery",
  "mobileComposition",
  "ctaClarity",
  "credibility",
  "originality",
] as const;

function score(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function validateDesignEvaluation(value: unknown): DesignEvaluation {
  const evaluation = isRecord(value) ? value : null;
  const dimensions = evaluation && isRecord(evaluation.dimensions) ? evaluation.dimensions : null;
  const validDimensions =
    !!dimensions &&
    hasOnlyKeys(dimensions, DIMENSIONS) &&
    DIMENSIONS.every((dimension) => score(dimensions[dimension]));
  const validFailures =
    !!evaluation &&
    Array.isArray(evaluation.hardFailures) &&
    evaluation.hardFailures.every((item) => {
      const failure = isRecord(item) ? item : null;
      return (
        !!failure &&
        hasOnlyKeys(failure, ["code", "page", "breakpoint", "selector", "evidencePath"]) &&
        isNonBlankString(failure.code) &&
        isNonBlankString(failure.page) &&
        [375, 768, 1440].includes(failure.breakpoint as number) &&
        (failure.selector === undefined || isNonBlankString(failure.selector)) &&
        isNonBlankString(failure.evidencePath)
      );
    });
  const validFindings =
    !!evaluation &&
    Array.isArray(evaluation.findings) &&
    evaluation.findings.every((item) => {
      const finding = isRecord(item) ? item : null;
      return (
        !!finding &&
        hasOnlyKeys(finding, ["id", "severity", "target", "rule", "suggestedPatch"]) &&
        isNonBlankString(finding.id) &&
        ["blocker", "major", "minor"].includes(String(finding.severity)) &&
        isNonBlankString(finding.target) &&
        isNonBlankString(finding.rule) &&
        isRecord(finding.suggestedPatch)
      );
    });
  if (
    !evaluation ||
    !hasOnlyKeys(evaluation, ["schemaVersion", "overallScore", "dimensions", "hardFailures", "findings"]) ||
    evaluation.schemaVersion !== DESIGN_EVALUATION_SCHEMA_VERSION ||
    !score(evaluation.overallScore) ||
    !validDimensions ||
    !validFailures ||
    !validFindings
  ) {
    throw new Error("DESIGN_EVALUATION_INVALID");
  }
  return evaluation as unknown as DesignEvaluation;
}

export function hasDesignEvaluationHardFailures(evaluation: DesignEvaluation): boolean {
  return evaluation.hardFailures.length > 0;
}
