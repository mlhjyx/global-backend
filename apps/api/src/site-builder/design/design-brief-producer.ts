import { createHash } from "node:crypto";
import {
  DESIGN_BRIEF_V2_SCHEMA_VERSION,
  demoVisualPackV2Digest,
  designStylePresetV2Digest,
  designTemplateFamilyV2Digest,
  finalizeDesignBriefV2,
  validateDesignBriefV2,
  validateDesignBriefV2AgainstCatalog,
  DesignCatalogV2ContractError,
  type DemoVisualPackV2,
  type DesignBriefV2,
  type DesignCatalogV2,
  type DesignStylePresetV2,
  type SiteSpecComponentType,
  type SiteSpecStylePreset,
  type TemplateFamilyV2,
} from "@global/contracts";
import type { ModelGateway } from "../../model-gateway/model-gateway";
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
} from "../site-build-cost-ledger";
import type { SiteBuilderTaskDefinition } from "../agents/ai-task";
import { runAiTask } from "../agents/ai-task";
import { STATIC_DESIGN_CATALOG_V2 } from "./catalog";

export const DESIGN_SPEC_INPUT_VERSION = "site-builder-design-spec-input/v1";
export const DESIGN_SPEC_TASK_ID = "site_builder.design_spec";
export const M1_E_A_COMPONENT_LIBRARY_VERSION = "m1-e-a/55-qualified";

export type DesignAssetKind =
  "logo" | "product_image" | "factory_image" | "cert" | "doc" | "video";

export interface AssetCapabilitySummary {
  assets: Array<{
    assetId: string;
    kind: DesignAssetKind;
    status: "ready" | "pending" | "failed";
  }>;
}

export interface DesignSpecInputV1 {
  schemaVersion: typeof DESIGN_SPEC_INPUT_VERSION;
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  brandProfile?: {
    industryTags: string[];
    businessType?: string;
    summary?: string;
    frozenFactCount: number;
  };
  frozenIntake: Record<string, unknown>;
  assetCapabilities: AssetCapabilitySummary;
  locales: string[];
  /** Renderer preset lock supplied by a full-site build. */
  stylePreset?: SiteSpecStylePreset;
  catalogDigest: string;
  componentLibraryVersion: typeof M1_E_A_COMPONENT_LIBRARY_VERSION;
  rendererVersion: string;
}

export type AuthoritativeArchetype =
  | "custom-oem"
  | "ingredient-exporter"
  | "b2b-service"
  | "equipment-supplier"
  | "industrial-manufacturer";

export type DesignBriefProducerErrorCode =
  | "DESIGN_STYLE_PRESET_INCOMPATIBLE"
  | "DESIGN_BRIEF_NO_CANDIDATE"
  | "DESIGN_BRIEF_CANCELLED"
  | "DESIGN_BRIEF_REPLAY_INVALID";

export class DesignBriefProducerError extends Error {
  constructor(
    readonly code: DesignBriefProducerErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DesignBriefProducerError";
  }
}

export interface DesignBriefCandidateSummary {
  id: string;
  familyId: string;
  stylePresetId: string;
  blueprintIds: Record<string, string>;
  demoVisualPackId: string;
  industryMatchCount: number;
  userAssetCoverage: number;
  demoFallbackCount: number;
}

export interface DesignSpecTaskInput {
  archetype: AuthoritativeArchetype;
  industryTags: string[];
  candidates: DesignBriefCandidateSummary[];
}

export interface DesignSpecTaskOutput {
  candidateId: string;
  reasons: string[];
  warnings: string[];
}

function validateTaskOutput(
  input: DesignSpecTaskInput,
  output: DesignSpecTaskOutput,
): void {
  if (
    !output ||
    typeof output !== "object" ||
    JSON.stringify(Object.keys(output).sort()) !==
      JSON.stringify(["candidateId", "reasons", "warnings"]) ||
    typeof output.candidateId !== "string" ||
    !Array.isArray(output.reasons) ||
    output.reasons.some((reason) => typeof reason !== "string") ||
    !Array.isArray(output.warnings) ||
    output.warnings.some((warning) => typeof warning !== "string") ||
    !input.candidates.some((candidate) => candidate.id === output.candidateId)
  ) {
    throw new Error("design_spec output must select one frozen candidate id");
  }
}

