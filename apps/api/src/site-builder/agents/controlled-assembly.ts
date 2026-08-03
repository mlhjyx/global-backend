import type { ModelGateway } from "../../model-gateway/model-gateway";
import type { SiteBuildCostLedger } from "../site-build-cost-ledger";
import type { AssemblyFinding } from "../assembly/controlled-assembly-validator";
import type {
  AssemblySelection,
  AssemblySelectionGenerator,
  ControlledAssemblyTaskId,
} from "../assembly/controlled-assembly.service";
import { runAiTask, type SiteBuilderTaskDefinition } from "./ai-task";

export interface ControlledAssemblyTaskInput {
  designBriefDigest: string;
  allowedSectionTargets?: Array<{ pageKey: string; sectionId: string }>;
  allowedCopySlotKeys: string[];
  allowedAssetReferenceIds: string[];
  allowedClaimIds: string[];
  previousCandidateDigest?: string;
  findings: AssemblyFinding[];
}

function closedSelection(
  input: ControlledAssemblyTaskInput,
  value: AssemblySelection,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => key !== "sections") ||
    !Array.isArray(value.sections)
  ) {
    throw new Error("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
  }
  if (input.allowedSectionTargets) {
    const required = new Set(
      input.allowedSectionTargets.map(
        (target) => `${target.pageKey}\0${target.sectionId}`,
      ),
    );
    const selected = new Set(
      value.sections.map(
        (section) => `${section.pageKey}\0${section.sectionId}`,
      ),
    );
    if (
      selected.size !== value.sections.length ||
      selected.size !== required.size ||
      [...required].some((target) => !selected.has(target))
    ) {
      throw new Error("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
    }
  }
  const allowedCopySlotKeys = new Set(input.allowedCopySlotKeys);
  const allowedAssetReferenceIds = new Set(input.allowedAssetReferenceIds);
  const allowedClaimIds = new Set(input.allowedClaimIds);
  for (const section of value.sections) {
    if (
      section.copySlotKeys.some((key) => !allowedCopySlotKeys.has(key)) ||
      section.assetReferenceIds.some(
        (referenceId) => !allowedAssetReferenceIds.has(referenceId),
      ) ||
      section.claimIds.some((claimId) => !allowedClaimIds.has(claimId))
    ) {
      throw new Error("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
    }
  }
}

function definition(
  id: "site_builder.assemble" | "site_builder.assembly_fix",
): SiteBuilderTaskDefinition<ControlledAssemblyTaskInput, AssemblySelection> {
  return {
    id,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "designBriefDigest",
        "allowedCopySlotKeys",
        "allowedAssetReferenceIds",
        "allowedClaimIds",
        "findings",
      ],
      properties: {
        designBriefDigest: { type: "string" },
        allowedSectionTargets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pageKey", "sectionId"],
            properties: {
              pageKey: { type: "string" },
              sectionId: { type: "string" },
            },
          },
        },
        allowedCopySlotKeys: { type: "array", items: { type: "string" } },
        allowedAssetReferenceIds: {
          type: "array",
          items: { type: "string" },
        },
        allowedClaimIds: { type: "array", items: { type: "string" } },
        previousCandidateDigest: { type: "string" },
        findings: { type: "array", items: { type: "object" } },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sections"],
      properties: {
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "pageKey",
              "sectionId",
              "copySlotKeys",
              "assetReferenceIds",
              "claimIds",
              "itemIndexes",
            ],
            properties: {
              pageKey: { type: "string" },
              sectionId: { type: "string" },
              copySlotKeys: { type: "array", items: { type: "string" } },
              assetReferenceIds: {
                type: "array",
                items: { type: "string" },
              },
              claimIds: { type: "array", items: { type: "string" } },
              itemIndexes: {
                type: "array",
                items: { type: "integer", minimum: 0, maximum: 127 },
              },
            },
          },
        },
      },
    },
    system:
      "Select only frozen page, section, copy slot, asset, Claim, and item IDs. Never output props, prose, component types, variants, CSS, HTML, URLs, or paths.",
    buildPrompt: (input) =>
      [
        `DesignBrief digest: ${input.designBriefDigest}`,
        `Required section targets: ${JSON.stringify(input.allowedSectionTargets ?? [])}`,
        `Allowed copy slots: ${JSON.stringify(input.allowedCopySlotKeys)}`,
        `Allowed asset refs: ${JSON.stringify(input.allowedAssetReferenceIds)}`,
        `Allowed Claim IDs: ${JSON.stringify(input.allowedClaimIds)}`,
        `Previous candidate digest: ${input.previousCandidateDigest ?? "none"}`,
        `Structured findings: ${JSON.stringify(input.findings)}`,
        "Return only the closed sections selection envelope. Select exactly one entry for every required section target; missing or duplicate targets are invalid.",
      ].join("\n"),
    validateOutput: (input, output) => closedSelection(input, output),
    repairTaskOutput: true,
  };
}

