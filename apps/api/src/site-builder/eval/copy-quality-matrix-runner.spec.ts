import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalDigest,
  getDurableModelExecutionAttestation,
  type ModelExecutionPlan,
  type ModelObservation,
  type ModelTransport,
} from "../../model-runtime";
import {
  COPY_TASK,
  type CopyTaskInput,
  type CopyTaskOutput,
} from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  prepareCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import {
  COPY_QUALITY_MATRIX_PLAN,
  COPY_QUALITY_MATRIX_SCHEMA_VERSION,
  createCopyQualityMatrixExecutionPlan,
  createCopyQualityMatrixFakeTransportRunner,
  createCopyQualityMatrixRepairCompiler,
  validateCopyQualityMatrixPlan,
} from "./copy-quality-matrix-runner";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixtureById(fixtureId: string) {
  const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (!fixture) throw new Error(`missing fixture: ${fixtureId}`);
  return prepareCopyAssemblyEvalFixture(fixture);
}

function expectedOutputForPlan(
  plan: ModelExecutionPlan<CopyTaskInput, CopyTaskOutput>,
): CopyTaskOutput {
  const fixture = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    ({ input }) => canonicalDigest(input) === plan.inputDigest,
  );
  if (!fixture) throw new Error("fixture input not bound to execution plan");
  return fixture.expectedOutput;
}

function knownObservation(
  plan: ModelExecutionPlan<CopyTaskInput, CopyTaskOutput>,
  output: CopyTaskOutput,
  ordinal: number,
): ModelObservation<CopyTaskOutput> {
  return Object.freeze({
    output,
    requestedAlias: plan.requestedAlias,
    resolvedAlias: plan.resolvedAlias,
    reportedModel: plan.resolvedAlias,
    protocol: plan.protocol,
    usage: { inputTokens: 120, outputTokens: 40 },
    usageComplete: true,
    requestId: `copy-quality-request-${ordinal}`,
    settlement: "known" as const,
    warnings: Object.freeze([]),
  });
}