export const DESIGN_SPEC_TASK: SiteBuilderTaskDefinition<
  DesignSpecTaskInput,
  DesignSpecTaskOutput
> = {
  id: DESIGN_SPEC_TASK_ID,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["archetype", "industryTags", "candidates"],
    properties: {
      archetype: { type: "string" },
      industryTags: { type: "array", items: { type: "string" } },
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "familyId",
            "stylePresetId",
            "blueprintIds",
            "demoVisualPackId",
            "industryMatchCount",
            "userAssetCoverage",
            "demoFallbackCount",
          ],
          properties: {
            id: { type: "string" },
            familyId: { type: "string" },
            stylePresetId: { type: "string" },
            blueprintIds: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            demoVisualPackId: { type: "string" },
            industryMatchCount: { type: "integer", minimum: 0 },
            userAssetCoverage: { type: "number", minimum: 0, maximum: 1 },
            demoFallbackCount: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["candidateId", "reasons", "warnings"],
    properties: {
      candidateId: { type: "string" },
      reasons: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
    },
  },
  system:
    "Select only one supplied design candidate. Never create a family, preset, blueprint, component, variant, asset, or factual claim.",
  buildPrompt: (input) =>
    [
      `Resolved archetype: ${input.archetype}`,
      `Frozen industry tags: ${JSON.stringify(input.industryTags)}`,
      `Legal candidates: ${JSON.stringify(input.candidates)}`,
      "Return only {candidateId,reasons,warnings}. CandidateId must be one supplied id.",
    ].join("\n"),
  validateOutput: validateTaskOutput,
  repairTaskOutput: true,
};

interface Candidate {
  summary: DesignBriefCandidateSummary;
  family: TemplateFamilyV2;
  preset: DesignStylePresetV2;
  pack: DemoVisualPackV2;
}

export interface DesignBriefTaskLedger {
  claimTaskAttempt(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    taskId: string;
  }): Promise<
    | { kind: "completed"; result: Record<string, unknown> }
    | {
        kind: "claimed";
        attempt: { id: string; fenceToken: string };
      }
  >;
  freezeTaskInput<T extends Record<string, unknown>>(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    candidate: T,
  ): Promise<{ inputHash: string; input: T; replayed: boolean }>;
  storeTaskOutput(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    output: Record<string, unknown>,
  ): Promise<void>;
  completeTask(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    result: Record<string, unknown>,
  ): Promise<void>;
  releaseTask(fence: {
    workspaceId: string;
    attemptId: string;
    fenceToken: string;
  }): Promise<void>;
}

export interface DesignBriefProducerDeps {
  ledger: DesignBriefTaskLedger;
  catalog?: DesignCatalogV2;
  gateway?: ModelGateway;
  isCancelled?: () => boolean;
  executeTask?: (
    input: DesignSpecTaskInput,
    context: {
      workspaceId: string;
      buildRunId: string;
      siteId: string;
      taskAttemptId: string;
      fenceToken: string;
    },
  ) => Promise<DesignSpecTaskOutput>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(textValues);
  }
  return [];
}

function containsAny(value: string, terms: readonly string[]): boolean {
  return terms.some((term) => value.includes(term));
}

export function resolveAuthoritativeArchetype(
  input: Pick<DesignSpecInputV1, "brandProfile" | "frozenIntake">,
): AuthoritativeArchetype {
  const source = input.brandProfile
    ? [
        ...input.brandProfile.industryTags,
        input.brandProfile.businessType ?? "",
        input.brandProfile.summary ?? "",
      ]
    : textValues(input.frozenIntake);
  const text = source.join(" ").toLocaleLowerCase("en");
  if (
    containsAny(text, [
      "oem",
      "private label",
      "contract manufacturing",
      "custom manufacturing",
      "custom fabrication",
      "定制制造",
      "代工",
      "贴牌",
    ])
  ) {
    return "custom-oem";
  }
  if (
    containsAny(text, [
      "food ingredient",
      "ingredient",
      "agriculture",
      "natural material",
      "农产品",
      "农业",
      "食品原料",
      "天然材料",
    ])
  ) {
    return "ingredient-exporter";
  }
  if (
    containsAny(text, [
      "software",
      "saas",
      "consulting",
      "consultancy",
      "integration service",
      "technology service",
      "咨询",
      "软件",
      "集成方案",
    ])
  ) {
    return "b2b-service";
  }
  if (
    containsAny(text, [
      "distributor",
      "distribution",
      "catalog supplier",
      "equipment supplier",
      "设备供应",
      "分销",
      "目录",
    ])
  ) {
    return "equipment-supplier";
  }
  return "industrial-manufacturer";
}

