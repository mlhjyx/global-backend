import {
  DESIGN_BRIEF_V2_SCHEMA_VERSION,
  REPAIR_OPTION_CATALOG_SCHEMA_VERSION,
  finalizeDesignBriefV2,
  repairOptionCatalogDigest,
  validateDesignEvaluationV2,
  validateRepairOptionCatalog,
  validateRepairOptionSelection,
  validateSiteSpecV1_1,
  type DesignBriefV2,
  type DesignCatalogV2,
  type DesignEvaluationV2,
  type DesignEvaluationV2RuleCode,
  type QualityArtifactSetV1,
  type RepairOptionCatalogV1,
  type RepairOptionChangeV1,
  type RepairOptionSelectionV1,
  type SiteSpecComponentType,
  type SiteSpecV1_1,
} from "@global/contracts";
import { Injectable } from "@nestjs/common";
import {
  assembleDeterministically,
  type DeterministicAssemblyInput,
} from "../assembly/controlled-assembly.service";
import { deriveCopySlotDefinitions } from "../assembly/copy-slot-derivation";
import { validateControlledAssembly } from "../assembly/controlled-assembly-validator";
import { releaseSpecDigest } from "../release-artifact";

export interface ClosedRepairContext extends Omit<
  DeterministicAssemblyInput,
  "brief" | "catalog"
> {
  brief: DesignBriefV2;
  catalog: DesignCatalogV2;
  spec: SiteSpecV1_1;
}

export interface ClosedRepairCandidate {
  optionId: string;
  spec: SiteSpecV1_1;
  designBrief: DesignBriefV2;
  change: RepairOptionChangeV1;
}

export interface GeneratedClosedRepairCatalog {
  catalog: RepairOptionCatalogV1;
  candidates: ReadonlyMap<string, ClosedRepairCandidate>;
}

function repairedBrief(
  context: ClosedRepairContext,
  pageId: string,
  blueprintId: string,
): DesignBriefV2 {
  const family = context.catalog.families.find(
    (candidate) => candidate.id === context.brief.familyId,
  );
  const blueprint = family?.blueprints[pageId]?.find(
    (candidate) => candidate.id === blueprintId,
  );
  if (!family || family.status !== "approved" || !blueprint) {
    throw new Error("QUALITY_REPAIR_BLUEPRINT_NOT_APPROVED");
  }
  const blueprintIds = {
    ...context.brief.blueprintIds,
    [pageId]: blueprintId,
  };
  const variants = new Map<SiteSpecComponentType, string>();
  for (const [candidatePageId, candidateBlueprintId] of Object.entries(
    blueprintIds,
  )) {
    const selected = family.blueprints[candidatePageId]?.find(
      (candidate) => candidate.id === candidateBlueprintId,
    );
    if (!selected) throw new Error("QUALITY_REPAIR_BLUEPRINT_NOT_APPROVED");
    for (const section of selected.sections) {
      const previous = variants.get(section.componentType);
      if (previous && previous !== section.variant) {
        throw new Error("QUALITY_REPAIR_VARIANT_CONFLICT");
      }
      variants.set(section.componentType, section.variant);
    }
  }
  const { digest: _digest, ...draft } = context.brief;
  return finalizeDesignBriefV2({
    ...draft,
    schemaVersion: DESIGN_BRIEF_V2_SCHEMA_VERSION,
    blueprintIds,
    componentVariantSelections: Object.fromEntries(variants),
  });
}

function candidateForBlueprint(
  context: ClosedRepairContext,
  pageId: string,
  blueprintId: string,
): ClosedRepairCandidate {
  const designBrief = repairedBrief(context, pageId, blueprintId);
  const deterministic = assembleDeterministically({
    ...context,
    brief: designBrief,
    catalog: context.catalog,
  });
  const replacement = deterministic.pages.find((page) => page.id === pageId);
  if (!replacement) throw new Error("QUALITY_REPAIR_PAGE_MISSING");
  const spec = validateSiteSpecV1_1({
    ...structuredClone(context.spec),
    pages: context.spec.pages.map((page) =>
      page.id === pageId ? replacement : page,
    ),
  });
  const findings = validateControlledAssembly({
    spec,
    brief: designBrief,
    catalog: context.catalog,
    claimSnapshot: context.claimSnapshot,
    copySlots: deriveCopySlotDefinitions({
      brief: designBrief,
      catalog: context.catalog,
      templates: context.templates,
    }),
  });
  if (findings.length > 0) {
    throw new Error(
      `QUALITY_REPAIR_CANDIDATE_INVALID: ${findings
        .map((finding) => `${finding.layer}/${finding.code}`)
        .join(",")}`,
    );
  }
  return {
    optionId: `blueprint:${pageId}:${blueprintId}`,
    spec,
    designBrief,
    change: {
      kind: "approved_blueprint",
      pageId,
      blueprintId,
    },
  };
}