describe("Copy quality matrix plan", () => {
  it("freezes the exact Terra/Sol/Sonnet x six fixtures x two repeats topology", () => {
    expect(COPY_QUALITY_MATRIX_PLAN).toMatchObject({
      schemaVersion: COPY_QUALITY_MATRIX_SCHEMA_VERSION,
      planId: "site-builder-copy-quality-matrix/2026-08-06-v1",
      taskId: COPY_TASK.id,
      executionStatus: "BLOCKED_BEFORE_CAPABILITY_PILOT_RESULT",
      plannedExecutions: 36,
      maximumWireCalls: 72,
      maximumRepairCallsPerExecution: 1,
      cachePolicy: "disabled",
      settlementPolicy: "known_per_physical_call_required",
    });
    expect(Object.isFrozen(COPY_QUALITY_MATRIX_PLAN)).toBe(true);
    expect(Object.isFrozen(COPY_QUALITY_MATRIX_PLAN.executions)).toBe(true);
    expect(COPY_QUALITY_MATRIX_PLAN.executions).toHaveLength(36);
    expect(
      new Set(
        COPY_QUALITY_MATRIX_PLAN.executions.map(
          ({ executionKey }) => executionKey,
        ),
      ).size,
    ).toBe(36);

    for (const candidate of COPY_EVALUATION_V2_CANDIDATES) {
      const candidateExecutions = COPY_QUALITY_MATRIX_PLAN.executions.filter(
        ({ alias }) => alias === candidate.alias,
      );
      expect(candidateExecutions).toHaveLength(12);
      expect(
        new Set(candidateExecutions.map(({ fixtureId }) => fixtureId)),
      ).toEqual(
        new Set(COPY_ASSEMBLY_EVAL_FIXTURES.map(({ fixtureId }) => fixtureId)),
      );
      expect(
        new Set(candidateExecutions.map(({ repeatIndex }) => repeatIndex)),
      ).toEqual(new Set([0, 1]));
      expect(candidateExecutions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            protocol: candidate.protocol,
            reasoning: candidate.reasoning,
          }),
        ]),
      );
    }
    expect(() =>
      validateCopyQualityMatrixPlan(COPY_QUALITY_MATRIX_PLAN),
    ).not.toThrow();
    expect(() =>
      validateCopyQualityMatrixPlan({
        ...COPY_QUALITY_MATRIX_PLAN,
        maximumWireCalls: 73,
      }),
    ).toThrow("COPY_QUALITY_MATRIX_PLAN_DRIFT");
  });

  it("binds every execution to the real fixture input, context, prompt and candidate capability", () => {
    for (const execution of COPY_QUALITY_MATRIX_PLAN.executions) {
      const prepared = fixtureById(execution.fixtureId);
      const plan = createCopyQualityMatrixExecutionPlan({
        executionKey: execution.executionKey,
        campaignId: "copy-quality-plan-contract",
        workspaceId: "copy-quality-workspace",
      });

      expect(plan.executionId).toBe(execution.executionKey);
      expect(plan.input).toEqual(prepared.input);
      expect(plan.inputDigest).toBe(canonicalDigest(prepared.input));
      expect(plan.contextDigest).toBe(plan.context.digest);
      expect(plan.context.segments.map(({ sourceRef }) => sourceRef)).toEqual([
        "copy-quality:policy",
        "copy-quality:schema",
        "copy-quality:facts",
        "copy-quality:brand",
        "copy-quality:request",
      ]);
      expect(plan.context.segments[2]?.content).toEqual({
        snapshotDigest: prepared.input.snapshotDigest,
        claims: prepared.input.claims,
      });
      expect(plan.context.segments[3]?.content).toEqual(prepared.input.context);
      expect(plan.context.segments[4]?.content).toEqual({
        locale: prepared.input.locale,
        sourceLocale: prepared.input.sourceLocale,
        slots: prepared.input.slots,
      });
      expect(plan.prompt).toEqual({
        system: COPY_TASK.system,
        user: COPY_TASK.buildPrompt(prepared.input),
      });
      expect(plan).toMatchObject({
        requestedAlias: execution.alias,
        resolvedAlias: execution.alias,
        protocol: execution.protocol,
        reasoning: execution.reasoning,
        locale: prepared.input.locale,
      });
      expect(plan.contract).toMatchObject({
        executionMode: "generative",
        cachePolicy: { mode: "disabled" },
        retryPolicy: {
          transportMaxAttempts: 1,
          contentRepairMaxAttempts: 1,
        },
        capabilityRequirements: {
          protocols: [execution.protocol],
          reasoning: execution.reasoning,
          structuredOutput: true,
          settlementRequired: true,
        },
      });
    }
  });

  it("rejects fixture-input drift and an oversized closed-repair payload", () => {
    const execution = COPY_QUALITY_MATRIX_PLAN.executions[0]!;
    const plan = createCopyQualityMatrixExecutionPlan({
      executionKey: execution.executionKey,
      campaignId: "copy-quality-negative-contract",
      workspaceId: "copy-quality-workspace",
    });
    const driftedInput = structuredClone(plan.input);
    driftedInput.snapshotDigest = "a".repeat(64);
    expect(() =>
      plan.contract.validateOutput(driftedInput, expectedOutputForPlan(plan)),
    ).toThrow("COPY_QUALITY_MATRIX_FIXTURE_INPUT_DRIFT");

    const binding = {
      priorOutputDigest: "a".repeat(64),
      findingsDigest: "b".repeat(64),
      originalInputDigest: plan.inputDigest,
      originalContextDigest: plan.contextDigest,
    };
    expect(() =>
      createCopyQualityMatrixRepairCompiler().compile({
        originalPlan: plan,
        currentPlan: plan,
        priorOutput: {
          slots: {
            oversized: {
              content: "x".repeat(65 * 1024),
              claimRefs: [],
            },
          },
        },
        findings: [{ code: "COPY_QUALITY_OUTPUT_INVALID", path: "$" }],
        binding,
        repairAttempt: 1,
      }),
    ).toThrow("COPY_QUALITY_MATRIX_PRIOR_OUTPUT_TOO_LARGE");
  });
});