export function mapAssetCapabilitiesToRoles(
  summary: AssetCapabilitySummary,
): string[] {
  const roles = new Set<string>();
  for (const asset of summary.assets) {
    if (asset.status !== "ready") continue;
    if (asset.kind === "logo") roles.add("logo");
    if (asset.kind === "product_image") roles.add("generic-product");
    if (asset.kind === "factory_image") {
      roles.add("hero");
      roles.add("generic-process");
    }
    if (asset.kind === "cert") roles.add("evidence");
  }
  return [...roles].sort();
}

function cartesianBlueprints(
  family: TemplateFamilyV2,
): Array<Record<string, string>> {
  const entries = Object.entries(family.blueprints).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  let combinations: Array<Record<string, string>> = [{}];
  for (const [pageKey, alternatives] of entries) {
    combinations = combinations.flatMap((current) =>
      alternatives.map((blueprint) => ({
        ...current,
        [pageKey]: blueprint.id,
      })),
    );
  }
  return combinations;
}

function selectedSections(
  family: TemplateFamilyV2,
  blueprintIds: Record<string, string>,
) {
  return Object.entries(blueprintIds).flatMap(([pageKey, blueprintId]) => {
    return (
      family.blueprints[pageKey]?.find(
        (blueprint) => blueprint.id === blueprintId,
      )?.sections ?? []
    );
  });
}

function candidateId(
  family: TemplateFamilyV2,
  preset: DesignStylePresetV2,
  pack: DemoVisualPackV2,
  blueprintIds: Record<string, string>,
): string {
  const blueprints = Object.entries(blueprintIds)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pageKey, id]) => `${pageKey}=${id}`)
    .join(",");
  return `${family.id}:${preset.id}:${pack.id}:${blueprints}`;
}

function candidateLexicalKey(candidate: Candidate): string {
  const blueprints = Object.values(candidate.summary.blueprintIds)
    .sort()
    .join(":");
  return `${candidate.family.id}:${blueprints}`;
}

function rankCandidates(
  candidates: Candidate[],
  variationSeed: string,
): Candidate[] {
  const ordered = [...candidates].sort((left, right) => {
    return (
      right.summary.industryMatchCount - left.summary.industryMatchCount ||
      right.summary.userAssetCoverage - left.summary.userAssetCoverage ||
      left.summary.demoFallbackCount - right.summary.demoFallbackCount ||
      candidateLexicalKey(left).localeCompare(candidateLexicalKey(right))
    );
  });
  const result: Candidate[] = [];
  for (let index = 0; index < ordered.length;) {
    const first = ordered[index];
    const tied: Candidate[] = [];
    while (
      index < ordered.length &&
      ordered[index].summary.industryMatchCount ===
        first.summary.industryMatchCount &&
      ordered[index].summary.userAssetCoverage ===
        first.summary.userAssetCoverage &&
      ordered[index].summary.demoFallbackCount ===
        first.summary.demoFallbackCount &&
      candidateLexicalKey(ordered[index]) === candidateLexicalKey(first)
    ) {
      tied.push(ordered[index]);
      index += 1;
    }
    tied.sort((left, right) => left.summary.id.localeCompare(right.summary.id));
    const offset =
      tied.length === 1
        ? 0
        : Number.parseInt(
            hash(`${variationSeed}:${first.summary.id}`).slice(0, 8),
            16,
          ) % tied.length;
    result.push(...tied.slice(offset), ...tied.slice(0, offset));
  }
  return result;
}

