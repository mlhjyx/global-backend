import { createHash } from "node:crypto";

import {
  DESIGN_SPEC_TASK,
  DESIGN_SPEC_INPUT_VERSION,
  M1_E_A_COMPONENT_LIBRARY_VERSION,
  buildDesignSpecTaskInputFromProductionCandidates,
  type AuthoritativeArchetype,
  type DesignBriefCandidateSummary,
  type DesignSpecInputV1,
  type DesignSpecTaskInput,
  type DesignSpecTaskOutput,
} from "../design/design-brief-producer";
import { STATIC_DESIGN_CATALOG_V2 } from "../design/catalog";

const CAPTURED_DESIGN_SPEC_VALIDATE_OUTPUT = (() => {
  const validator = DESIGN_SPEC_TASK.validateOutput;
  if (!validator) {
    throw new Error("design_spec output validator is unavailable");
  }
  return validator;
})();

export const DESIGN_SPEC_EVAL_FIXTURE_SCHEMA_VERSION =
  "site-builder-design-spec-eval-fixture/v2" as const;
export const DESIGN_SPEC_EVALUATOR_VERSION =
  "site-builder-design-spec-evaluator/2026-08-01-v4" as const;
export const DESIGN_SPEC_ROUTE_VALIDATION_VERSION =
  "site-builder-design-spec-route-validation/2026-07-30-v2" as const;
export const DESIGN_SPEC_PROMPT_VERSION =
  "site-builder-design-spec-prompt/2026-07-30-v2" as const;

export const DESIGN_SPEC_EVALUATOR_RUBRIC = Object.freeze({
  closedOutputShape: true,
  suppliedCandidateOnly: true,
  deterministicCatalogBaseline: true,
  catalogReferenceScope: "selected_candidate",
  numericClaimScope: "selected_candidate_summary",
  explanationContract:
    "closed selectedCandidateId/industryMatchCount/userAssetCoverage/demoFallbackCount claims",
  freeFormProseAllowed: false,
  prohibitedBehavior: Object.freeze([
    "invent_candidate",
    "invent_family",
    "invent_style_preset",
    "invent_blueprint",
    "invent_demo_visual_pack",
    "contradict_frozen_candidate_metrics",
  ]),
} as const);

export interface DesignSpecEvalFixture {
  schemaVersion: typeof DESIGN_SPEC_EVAL_FIXTURE_SCHEMA_VERSION;
  fixtureId: string;
  familyId: string;
  mode: "sparse" | "rich";
  productionInput: DesignSpecInputV1;
  input: DesignSpecTaskInput;
  assertions: {
    deterministicCandidateId: string;
    suppliedCandidateIds: string[];
  };
}

export interface PreparedDesignSpecEvalFixture {
  fixture: DesignSpecEvalFixture;
  input: DesignSpecTaskInput;
}

