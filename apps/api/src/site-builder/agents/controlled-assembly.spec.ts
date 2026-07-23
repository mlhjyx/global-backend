import type { ModelGateway } from "../../model-gateway/model-gateway";
import type { GenerateStructuredInput } from "../../model-gateway/types";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SiteBuildCostLedger } from "../site-build-cost-ledger";
import { buildM1ebGoldenFixtures } from "../design/m1eb-golden";
import { createLedgerAssemblyGenerator } from "./controlled-assembly";

let brief: Awaited<
  ReturnType<typeof buildM1ebGoldenFixtures>
>[number]["designBrief"];

beforeAll(async () => {
  brief = (
    await buildM1ebGoldenFixtures(
      new URL("../../../../../", import.meta.url).pathname,
    )
  )[0]!.designBrief;
});

function request(taskId = "site_builder.assembly_fix:2" as const) {
  return {
    taskId,
    brief,
    allowedCopySlotKeys: ["home.hero.title"],
    allowedAssetReferenceIds: ["catalog-hero"],
    allowedClaimIds: ["claim-1"],
    previousCandidateDigest: "a".repeat(64),
    findings: [],
  };
}

describe("controlled assembly durable task ledger", () => {
  it("freezes the closed selector input under the exact repair task ID", async () => {
    const freezeTaskInput = vi.fn(async (_fence, candidate) => ({
      inputHash: "b".repeat(64),
      input: candidate,
      replayed: false,
    }));
    const completeTask = vi.fn(async () => undefined);
    const ledger = {
      claimTaskAttempt: vi.fn(async () => ({
        kind: "claimed",
        attempt: { id: "attempt-1", fenceToken: "fence-1" },
      })),
      freezeTaskInput,
      storeTaskOutput: vi.fn(async () => undefined),
      completeTask,
      releaseTask: vi.fn(async () => undefined),
    } as unknown as SiteBuildCostLedger;
    const gateway = {
      generateStructured: vi.fn(async (input: GenerateStructuredInput) => {
        const data = { sections: [] };
        input.validateOutput?.(data);
        return {
          data,
          provider: "gateway",
          model: "minimax-m3",
          reportedModel: "minimax-m3",
          modelResolutionSource: "requested_model",
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      }),
    } as unknown as ModelGateway;
    const generator = createLedgerAssemblyGenerator({
      ledger,
      gateway,
      workspaceId: "workspace-1",
      siteId: "site-1",
      buildRunId: "run-1",
    });

    await expect(generator.generate(request())).resolves.toEqual({
      sections: [],
    });
    expect(ledger.claimTaskAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "site_builder.assembly_fix:2" }),
    );
    expect(freezeTaskInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        designBriefDigest: brief.digest,
        allowedCopySlotKeys: ["home.hero.title"],
        previousCandidateDigest: "a".repeat(64),
      }),
    );
    expect(gateway.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ task: "site_builder.assembly_fix" }),
      expect.anything(),
    );
    expect(completeTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskAttemptId: "attempt-1",
        selection: { sections: [] },
      }),
    );
  });

  it("returns the stored selection after ACK loss without another model call", async () => {
    const gateway = {
      generateStructured: vi.fn(),
    } as unknown as ModelGateway;
    const ledger = {
      claimTaskAttempt: vi.fn(async () => ({
        kind: "completed",
        result: {
          taskAttemptId: "attempt-1",
          selection: { sections: [] },
        },
      })),
    } as unknown as SiteBuildCostLedger;
    const generator = createLedgerAssemblyGenerator({
      ledger,
      gateway,
      workspaceId: "workspace-1",
      siteId: "site-1",
      buildRunId: "run-1",
    });
    await expect(
      generator.generate(request("site_builder.assemble")),
    ).resolves.toEqual({ sections: [] });
    expect(gateway.generateStructured).not.toHaveBeenCalled();
  });
});