function buildCandidates(
  catalog: DesignCatalogV2,
  input: DesignSpecInputV1,
  archetype: AuthoritativeArchetype,
  variationSeed: string,
): Candidate[] {
  const tenantRoles = mapAssetCapabilitiesToRoles(input.assetCapabilities);
  const tenantRoleSet = new Set(tenantRoles);
  const industryTags = new Set(
    (input.brandProfile?.industryTags ?? textValues(input.frozenIntake)).map(
      (tag) => tag.toLocaleLowerCase("en"),
    ),
  );
  let styleLockSeen = input.stylePreset === undefined;
  const candidates: Candidate[] = [];

  for (const family of catalog.families) {
    if (
      family.status !== "approved" ||
      !family.compatibleArchetypes.includes(archetype)
    ) {
      continue;
    }
    const presets = catalog.stylePresets.filter(
      (preset) =>
        preset.status === "approved" &&
        family.stylePresetIds.includes(preset.id) &&
        (input.stylePreset === undefined ||
          preset.rendererPresetId === input.stylePreset),
    );
    if (presets.length > 0) styleLockSeen = true;
    const packs = catalog.demoVisualPacks.filter(
      (pack) =>
        pack.status === "approved" &&
        family.demoVisualPackIds.includes(pack.id) &&
        pack.compatibleFamilyIds.includes(family.id),
    );
    for (const preset of presets) {
      for (const pack of packs) {
        const packRoles = new Set(pack.assets.map((asset) => asset.role));
        for (const blueprintIds of cartesianBlueprints(family)) {
          const sections = selectedSections(family, blueprintIds);
          const requiredRoles = new Set([
            ...family.assetRequirements,
            ...sections.flatMap((section) => section.assetRoles),
          ]);
          if (
            [...requiredRoles].some(
              (role) => !tenantRoleSet.has(role) && !packRoles.has(role),
            )
          ) {
            continue;
          }
          const coveredByTenant = [...requiredRoles].filter((role) =>
            tenantRoleSet.has(role),
          ).length;
          const fallbackCount = [...requiredRoles].filter(
            (role) => !tenantRoleSet.has(role),
          ).length;
          const industryMatchCount = family.compatibleIndustries.filter(
            (industry) => industryTags.has(industry.toLocaleLowerCase("en")),
          ).length;
          const summary: DesignBriefCandidateSummary = {
            id: candidateId(family, preset, pack, blueprintIds),
            familyId: family.id,
            stylePresetId: preset.id,
            blueprintIds,
            demoVisualPackId: pack.id,
            industryMatchCount,
            userAssetCoverage:
              requiredRoles.size === 0
                ? 1
                : coveredByTenant / requiredRoles.size,
            demoFallbackCount: fallbackCount,
          };
          candidates.push({ summary, family, preset, pack });
        }
      }
    }
  }
  if (!styleLockSeen) {
    throw new DesignBriefProducerError(
      "DESIGN_STYLE_PRESET_INCOMPATIBLE",
      `renderer preset ${input.stylePreset} is incompatible with approved ${archetype} families`,
    );
  }
  const ranked = rankCandidates(candidates, variationSeed);
  if (ranked.length === 0) {
    throw new DesignBriefProducerError(
      "DESIGN_BRIEF_NO_CANDIDATE",
      `no approved candidate can satisfy archetype ${archetype}`,
    );
  }
  return ranked;
}

function variantSelections(candidate: Candidate) {
  const selections: Partial<Record<SiteSpecComponentType, string>> = {};
  for (const section of selectedSections(
    candidate.family,
    candidate.summary.blueprintIds,
  )) {
    const previous = selections[section.componentType];
    if (previous && previous !== section.variant) {
      throw new DesignBriefProducerError(
        "DESIGN_BRIEF_NO_CANDIDATE",
        `${candidate.summary.id} has conflicting variants for ${section.componentType}`,
      );
    }
    selections[section.componentType] = section.variant;
  }
  return selections;
}