export interface DesignSpecEvaluationOutcome {
  selectedDeterministicCandidate: boolean;
  referencedForbiddenCatalogIdentifiers: string[];
  contradictedMetricClaims: string[];
  invalidExplanationClaims: string[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sharedArchetype(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
): AuthoritativeArchetype {
  return family.compatibleArchetypes.includes("equipment-supplier")
    ? "equipment-supplier"
    : "custom-oem";
}

function syntheticProductionInput(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
  mode: DesignSpecEvalFixture["mode"],
  fixtureId: string,
): DesignSpecInputV1 {
  const richAssets: DesignSpecInputV1["assetCapabilities"]["assets"] = [
    { assetId: `${fixtureId}-logo`, kind: "logo", status: "ready" },
    {
      assetId: `${fixtureId}-product`,
      kind: "product_image",
      status: "ready",
    },
    {
      assetId: `${fixtureId}-factory`,
      kind: "factory_image",
      status: "ready",
    },
    { assetId: `${fixtureId}-cert`, kind: "cert", status: "ready" },
  ];
  return {
    schemaVersion: DESIGN_SPEC_INPUT_VERSION,
    workspaceId: `eval-${family.id}`,
    siteId: `eval-${fixtureId}`,
    buildRunId: `eval-${fixtureId}-run`,
    brandProfile: {
      industryTags: [...family.compatibleIndustries],
      businessType: sharedArchetype(family).replaceAll("-", " "),
      frozenFactCount: mode === "rich" ? 4 : 0,
    },
    frozenIntake: {
      synthetic: true,
      familyId: family.id,
      fixtureId,
    },
    assetCapabilities: {
      assets: mode === "rich" ? richAssets : [],
    },
    locales: ["en", "de"],
    catalogDigest: STATIC_DESIGN_CATALOG_V2.digest,
    componentLibraryVersion: M1_E_A_COMPONENT_LIBRARY_VERSION,
    rendererVersion: "design-spec-evaluation-synthetic/v1",
  };
}

function buildFixture(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
  fixtureId: string,
): DesignSpecEvalFixture {
  const mode = fixtureId.endsWith("-sparse") ? "sparse" : "rich";
  const productionInput = syntheticProductionInput(family, mode, fixtureId);
  const input = buildDesignSpecTaskInputFromProductionCandidates(
    STATIC_DESIGN_CATALOG_V2,
    productionInput,
  );
  const deterministicCandidateId = input.candidates[0]?.id;
  if (
    !deterministicCandidateId ||
    input.candidates[0]?.familyId !== family.id ||
    input.candidates.length !== 3
  ) {
    throw new Error(
      `design_spec deterministic baseline does not select ${family.id}: ${fixtureId}`,
    );
  }
  return {
    schemaVersion: DESIGN_SPEC_EVAL_FIXTURE_SCHEMA_VERSION,
    fixtureId,
    familyId: family.id,
    mode,
    productionInput,
    input,
    assertions: {
      deterministicCandidateId,
      suppliedCandidateIds: input.candidates.map(({ id }) => id),
    },
  };
}

export const DESIGN_SPEC_EVAL_FIXTURES = deepFreeze(
  STATIC_DESIGN_CATALOG_V2.families
    .flatMap((family) =>
      family.goldenFixtureIds.map((fixtureId) =>
        buildFixture(family, fixtureId),
      ),
    )
    .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId)),
);

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function candidateIsCatalogClosed(
  candidate: DesignBriefCandidateSummary,
): boolean {
  if (
    !exactKeys(candidate, [
      "id",
      "familyId",
      "stylePresetId",
      "blueprintIds",
      "demoVisualPackId",
      "industryMatchCount",
      "userAssetCoverage",
      "demoFallbackCount",
    ]) ||
    !Number.isInteger(candidate.industryMatchCount) ||
    candidate.industryMatchCount < 0 ||
    !Number.isFinite(candidate.userAssetCoverage) ||
    candidate.userAssetCoverage < 0 ||
    candidate.userAssetCoverage > 1 ||
    !Number.isInteger(candidate.demoFallbackCount) ||
    candidate.demoFallbackCount < 0
  ) {
    return false;
  }
  const family = STATIC_DESIGN_CATALOG_V2.families.find(
    ({ id }) => id === candidate.familyId,
  );
  if (
    !family ||
    !family.stylePresetIds.includes(candidate.stylePresetId) ||
    !family.demoVisualPackIds.includes(candidate.demoVisualPackId) ||
    Object.keys(candidate.blueprintIds).length !==
      Object.keys(family.blueprints).length
  ) {
    return false;
  }
  for (const [pageKey, blueprintId] of Object.entries(candidate.blueprintIds)) {
    if (!family.blueprints[pageKey]?.some(({ id }) => id === blueprintId)) {
      return false;
    }
  }
  const blueprints = Object.entries(candidate.blueprintIds)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pageKey, id]) => `${pageKey}=${id}`)
    .join(",");
  return (
    candidate.id ===
    `${candidate.familyId}:${candidate.stylePresetId}:${candidate.demoVisualPackId}:${blueprints}`
  );
}