export const ASSEMBLE_TASK = definition("site_builder.assemble");
export const ASSEMBLY_FIX_TASK = definition("site_builder.assembly_fix");

export function createLedgerAssemblyGenerator(input: {
  ledger: SiteBuildCostLedger;
  gateway: ModelGateway;
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  isCancelled?: () => boolean;
}): AssemblySelectionGenerator {
  const assertActive = (): void => {
    if (input.isCancelled?.()) {
      const error = new Error("BUILD_CANCELLED");
      error.name = "CancellationError";
      throw error;
    }
  };
  return {
    async generate(request): Promise<unknown> {
      assertActive();
      const claimed = await input.ledger.claimTaskAttempt({
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        buildRunId: input.buildRunId,
        taskId: request.taskId,
      });
      if (claimed.kind === "completed") {
        if (!claimed.result.selection) {
          throw new Error(
            `CONTROLLED_ASSEMBLY_REPLAY_INVALID: ${request.taskId}`,
          );
        }
        return claimed.result.selection;
      }
      const fence = {
        workspaceId: input.workspaceId,
        attemptId: claimed.attempt.id,
        fenceToken: claimed.attempt.fenceToken,
      };
      let completed = false;
      try {
        const candidate: ControlledAssemblyTaskInput = {
          designBriefDigest: request.brief.digest,
          allowedSectionTargets: request.allowedSectionTargets.map((target) => ({
            pageKey: target.pageKey,
            sectionId: target.sectionId,
          })),
          allowedCopySlotKeys: [...request.allowedCopySlotKeys],
          allowedAssetReferenceIds: [...request.allowedAssetReferenceIds],
          allowedClaimIds: [...request.allowedClaimIds],
          ...(request.previousCandidateDigest
            ? { previousCandidateDigest: request.previousCandidateDigest }
            : {}),
          findings: structuredClone([...request.findings]),
        };
        const frozen = await input.ledger.freezeTaskInput(
          fence,
          candidate as unknown as Record<string, unknown>,
        );
        assertActive();
        const task =
          request.taskId === "site_builder.assemble"
            ? ASSEMBLE_TASK
            : ASSEMBLY_FIX_TASK;
        const selection = (
          await runAiTask(
            task,
            frozen.input as unknown as ControlledAssemblyTaskInput,
            {
              gateway: input.gateway,
              ctx: {
                workspaceId: input.workspaceId,
                runId: input.buildRunId,
                paidCost: {
                  siteId: input.siteId,
                  taskAttemptId: claimed.attempt.id,
                  fenceToken: claimed.attempt.fenceToken,
                  scopeKey: request.taskId,
                  durableReplayResult: (result) => result,
                },
              },
            },
          )
        ).data;
        assertActive();
        await input.ledger.storeTaskOutput(
          fence,
          selection as unknown as Record<string, unknown>,
        );
        await input.ledger.completeTask(fence, {
          taskAttemptId: claimed.attempt.id,
          selection,
        });
        completed = true;
        return selection;
      } finally {
        if (!completed) await input.ledger.releaseTask(fence);
      }
    },
  };
}

export function controlledAssemblyRouteId(
  taskId: ControlledAssemblyTaskId,
): "site_builder.assemble" | "site_builder.assembly_fix" {
  return taskId === "site_builder.assemble"
    ? "site_builder.assemble"
    : "site_builder.assembly_fix";
}