function candidateForItemCount(
  context: ClosedRepairContext,
  pageIndex: number,
  sectionIndex: number,
): ClosedRepairCandidate | null {
  const page = context.spec.pages[pageIndex];
  const block = page?.puck.content[sectionIndex];
  const family = context.catalog.families.find(
    (candidate) => candidate.id === context.brief.familyId,
  );
  const blueprint = family?.blueprints[page?.id ?? ""]?.find(
    (candidate) => candidate.id === context.brief.blueprintIds[page?.id ?? ""],
  );
  const section = blueprint?.sections[sectionIndex];
  if (!page || !block || !section) return null;
  const dynamic = Object.entries(block.props).find(
    ([, value]) => Array.isArray(value) && value.length > 1,
  ) as [string, unknown[]] | undefined;
  if (!dynamic) return null;
  const [property, values] = dynamic;
  const itemCount = values.length - 1;
  if (itemCount > 12) return null;
  const spec = structuredClone(context.spec);
  const candidateBlock = spec.pages[pageIndex]!.puck.content[sectionIndex]!;
  candidateBlock.props = {
    ...candidateBlock.props,
    [property]: structuredClone(values.slice(0, itemCount)),
  };
  const validated = validateSiteSpecV1_1(spec);
  const findings = validateControlledAssembly({
    spec: validated,
    brief: context.brief,
    catalog: context.catalog,
    claimSnapshot: context.claimSnapshot,
    copySlots: deriveCopySlotDefinitions({
      brief: context.brief,
      catalog: context.catalog,
      templates: context.templates,
    }),
  });
  if (findings.length > 0) return null;
  return {
    optionId: `items:${page.id}:${section.id}:${itemCount}`,
    spec: validated,
    designBrief: context.brief,
    change: {
      kind: "bounded_item_count",
      pageId: page.id,
      sectionId: section.id,
      itemCount,
    },
  };
}

const BLUEPRINT_REPAIRABLE_RULES = new Set<DesignEvaluationV2RuleCode>([
  "H1_COUNT_INVALID",
  "HORIZONTAL_OVERFLOW",
  "TEXT_CLIPPED",
  "ELEMENT_OVERLAP",
  "CTA_UNREACHABLE",
  "GENERICNESS_STRUCTURE_REPEAT",
  "GENERICNESS_CARD_DENSITY",
  "GENERICNESS_HERO_REPEAT",
  "AESTHETIC_HIERARCHY",
  "AESTHETIC_CONSISTENCY",
  "AESTHETIC_SPACING",
  "AESTHETIC_CONTRAST",
  "AESTHETIC_IMAGERY",
  "AESTHETIC_MOBILE_COMPOSITION",
  "AESTHETIC_CTA_CLARITY",
  "AESTHETIC_CREDIBILITY",
  "AESTHETIC_ORIGINALITY",
]);
const ITEM_COUNT_REPAIRABLE_RULES = new Set<DesignEvaluationV2RuleCode>([
  "HORIZONTAL_OVERFLOW",
  "TEXT_CLIPPED",
  "ELEMENT_OVERLAP",
  "GENERICNESS_CARD_DENSITY",
  "AESTHETIC_CONSISTENCY",
  "AESTHETIC_SPACING",
  "AESTHETIC_MOBILE_COMPOSITION",
  "AESTHETIC_ORIGINALITY",
]);

function addressedRules(
  evaluation: DesignEvaluationV2,
  change: RepairOptionChangeV1,
) {
  const allowed =
    change.kind === "approved_blueprint"
      ? BLUEPRINT_REPAIRABLE_RULES
      : change.kind === "bounded_item_count"
        ? ITEM_COUNT_REPAIRABLE_RULES
        : new Set<DesignEvaluationV2RuleCode>();
  return [
    ...evaluation.deterministic.hardFailures,
    ...evaluation.deterministic.findings,
    ...evaluation.aesthetic.findings,
  ]
    .map((finding) => finding.ruleCode)
    .filter((code) => allowed.has(code))
    .filter((code, index, values) => values.indexOf(code) === index)
    .slice(0, 16);
}

/**
 * Generates only server-computed, fully validated alternatives. The returned
 * candidate map is internal; the model-visible contract is only `catalog`.
 */
