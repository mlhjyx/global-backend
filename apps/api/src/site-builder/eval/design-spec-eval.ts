import { createHash } from "node:crypto";

import {
  DESIGN_SPEC_TASK,
  type AuthoritativeArchetype,
  type DesignBriefCandidateSummary,
  type DesignSpecTaskInput,
  type DesignSpecTaskOutput,
} from "../design/design-brief-producer";
import { STATIC_DESIGN_CATALOG_V2 } from "../design/catalog";

export const DESIGN_SPEC_EVAL_FIXTURE_SCHEMA_VERSION =
  "site-builder-design-spec-eval-fixture/v1" as const;
export const DESIGN_SPEC_EVALUATOR_VERSION =
  "site-builder-design-spec-evaluator/2026-07-30-v1" as const;
export const DESIGN_SPEC_ROUTE_VALIDATION_VERSION =
  "site-builder-design-spec-route-validation/2026-07-30-v1" as const;
export const DESIGN_SPEC_PROMPT_VERSION =
  "site-builder-design-spec-prompt/2026-07-30-v1" as const;

export const DESIGN_SPEC_EVALUATOR_RUBRIC = Object.freeze({
  closedOutputShape: true,
  suppliedCandidateOnly: true,
  deterministicCatalogBaseline: true,
  catalogReferenceScope: "selected_candidate",
  numericClaimScope: "selected_candidate_summary",
  proseIsNonAuthoritative: true,
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
  referencedUnselectedCatalogIds: string[];
  contradictedMetricClaims: string[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function candidateId(summary: Omit<DesignBriefCandidateSummary, "id">): string {
  const blueprints = Object.entries(summary.blueprintIds)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pageKey, id]) => `${pageKey}=${id}`)
    .join(",");
  return [
    summary.familyId,
    summary.stylePresetId,
    summary.demoVisualPackId,
    blueprints,
  ].join(":");
}

function sharedArchetype(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
): AuthoritativeArchetype {
  return family.compatibleArchetypes.includes("equipment-supplier")
    ? "equipment-supplier"
    : "custom-oem";
}

