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
  allowedCopySlotKeys: string[];
  allowedAssetReferenceIds: string[];
  allowedClaimIds: string[];
  previousCandidateDigest?: string;
  findings: AssemblyFinding[];
}

function closedSelection(value: AssemblySelection): void {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => key !== "sections") ||
    !Array.isArray(value.sections)
  ) {
    throw new Error("CONTROLLED_ASSEMBLY_MODEL_OUTPUT_INVALID");
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
        `Allowed copy slots: ${JSON.stringify(input.allowedCopySlotKeys)}`,
        `Allowed asset refs: ${JSON.stringify(input.allowedAssetReferenceIds)}`,
        `Allowed Claim IDs: ${JSON.stringify(input.allowedClaimIds)}`,
        `Previous candidate digest: ${input.previousCandidateDigest ?? "none"}`,
        `Structured findings: ${JSON.stringify(input.findings)}`,
        "Return only the closed sections selection envelope. An empty sections array is valid and lets server adapters use deterministic defaults.",
      ].join("\n"),
    validateOutput: (_input, output) => closedSelection(output),
    repairTaskOutput: true,
  };
}

const ASSEMBLE_TASK = definition("site_builder.assemble");
const FIX_TASK = definition("site_builder.assembly_fix");

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
          request.taskId === "site_builder.assemble" ? ASSEMBLE_TASK : FIX_TASK;
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
