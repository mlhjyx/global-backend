import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../model-runtime/structured-task-runtime-bridge", () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

import { executeStructuredTaskWithRuntime } from "../model-runtime/structured-task-runtime-bridge";
import type { AiContext, GenerateStructuredInput } from "../model-gateway/types";
import {
  executeSkillWithRuntime,
  SkillUnavailableError,
  StaticSkillResolver,
  type SkillResolver,
} from "./skill-runtime";

const bridge = vi.mocked(executeStructuredTaskWithRuntime);

const INPUT: GenerateStructuredInput = {
  task: "discovery.qualify_fit",
  prompt: "卖方 ICP：…",
  system: "四门判定",
  model: "deepseek-v4-pro",
  schema: { type: "object" },
};

const CONTEXT: AiContext = { workspaceId: "33333333-3333-4333-8333-333333333333", runId: "account-key" };

const RESULT = {
  data: { verdict: "match" },
  provider: "gateway",
  model: "deepseek-v4-pro",
  runtimeExecution: { contractVersion: "x" },
} as never;

beforeEach(() => {
  bridge.mockReset();
  bridge.mockResolvedValue(RESULT);
});

describe("executeSkillWithRuntime", () => {
  it("forwards the structured task input, context and options unchanged (pass-through)", async () => {
    const resolver = new StaticSkillResolver();
    const options = { telemetry: undefined };

    const result = await executeSkillWithRuntime(
      resolver,
      {} as never,
      "discovery.qualify_fit",
      INPUT,
      CONTEXT,
      options,
    );

    expect(result).toBe(RESULT);
    expect(bridge).toHaveBeenCalledTimes(1);
    const [gateway, input, context, forwarded] = bridge.mock.calls[0];
    expect(gateway).toEqual({});
    expect(input).toBe(INPUT);
    expect(context).toBe(CONTEXT);
    expect(forwarded).toBe(options);
  });

  it("passes the effective model to the resolver for the snapshot descriptor", async () => {
    const resolve = vi.fn().mockResolvedValue({
      skillKey: "discovery.qualify_fit",
      version: "1.1.0",
      packType: "growth_motion",
      skillKind: "model_task",
      tenantDefault: "enabled",
      taskContractId: "discovery.qualify_fit",
      taskContractDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      modelPolicy: "contract-default",
      allowedTools: [],
      maxCostCents: 20,
      resolverVersion: "skill-resolver/v0",
    });
    const resolver: SkillResolver = { kind: "db", resolve };
    await executeSkillWithRuntime(resolver, {} as never, "discovery.qualify_fit", INPUT, CONTEXT);
    expect(resolve).toHaveBeenCalledWith("discovery.qualify_fit", CONTEXT.workspaceId, {
      effectiveModel: "deepseek-v4-pro",
    });
  });

  it("refuses to execute when the skill binding and requested task disagree", async () => {
    const resolver: SkillResolver = {
      kind: "db",
      resolve: vi.fn().mockResolvedValue({
        skillKey: "other.skill",
        version: "1.0.0",
        packType: "growth_motion",
        skillKind: "model_task",
        tenantDefault: "enabled",
        taskContractId: "another.task",
        taskContractDigest: "a".repeat(64),
        manifestDigest: "b".repeat(64),
        modelPolicy: "contract-default",
        allowedTools: [],
        maxCostCents: null,
        resolverVersion: "skill-resolver/v0",
      }),
    };
    await expect(
      executeSkillWithRuntime(resolver, {} as never, "other.skill", INPUT, CONTEXT),
    ).rejects.toMatchObject({ reason: "SKILL_BINDING_MISMATCH" });
    expect(bridge).not.toHaveBeenCalled();
  });

  it("propagates resolver failures without calling the model", async () => {
    const resolver: SkillResolver = {
      kind: "db",
      resolve: vi.fn().mockRejectedValue(new SkillUnavailableError("SKILL_PLATFORM_DISABLED", "x")),
    };
    await expect(
      executeSkillWithRuntime(resolver, {} as never, "discovery.qualify_fit", INPUT, CONTEXT),
    ).rejects.toBeInstanceOf(SkillUnavailableError);
    expect(bridge).not.toHaveBeenCalled();
  });
});