function buildBrief(
  catalog: DesignCatalogV2,
  input: DesignSpecInputV1,
  candidate: Candidate,
  archetype: AuthoritativeArchetype,
  variationSeed: string,
  model: DesignSpecTaskOutput | undefined,
): DesignBriefV2 {
  const userRoles = mapAssetCapabilitiesToRoles(input.assetCapabilities);
  const warnings = [
    ...(model?.warnings ?? []),
    ...(input.brandProfile?.frozenFactCount === 0
      ? ["evidence-bound-sections-must-use-neutral-copy"]
      : []),
    ...(candidate.summary.demoFallbackCount > 0
      ? [`demo-visual-fallback-count:${candidate.summary.demoFallbackCount}`]
      : []),
  ];
  const brief = finalizeDesignBriefV2({
    schemaVersion: DESIGN_BRIEF_V2_SCHEMA_VERSION,
    catalogVersion: catalog.catalogVersion,
    catalogDigest: catalog.digest,
    familyId: candidate.family.id,
    familyVersion: candidate.family.version,
    familyDigest: designTemplateFamilyV2Digest(candidate.family),
    stylePresetId: candidate.preset.id,
    stylePresetVersion: candidate.preset.version,
    stylePresetDigest: designStylePresetV2Digest(candidate.preset),
    blueprintIds: candidate.summary.blueprintIds,
    componentVariantSelections: variantSelections(candidate),
    assetStrategy: {
      availableRoles: userRoles,
      demoVisualPackId: candidate.pack.id,
      demoVisualPackVersion: candidate.pack.version,
      demoVisualPackDigest: demoVisualPackV2Digest(candidate.pack),
      allowGeneratedImages: false,
      allowVideo: false,
    },
    contentBudgets: candidate.family.contentBudgets,
    localePolicy: input.locales,
    motionIntensity: candidate.family.motionPolicy.intensity,
    variationSeed,
    archetype,
    componentLibraryVersion: input.componentLibraryVersion,
    rendererVersion: input.rendererVersion,
    reasons: model?.reasons.length
      ? model.reasons
      : [
          "deterministic-approved-candidate",
          `industry-match-count:${candidate.summary.industryMatchCount}`,
          `user-asset-coverage:${candidate.summary.userAssetCoverage.toFixed(3)}`,
        ],
    warnings,
  });
  validateDesignBriefV2AgainstCatalog(catalog, brief);
  return brief;
}

function isCancellation(error: unknown): boolean {
  return (
    (error instanceof DesignBriefProducerError &&
      error.code === "DESIGN_BRIEF_CANCELLED") ||
    (error instanceof Error &&
      ["CancelledFailure", "CancellationError"].includes(error.name))
  );
}

export interface ProducedDesignBrief {
  taskAttemptId: string;
  designBrief: DesignBriefV2;
}

export class DesignBriefProducer {
  private readonly catalog: DesignCatalogV2;

  constructor(private readonly deps: DesignBriefProducerDeps) {
    this.catalog = deps.catalog ?? STATIC_DESIGN_CATALOG_V2;
  }

  private ensureNotCancelled(): void {
    if (this.deps.isCancelled?.()) {
      throw new DesignBriefProducerError(
        "DESIGN_BRIEF_CANCELLED",
        "build cancellation forbids deterministic fallback",
      );
    }
  }

  private async selectWithModel(
    input: DesignSpecTaskInput,
    context: {
      workspaceId: string;
      buildRunId: string;
      siteId: string;
      taskAttemptId: string;
      fenceToken: string;
    },
  ): Promise<DesignSpecTaskOutput> {
    if (this.deps.executeTask) {
      const output = await this.deps.executeTask(input, context);
      validateTaskOutput(input, output);
      return output;
    }
    if (!this.deps.gateway) {
      throw new Error("design_spec model gateway unavailable");
    }
    return (
      await runAiTask(DESIGN_SPEC_TASK, input, {
        gateway: this.deps.gateway,
        ctx: {
          workspaceId: context.workspaceId,
          runId: context.buildRunId,
          paidCost: {
            siteId: context.siteId,
            taskAttemptId: context.taskAttemptId,
            fenceToken: context.fenceToken,
            scopeKey: "design_spec",
            durableReplayResult: (providerResult) => providerResult,
          },
        },
      })
    ).data;
  }