export function prepareDesignSpecEvalFixture(
  fixture: DesignSpecEvalFixture,
): PreparedDesignSpecEvalFixture {
  const copy = structuredClone(fixture);
  if (
    !exactKeys(copy, [
      "schemaVersion",
      "fixtureId",
      "familyId",
      "mode",
      "productionInput",
      "input",
      "assertions",
    ]) ||
    copy.schemaVersion !== DESIGN_SPEC_EVAL_FIXTURE_SCHEMA_VERSION ||
    !copy.fixtureId.endsWith(`-${copy.mode}`) ||
    !exactKeys(copy.input, ["archetype", "industryTags", "candidates"]) ||
    !copy.input.industryTags.every((tag) => typeof tag === "string") ||
    copy.input.candidates.length !== 3 ||
    !copy.input.candidates.every(candidateIsCatalogClosed) ||
    new Set(copy.input.candidates.map(({ id }) => id)).size !== 3 ||
    copy.assertions.suppliedCandidateIds.length !== 3 ||
    JSON.stringify(copy.assertions.suppliedCandidateIds) !==
      JSON.stringify(copy.input.candidates.map(({ id }) => id)) ||
    copy.input.candidates[0]?.familyId !== copy.familyId ||
    copy.assertions.deterministicCandidateId !== copy.input.candidates[0]?.id ||
    JSON.stringify(copy.input) !==
      JSON.stringify(
        buildDesignSpecTaskInputFromProductionCandidates(
          STATIC_DESIGN_CATALOG_V2,
          copy.productionInput,
        ),
      )
  ) {
    throw new Error(
      `invalid design_spec evaluation fixture: ${copy.fixtureId}`,
    );
  }
  CAPTURED_DESIGN_SPEC_VALIDATE_OUTPUT(copy.input, {
    candidateId: copy.assertions.deterministicCandidateId,
    reasons: [],
    warnings: [],
  });
  return Object.freeze({ fixture: copy, input: copy.input });
}

export function selectDesignSpecDeterministicCandidate(
  input: DesignSpecTaskInput,
): DesignBriefCandidateSummary {
  const selected = input.candidates[0];
  if (!selected || !input.candidates.every(candidateIsCatalogClosed)) {
    throw new Error("design_spec deterministic comparator input is invalid");
  }
  return selected;
}

type ExplanationClaimName =
  | "selectedCandidateId"
  | "industryMatchCount"
  | "userAssetCoverage"
  | "demoFallbackCount";

function parseExplanationClaim(
  claim: string,
):
  | { name: ExplanationClaimName; value: string }
  | { name: null; value: string } {
  const match =
    /^(selectedCandidateId|industryMatchCount|userAssetCoverage|demoFallbackCount)=([^\r\n]+)$/.exec(
      claim,
    );
  return match
    ? {
        name: match[1] as ExplanationClaimName,
        value: match[2]!,
      }
    : { name: null, value: claim };
}

export function evaluateDesignSpecOutput(
  prepared: PreparedDesignSpecEvalFixture,
  output: DesignSpecTaskOutput,
): DesignSpecEvaluationOutcome {
  CAPTURED_DESIGN_SPEC_VALIDATE_OUTPUT(prepared.input, output);
  const selected = prepared.input.candidates.find(
    ({ id }) => id === output.candidateId,
  )!;
  const referencedForbiddenCatalogIdentifiers: string[] = [];
  const contradictedMetricClaims: string[] = [];
  const invalidExplanationClaims: string[] = [];
  const expectedMetrics = {
    industryMatchCount: selected.industryMatchCount,
    userAssetCoverage: selected.userAssetCoverage,
    demoFallbackCount: selected.demoFallbackCount,
  } as const;
  const suppliedCandidateIds = new Set(
    prepared.input.candidates.map(({ id }) => id),
  );
  for (const claim of [...output.reasons, ...output.warnings]) {
    const parsed = parseExplanationClaim(claim);
    if (parsed.name === null) {
      invalidExplanationClaims.push(claim);
      continue;
    }
    if (parsed.name === "selectedCandidateId") {
      if (parsed.value !== selected.id) {
        if (suppliedCandidateIds.has(parsed.value)) {
          referencedForbiddenCatalogIdentifiers.push(parsed.value);
        } else {
          invalidExplanationClaims.push(claim);
        }
      }
      continue;
    }
    if (
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(parsed.value) ||
      Number(parsed.value) !== expectedMetrics[parsed.name]
    ) {
      contradictedMetricClaims.push(parsed.name);
    }
  }
  return {
    selectedDeterministicCandidate:
      output.candidateId ===
      prepared.fixture.assertions.deterministicCandidateId,
    referencedForbiddenCatalogIdentifiers: [
      ...new Set(referencedForbiddenCatalogIdentifiers),
    ].sort(),
    contradictedMetricClaims: [...new Set(contradictedMetricClaims)].sort(),
    invalidExplanationClaims: [...new Set(invalidExplanationClaims)].sort(),
  };
}

export function designSpecFixtureFingerprint(fixture: DesignSpecEvalFixture): {
  fixtureSha256: string;
  promptSha256: string;
} {
  const prepared = prepareDesignSpecEvalFixture(fixture);
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return {
    fixtureSha256: digest(canonicalJson(prepared.fixture)),
    promptSha256: digest(DESIGN_SPEC_TASK.buildPrompt(prepared.input)),
  };
}