@Injectable()
export class ClosedRepairService {
  generateCatalog(input: {
    context: ClosedRepairContext;
    evaluation: DesignEvaluationV2;
    artifactSet: QualityArtifactSetV1;
  }): GeneratedClosedRepairCatalog {
    const { context } = input;
    const evaluation = validateDesignEvaluationV2(
      input.evaluation,
      input.artifactSet,
    );
    const candidateSpecDigest = releaseSpecDigest(context.spec);
    if (
      evaluation.candidateSpecDigest !== candidateSpecDigest ||
      evaluation.designBriefDigest !== context.brief.digest ||
      evaluation.round > 2 ||
      context.brief.catalogDigest !== context.catalog.digest ||
      context.spec.site.familyId !== context.brief.familyId
    ) {
      throw new Error("QUALITY_REPAIR_CANDIDATE_FENCED");
    }
    const family = context.catalog.families.find(
      (candidate) => candidate.id === context.brief.familyId,
    );
    if (!family || family.status !== "approved") {
      throw new Error("QUALITY_REPAIR_FAMILY_NOT_APPROVED");
    }

    const candidates: ClosedRepairCandidate[] = [];
    const seenDigests = new Set<string>();
    const rejected: string[] = [];
    for (const [pageIndex, page] of context.spec.pages.entries()) {
      for (const sectionIndex of page.puck.content.keys()) {
        const candidate = candidateForItemCount(
          context,
          pageIndex,
          sectionIndex,
        );
        if (!candidate) continue;
        const digest = releaseSpecDigest(candidate.spec);
        if (digest === candidateSpecDigest || seenDigests.has(digest)) continue;
        seenDigests.add(digest);
        candidates.push(candidate);
      }
    }
    for (const pageId of Object.keys(context.brief.blueprintIds).sort()) {
      for (const blueprint of [...(family.blueprints[pageId] ?? [])].sort(
        (left, right) => {
          const leftSafe =
            family.safeFallbackBlueprintIds[pageId] === left.id ? 0 : 1;
          const rightSafe =
            family.safeFallbackBlueprintIds[pageId] === right.id ? 0 : 1;
          return leftSafe - rightSafe || left.id.localeCompare(right.id);
        },
      )) {
        if (blueprint.id === context.brief.blueprintIds[pageId]) continue;
        try {
          const candidate = candidateForBlueprint(
            context,
            pageId,
            blueprint.id,
          );
          const digest = releaseSpecDigest(candidate.spec);
          if (digest === candidateSpecDigest || seenDigests.has(digest)) {
            continue;
          }
          seenDigests.add(digest);
          candidates.push(candidate);
        } catch (error) {
          // An incompatible alternative never enters the model-visible catalog.
          rejected.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (candidates.length === 0) {
      throw new Error(
        `QUALITY_REPAIR_OPTION_UNAVAILABLE: ${rejected
          .slice(0, 4)
          .map((message) => message.slice(0, 256))
          .join("; ")}`,
      );
    }
    const applicableCandidates = candidates
      .map((candidate) => ({
        candidate,
        addresses: addressedRules(evaluation, candidate.change),
      }))
      .filter(({ addresses }) => addresses.length > 0)
      .slice(0, 32);
    if (applicableCandidates.length === 0) {
      throw new Error("QUALITY_REPAIR_OPTION_UNAVAILABLE");
    }
    const options = applicableCandidates.map(
      ({ candidate, addresses }, index) => ({
        optionId: candidate.optionId,
        rank: index + 1,
        addresses,
        resultSpecDigest: releaseSpecDigest(candidate.spec),
        change: candidate.change,
      }),
    );
    const draft = {
      schemaVersion: REPAIR_OPTION_CATALOG_SCHEMA_VERSION,
      candidateSpecDigest,
      designBriefDigest: context.brief.digest,
      artifactSetDigest: input.artifactSet.artifactSetDigest,
      designCatalogDigest: context.catalog.digest,
      familyId: context.brief.familyId,
      round: evaluation.round as 0 | 1 | 2,
      options,
    };
    const catalog = validateRepairOptionCatalog({
      ...draft,
      catalogDigest: repairOptionCatalogDigest(draft),
    });
    return {
      catalog,
      candidates: new Map(
        applicableCandidates.map(({ candidate }) => [
          candidate.optionId,
          candidate,
        ]),
      ),
    };
  }

  applySelection(input: {
    generated: GeneratedClosedRepairCatalog;
    selection: RepairOptionSelectionV1;
    expectedArtifactSetDigest: string;
  }): ClosedRepairCandidate {
    const selection = validateRepairOptionSelection(
      input.selection,
      input.generated.catalog,
      input.expectedArtifactSetDigest,
    );
    const candidate = input.generated.candidates.get(selection.optionId);
    const option = input.generated.catalog.options.find(
      (entry) => entry.optionId === selection.optionId,
    );
    if (
      !candidate ||
      !option ||
      releaseSpecDigest(candidate.spec) !== option.resultSpecDigest
    ) {
      throw new Error("QUALITY_REPAIR_RESULT_FENCED");
    }
    return structuredClone(candidate);
  }
}