  async produce(rawInput: DesignSpecInputV1): Promise<ProducedDesignBrief> {
    this.ensureNotCancelled();
    const claim = await this.deps.ledger.claimTaskAttempt({
      workspaceId: rawInput.workspaceId,
      siteId: rawInput.siteId,
      buildRunId: rawInput.buildRunId,
      taskId: DESIGN_SPEC_TASK_ID,
    });
    if (claim.kind === "completed") {
      const taskAttemptId = claim.result.taskAttemptId;
      const designBrief = claim.result.designBrief;
      if (typeof taskAttemptId !== "string") {
        throw new DesignBriefProducerError(
          "DESIGN_BRIEF_REPLAY_INVALID",
          "completed result has no taskAttemptId",
        );
      }
      try {
        const brief = validateDesignBriefV2(designBrief);
        validateDesignBriefV2AgainstCatalog(this.catalog, brief);
        return { taskAttemptId, designBrief: brief };
      } catch {
        throw new DesignBriefProducerError(
          "DESIGN_BRIEF_REPLAY_INVALID",
          "completed result is not a valid brief for the current catalog",
        );
      }
    }

    const fence = {
      workspaceId: rawInput.workspaceId,
      attemptId: claim.attempt.id,
      fenceToken: claim.attempt.fenceToken,
    };
    let completed = false;
    try {
      const frozen = await this.deps.ledger.freezeTaskInput(
        fence,
        rawInput as unknown as Record<string, unknown>,
      );
      const input = frozen.input as unknown as DesignSpecInputV1;
      if (input.catalogDigest !== this.catalog.digest) {
        throw new DesignCatalogV2ContractError(
          "DESIGN_BRIEF_V2_CATALOG_MISMATCH",
          "frozen producer input does not pin the active catalog",
        );
      }
      if (
        input.schemaVersion !== DESIGN_SPEC_INPUT_VERSION ||
        input.componentLibraryVersion !== M1_E_A_COMPONENT_LIBRARY_VERSION ||
        input.locales.length === 0 ||
        new Set(input.locales).size !== input.locales.length
      ) {
        throw new DesignBriefProducerError(
          "DESIGN_BRIEF_NO_CANDIDATE",
          "frozen producer input does not match the active build contract",
        );
      }
      const variationSeed = hash(
        `${input.siteId}${input.buildRunId}${input.catalogDigest}`,
      );
      const archetype = resolveAuthoritativeArchetype(input);
      const candidates = buildCandidates(
        this.catalog,
        input,
        archetype,
        variationSeed,
      );
      const top = candidates.slice(0, 3);
      const taskInput: DesignSpecTaskInput = {
        archetype,
        industryTags: input.brandProfile?.industryTags ?? [],
        candidates: top.map((candidate) => candidate.summary),
      };
      let modelOutput: DesignSpecTaskOutput | undefined;
      try {
        this.ensureNotCancelled();
        modelOutput = await this.selectWithModel(taskInput, {
          workspaceId: input.workspaceId,
          buildRunId: input.buildRunId,
          siteId: input.siteId,
          taskAttemptId: claim.attempt.id,
          fenceToken: claim.attempt.fenceToken,
        });
      } catch (error) {
        this.ensureNotCancelled();
        if (
          error instanceof PaidCallDeniedError ||
          error instanceof PaidOperationUnknownError ||
          isCancellation(error)
        ) {
          throw error;
        }
        modelOutput = undefined;
      }
      const selected =
        candidates.find(
          (candidate) => candidate.summary.id === modelOutput?.candidateId,
        ) ?? candidates[0];
      const designBrief = buildBrief(
        this.catalog,
        input,
        selected,
        archetype,
        variationSeed,
        modelOutput,
      );
      await this.deps.ledger.storeTaskOutput(fence, {
        candidateId: selected.summary.id,
        selectionSource: modelOutput ? "model" : "deterministic",
        designBriefDigest: designBrief.digest,
      });
      const result: ProducedDesignBrief = {
        taskAttemptId: claim.attempt.id,
        designBrief,
      };
      await this.deps.ledger.completeTask(
        fence,
        result as unknown as Record<string, unknown>,
      );
      completed = true;
      return result;
    } finally {
      if (!completed) await this.deps.ledger.releaseTask(fence);
    }
  }
}

export function designSpecInputDigest(input: DesignSpecInputV1): string {
  return hash(stableJson(input));
}
