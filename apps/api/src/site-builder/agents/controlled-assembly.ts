import type { SiteBuildCostLedger } from "../site-build-cost-ledger";
import type { AssemblyFinding } from "../assembly/controlled-assembly-validator";
import type {
  AssemblySelection,
  AssemblySelectionGenerator,
  ControlledAssemblyTaskId,
} from "../assembly/controlled-assembly.service";

export interface ControlledAssemblyTaskInput {
  designBriefDigest: string;
  allowedSectionTargets?: Array<{ pageKey: string; sectionId: string }>;
  allowedCopySlotKeys: string[];
  allowedAssetReferenceIds: string[];
  allowedClaimIds: string[];
  previousCandidateDigest?: string;
  findings: AssemblyFinding[];
}

export function validateDeterministicAssemblySelection(
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

function deterministicSelection(
  input: ControlledAssemblyTaskInput,
): AssemblySelection {
  if (!input.allowedSectionTargets) {
    throw new Error("CONTROLLED_ASSEMBLY_SECTION_TARGETS_REQUIRED");
  }
  const selection = {
    sections: input.allowedSectionTargets.map(({ pageKey, sectionId }) => ({
      pageKey,
      sectionId,
      copySlotKeys: input.allowedCopySlotKeys.filter((key) =>
        key.startsWith(`${pageKey}.${sectionId}.`),
      ),
      assetReferenceIds: [...input.allowedAssetReferenceIds],
      claimIds: [...input.allowedClaimIds],
      itemIndexes: [],
    })),
  };
  validateDeterministicAssemblySelection(input, selection);
  return selection;
}

export function createLedgerAssemblyGenerator(input: {
  ledger: SiteBuildCostLedger;
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
        const frozenInput =
          frozen.input as unknown as ControlledAssemblyTaskInput;
        const selection = deterministicSelection({
          ...frozenInput,
          allowedSectionTargets:
            frozenInput.allowedSectionTargets ?? candidate.allowedSectionTargets,
        });
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