describe("Copy quality matrix fake-transport runner", () => {
  it("executes all 36 unique plans only through the unified durable Runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-quality-matrix-"));
    directories.push(directory);
    const observed: Array<ModelExecutionPlan<CopyTaskInput, CopyTaskOutput>> =
      [];
    const transport: ModelTransport<CopyTaskInput, CopyTaskOutput> = {
      dispatch: async (plan) => {
        observed.push(plan);
        return knownObservation(
          plan,
          expectedOutputForPlan(plan),
          observed.length,
        );
      },
    };
    const runner = await createCopyQualityMatrixFakeTransportRunner({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaignId: "copy-quality-matrix-fake-contract",
      workspaceId: "copy-quality-workspace",
      transport,
    });

    for (const execution of COPY_QUALITY_MATRIX_PLAN.executions) {
      const result = await runner.execute(execution.executionKey);
      expect(result).toMatchObject({
        cacheHit: false,
        transportAttempts: 1,
        repairAttempts: 0,
      });
      expect(getDurableModelExecutionAttestation(result)).toMatchObject({
        evidenceClass: "fake_gateway_contract_only",
        campaignId: "copy-quality-matrix-fake-contract",
        executionId: execution.executionKey,
        wireCount: 1,
      });
    }

    expect(observed).toHaveLength(36);
    expect(new Set(observed.map(({ executionId }) => executionId)).size).toBe(
      36,
    );
    expect(await runner.summary()).toMatchObject({
      evidenceClass: "fake_gateway_contract_only",
      campaign: {
        maximumExecutions: 36,
        maximumWireCalls: 72,
      },
      executionClaims: 36,
      wireClaims: 36,
      knownWireSettlements: 36,
      unknownWireSettlements: 0,
      completedExecutions: 36,
      frozen: false,
    });
  });

  it("allows exactly one closed repair bound to the original fixture and validator findings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-quality-repair-"));
    directories.push(directory);
    const execution = COPY_QUALITY_MATRIX_PLAN.executions[0]!;
    const prepared = fixtureById(execution.fixtureId);
    const invalidOutput = structuredClone(prepared.fixture.expectedOutput);
    const firstSlot = prepared.input.slots[0]!.key;
    invalidOutput.slots[firstSlot] = {
      content: "unsupported altered claim",
      claimRefs: prepared.input.claims
        .slice(0, 1)
        .map(({ claimId }) => claimId),
    };
    const observed: Array<ModelExecutionPlan<CopyTaskInput, CopyTaskOutput>> =
      [];
    const transport: ModelTransport<CopyTaskInput, CopyTaskOutput> = {
      dispatch: async (plan) => {
        observed.push(plan);
        return knownObservation(
          plan,
          observed.length === 1
            ? invalidOutput
            : prepared.fixture.expectedOutput,
          observed.length,
        );
      },
    };
    const runner = await createCopyQualityMatrixFakeTransportRunner({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaignId: "copy-quality-repair-contract",
      workspaceId: "copy-quality-workspace",
      transport,
    });

    const result = await runner.execute(execution.executionKey);

    expect(result).toMatchObject({
      cacheHit: false,
      transportAttempts: 2,
      repairAttempts: 1,
      states: expect.arrayContaining(["repaired", "completed"]),
    });
    expect(observed).toHaveLength(2);
    expect(observed[1]).toMatchObject({
      executionId: execution.executionKey,
      inputDigest: observed[0]!.inputDigest,
      repair: {
        originalInputDigest: observed[0]!.inputDigest,
        originalContextDigest: observed[0]!.contextDigest,
      },
    });
    expect(observed[1]!.context.segments.at(-1)).toMatchObject({
      kind: "repair",
      sourceRef: "copy-quality:repair",
      cacheClass: "never-cache",
    });
    expect(observed[1]!.prompt.repair).toMatchObject({
      binding: observed[1]!.repair,
      findings: [{ code: "COPY_QUALITY_OUTPUT_INVALID", path: "$" }],
    });
    expect(getDurableModelExecutionAttestation(result)).toMatchObject({
      wireCount: 2,
    });
    expect(await runner.summary()).toMatchObject({
      executionClaims: 1,
      wireClaims: 2,
      knownWireSettlements: 2,
      completedExecutions: 1,
      frozen: false,
    });
  });

  it("rejects an execution outside the fixed matrix before fake transport dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "copy-quality-reject-"));
    directories.push(directory);
    let dispatches = 0;
    const runner = await createCopyQualityMatrixFakeTransportRunner({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaignId: "copy-quality-reject-contract",
      workspaceId: "copy-quality-workspace",
      transport: {
        dispatch: async () => {
          dispatches += 1;
          throw new Error("must not dispatch");
        },
      },
    });

    await expect(runner.execute("copy-quality-not-in-plan")).rejects.toThrow(
      "COPY_QUALITY_MATRIX_EXECUTION_NOT_IN_PLAN",
    );
    expect(dispatches).toBe(0);
    expect(await runner.summary()).toMatchObject({
      executionClaims: 0,
      wireClaims: 0,
      completedExecutions: 0,
      frozen: false,
    });
  });
});