function selectedGoldenBlueprints(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
  mode: DesignSpecEvalFixture["mode"],
): Record<string, string> {
  if (mode === "sparse") {
    return structuredClone(family.safeFallbackBlueprintIds);
  }
  const pageKeys = Object.keys(family.blueprints).sort();
  const combinations: Record<string, string>[] = [];
  const visit = (index: number, selected: Record<string, string>): void => {
    if (index === pageKeys.length) {
      combinations.push(selected);
      return;
    }
    const pageKey = pageKeys[index]!;
    for (const blueprint of family.blueprints[pageKey]!) {
      visit(index + 1, { ...selected, [pageKey]: blueprint.id });
    }
  };
  visit(0, {});
  const compatible = combinations.filter((selected) => {
    const variants = new Map<string, string>();
    for (const [pageKey, blueprintId] of Object.entries(selected)) {
      const blueprint = family.blueprints[pageKey]!.find(
        (candidate) => candidate.id === blueprintId,
      )!;
      for (const section of blueprint.sections) {
        const previous = variants.get(section.componentType);
        if (previous && previous !== section.variant) return false;
        variants.set(section.componentType, section.variant);
      }
    }
    return true;
  });
  const ranked = compatible.sort((left, right) => {
    const leftDifferences = pageKeys.filter(
      (pageKey) => left[pageKey] !== family.safeFallbackBlueprintIds[pageKey],
    ).length;
    const rightDifferences = pageKeys.filter(
      (pageKey) => right[pageKey] !== family.safeFallbackBlueprintIds[pageKey],
    ).length;
    return (
      rightDifferences - leftDifferences ||
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  });
  if (!ranked[0]) {
    throw new Error(
      `design_spec evaluation blueprint combination invalid: ${family.id}`,
    );
  }
  return ranked[0];
}

function summaryFor(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
  mode: DesignSpecEvalFixture["mode"],
  industryTags: readonly string[],
  preferred: boolean,
): DesignBriefCandidateSummary {
  const stylePresetId =
    family.stylePresetIds[mode === "rich" ? 1 : 0] ?? family.stylePresetIds[0]!;
  const blueprintIds = selectedGoldenBlueprints(
    family,
    preferred ? mode : "sparse",
  );
  const industrySet = new Set(
    industryTags.map((tag) => tag.toLocaleLowerCase("en")),
  );
  const industryMatchCount = family.compatibleIndustries.filter((industry) =>
    industrySet.has(industry.toLocaleLowerCase("en")),
  ).length;
  const summary = {
    familyId: family.id,
    stylePresetId,
    blueprintIds,
    demoVisualPackId: family.demoVisualPackIds[0]!,
    industryMatchCount,
    userAssetCoverage: mode === "rich" ? 1 : 0,
    demoFallbackCount: mode === "rich" ? 0 : family.assetRequirements.length,
  };
  return { id: candidateId(summary), ...summary };
}

function rankDeterministicCandidates(
  candidates: readonly DesignBriefCandidateSummary[],
): DesignBriefCandidateSummary[] {
  return [...candidates].sort(
    (left, right) =>
      right.industryMatchCount - left.industryMatchCount ||
      right.userAssetCoverage - left.userAssetCoverage ||
      left.demoFallbackCount - right.demoFallbackCount ||
      left.id.localeCompare(right.id),
  );
}

function buildFixture(
  family: (typeof STATIC_DESIGN_CATALOG_V2.families)[number],
  fixtureId: string,
): DesignSpecEvalFixture {
  const mode = fixtureId.endsWith("-sparse") ? "sparse" : "rich";
  const archetype = sharedArchetype(family);
  const alternatives = STATIC_DESIGN_CATALOG_V2.families
    .filter(
      (candidate) =>
        candidate.id !== family.id &&
        candidate.compatibleArchetypes.includes(archetype),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 2);
  if (alternatives.length !== 2) {
    throw new Error(
      `design_spec fixture requires two compatible alternatives: ${fixtureId}`,
    );
  }
  const industryTags = [...family.compatibleIndustries];
  const candidates = rankDeterministicCandidates([
    summaryFor(family, mode, industryTags, true),
    ...alternatives.map((candidate) =>
      summaryFor(candidate, mode, industryTags, false),
    ),
  ]);
  const deterministicCandidateId = candidates[0]?.id;
  if (
    !deterministicCandidateId ||
    candidates[0]?.familyId !== family.id ||
    candidates.length !== 3
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
    input: {
      archetype,
      industryTags,
      candidates,
    },
    assertions: {
      deterministicCandidateId,
      suppliedCandidateIds: candidates.map(({ id }) => id),
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
  return candidate.id === candidateId(candidate);
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
    copy.assertions.deterministicCandidateId !== copy.input.candidates[0]?.id
  ) {
    throw new Error(
      `invalid design_spec evaluation fixture: ${copy.fixtureId}`,
    );
  }
  DESIGN_SPEC_TASK.validateOutput?.(copy.input, {
    candidateId: copy.assertions.deterministicCandidateId,
    reasons: [],
    warnings: [],
  });
  return Object.freeze({ fixture: copy, input: copy.input });
}

function catalogIds(): Set<string> {
  return new Set(
    STATIC_DESIGN_CATALOG_V2.families.flatMap((family) => [
      family.id,
      ...family.stylePresetIds,
      ...family.demoVisualPackIds,
      ...Object.values(family.blueprints).flatMap((blueprints) =>
        blueprints.map(({ id }) => id),
      ),
    ]),
  );
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentioned(text: string, value: string): boolean {
  return new RegExp(
    `(^|[^a-z0-9_-])${escaped(value)}([^a-z0-9_-]|$)`,
    "i",
  ).test(text);
}

export function evaluateDesignSpecOutput(
  prepared: PreparedDesignSpecEvalFixture,
  output: DesignSpecTaskOutput,
): DesignSpecEvaluationOutcome {
  DESIGN_SPEC_TASK.validateOutput?.(prepared.input, output);
  const selected = prepared.input.candidates.find(
    ({ id }) => id === output.candidateId,
  )!;
  const prose = [...output.reasons, ...output.warnings].join("\n");
  const allowedCatalogIds = new Set([
    selected.id,
    selected.familyId,
    selected.stylePresetId,
    selected.demoVisualPackId,
    ...Object.values(selected.blueprintIds),
  ]);
  const referencedUnselectedCatalogIds = [
    ...new Set([
      ...catalogIds(),
      ...prepared.input.candidates.map(({ id }) => id),
    ]),
  ]
    .filter((id) => !allowedCatalogIds.has(id) && mentioned(prose, id))
    .sort();
  const contradictedMetricClaims: string[] = [];
  const metricClaims = [
    ["industryMatchCount", selected.industryMatchCount],
    ["userAssetCoverage", selected.userAssetCoverage],
    ["demoFallbackCount", selected.demoFallbackCount],
  ] as const;
  for (const [name, expected] of metricClaims) {
    const match = prose.match(
      new RegExp(`${name}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
    );
    if (match && Number(match[1]) !== expected) {
      contradictedMetricClaims.push(name);
    }
  }
  return {
    selectedDeterministicCandidate:
      output.candidateId ===
      prepared.fixture.assertions.deterministicCandidateId,
    referencedUnselectedCatalogIds,
    contradictedMetricClaims,
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
