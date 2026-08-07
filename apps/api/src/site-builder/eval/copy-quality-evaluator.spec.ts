import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AppendOnlyModelExecutionLedger,
  canonicalDigest,
  ContextEngine,
  DurableModelExecutionRuntime,
  ModelExecutionRuntime,
  type ModelExecutionPlan,
  type TaskModelContract,
} from "../../model-runtime";
import type { CopyTaskInput, CopyTaskOutput } from "../agents/copy";
import {
  COPY_ASSEMBLY_EVAL_FIXTURES,
  evaluateCopyAssemblyOutput,
  prepareCopyAssemblyEvalFixture,
} from "./copy-assembly-eval";
import { COPY_EVALUATION_V2_CANDIDATES } from "./copy-evaluation-v2-candidates";
import {
  aggregateCopyCandidateQuality,
  evaluateCopyQualityReview,
  evaluateCopyRepeatStability,
  observeCopyQualityExecution,
  type CopyQualityExecutionReceipt,
} from "./copy-quality-evaluator";
import {
  COPY_QUALITY_REVIEW_SCHEMA_VERSION,
  COPY_QUALITY_RUBRIC_VERSION,
  COPY_QUALITY_SCORED_DIMENSIONS,
} from "./copy-quality-rubric";

function fixture(fixtureId: string) {
  const source = COPY_ASSEMBLY_EVAL_FIXTURES.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (!source) throw new Error(`fixture not found: ${fixtureId}`);
  return prepareCopyAssemblyEvalFixture(source);
}

function reviewFor(
  receipt: CopyQualityExecutionReceipt,
  findings: Array<{
    dimension:
      | "language_quality"
      | "brand_voice"
      | "cta_quality"
      | "cross_locale_quality";
    slotKey: string;
    code: string;
  }> = [],
) {
  return {
    schemaVersion: COPY_QUALITY_REVIEW_SCHEMA_VERSION,
    rubricVersion: COPY_QUALITY_RUBRIC_VERSION,
    fixtureId: receipt.fixtureId,
    repeatIndex: receipt.repeatIndex,
    executionId: receipt.executionId,
    outputDigest: receipt.outputDigest,
    reviewer: {
      kind: "human_blind" as const,
      identityDigest: "a".repeat(64),
      providerFamily: null,
    },
    findings,
  };
}

const OPENAI_ALIAS = "gpt-5.6-terra" as const;
let executionCounter = 0;
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function execution(
  prepared: ReturnType<typeof prepareCopyAssemblyEvalFixture>,
  output: CopyTaskOutput,
  repeatIndex: 0 | 1,
  candidateAlias = OPENAI_ALIAS,
  durable = true,
) {
  executionCounter += 1;
  const candidate = COPY_EVALUATION_V2_CANDIDATES.find(
    (entry) => entry.alias === candidateAlias,
  )!;
  const contract: TaskModelContract<CopyTaskInput, CopyTaskOutput> = {
    taskId: "site_builder.copy",
    version: "site-builder-task-contract/site_builder.copy/v2",
    executionMode: "generative",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    contextPolicy: {
      version: "copy-quality-test/v1",
      allowedSourceRefs: ["copy-quality:test"],
    },
    capabilityRequirements: {
      protocols: [candidate.protocol],
      reportsRequestId: true,
      reportsUsage: true,
      reportsModel: true,
      exactReportedModel: true,
      forbidWarnings: true,
    },
    reasoningPolicy: {
      allowed: [candidate.reasoning],
      default: candidate.reasoning,
      reserveTokens: 1,
    },
    cachePolicy: { mode: "disabled" },
    retryPolicy: { transportMaxAttempts: 1, contentRepairMaxAttempts: 0 },
    validateOutput: (_input, candidateOutput) =>
      evaluateCopyAssemblyOutput(prepared, candidateOutput),
  };
  const context = new ContextEngine().assemble({
    workspaceId: "copy-quality-test",
    policy: contract.contextPolicy,
    segments: [
      {
        kind: "request",
        sourceRef: "copy-quality:test",
        sourceDigest: canonicalDigest(prepared.input),
        sensitivity: "workspace",
        cacheClass: "request-local",
        estimatedTokens: 1,
        content: prepared.input,
      },
    ],
    budget: { contextWindow: 100, outputReserve: 10, reasoningReserve: 10 },
  });
  const plan: ModelExecutionPlan<CopyTaskInput, CopyTaskOutput> = {
    executionId: `copy-quality-${executionCounter}`,
    workspaceId: "copy-quality-test",
    buildRunId: "copy-quality-test-run",
    contract,
    input: prepared.input,
    inputDigest: canonicalDigest(prepared.input),
    context,
    contextDigest: context.digest,
    promptVersion: "copy-quality-test/v1",
    schemaDigest: canonicalDigest(contract.outputSchema),
    requestedAlias: candidate.alias,
    resolvedAlias: candidate.alias,
    protocol: candidate.protocol,
    reasoning: candidate.reasoning,
    sampling: {},
    locale: prepared.input.locale,
    prompt: { fixtureId: prepared.fixture.fixtureId, repeatIndex },
  };
  const transport = {
    dispatch: async () => ({
      output,
      requestedAlias: candidate.alias,
      resolvedAlias: candidate.alias,
      reportedModel: candidate.alias,
      protocol: candidate.protocol,
      usage: { inputTokens: 1, outputTokens: 1 },
      usageComplete: true as const,
      requestId: `request-${executionCounter}`,
      settlement: "known" as const,
      warnings: [] as const,
    }),
  };
  let runtime:
    | ModelExecutionRuntime<CopyTaskInput, CopyTaskOutput>
    | DurableModelExecutionRuntime<CopyTaskInput, CopyTaskOutput>;
  if (durable) {
    const directory = await mkdtemp(join(tmpdir(), "copy-quality-ledger-"));
    temporaryDirectories.push(directory);
    const ledger = await AppendOnlyModelExecutionLedger.openTestOnly({
      ledgerPath: join(directory, "ledger.jsonl"),
      campaign: {
        campaignId: `copy-quality-${executionCounter}`,
        taskId: "site_builder.copy",
        planDigest: canonicalDigest({
          fixtureId: prepared.fixture.fixtureId,
          repeatIndex,
        }),
        maximumExecutions: 1,
        maximumWireCalls: 2,
      },
    });
    runtime = new DurableModelExecutionRuntime({ ledger, transport });
  } else {
    runtime = new ModelExecutionRuntime({ transport });
  }
  const result = await runtime.execute(plan);
  return observeCopyQualityExecution({
    prepared,
    result,
    repeatIndex,
  });
}

async function completeCandidateOutcomes(input?: {
  fixtureId: string;
  findings: Parameters<typeof reviewFor>[1];
}) {
  const executionPairs: Array<
    readonly [CopyQualityExecutionReceipt, CopyQualityExecutionReceipt]
  > = [];
  const reviews = (
    await Promise.all(
      COPY_ASSEMBLY_EVAL_FIXTURES.map(async (source) => {
        const prepared = prepareCopyAssemblyEvalFixture(source);
        const pair = (await Promise.all(
          ([0, 1] as const).map(async (repeatIndex) => {
            const output = structuredClone(prepared.fixture.expectedOutput);
            return await execution(prepared, output, repeatIndex);
          }),
        )) as unknown as readonly [
          CopyQualityExecutionReceipt,
          CopyQualityExecutionReceipt,
        ];
        executionPairs.push(pair);
        return pair.map((receipt) =>
          evaluateCopyQualityReview(
            receipt,
            reviewFor(
              receipt,
              input?.fixtureId === prepared.fixture.fixtureId
                ? input.findings
                : [],
            ),
          ),
        );
      }),
    )
  ).flat();
  const stability = executionPairs.map(([first, second]) =>
    evaluateCopyRepeatStability(first, second),
  );
  return { reviews, stability };
}

describe("Copy quality scored evaluator", () => {
  it("exposes exactly the five admitted dimensions", () => {
    expect(COPY_QUALITY_SCORED_DIMENSIONS).toEqual([
      "language_quality",
      "brand_voice",
      "cta_quality",
      "cross_locale_quality",
      "stability",
    ]);
  });

  it("rejects a Runtime-branded result without a durable ledger attestation", async () => {
    const prepared = fixture("copy-brand-voice-en");
    await expect(
      execution(
        prepared,
        structuredClone(prepared.fixture.expectedOutput),
        0,
        OPENAI_ALIAS,
        false,
      ),
    ).rejects.toThrow("COPY_QUALITY_REVIEW_DURABLE_EXECUTION_UNTRUSTED");
  });

  it("scores a blind closed review without exact-matching creative copy", async () => {
    const prepared = fixture("copy-brand-voice-en");
    const output: CopyTaskOutput = {
      slots: {
        "home.hero.summary": {
          content: "Decisions, made clear for engineering teams",
          claimRefs: [],
        },
      },
    };

    const receipt = await execution(prepared, output, 0);
    const outcome = evaluateCopyQualityReview(receipt, reviewFor(receipt));

    expect(outcome.hardGatePassed).toBe(true);
    expect(outcome.dimensions).toMatchObject({
      language_quality: { applicable: true, score: 4 },
      brand_voice: { applicable: true, score: 4 },
      cta_quality: { applicable: false, score: null },
      cross_locale_quality: { applicable: false, score: null },
    });
  });

  it("maps closed findings to deterministic penalties", async () => {
    const prepared = fixture("copy-brand-voice-cross-locale");
    const output = structuredClone(prepared.fixture.expectedOutput);
    const receipt = await execution(prepared, output, 0);
    const review = reviewFor(receipt, [
      {
        dimension: "brand_voice",
        slotKey: "home.hero.summary",
        code: "ignores_declared_style",
      },
      {
        dimension: "cross_locale_quality",
        slotKey: "home.hero.summary",
        code: "mixed_locale",
      },
    ]);

    const outcome = evaluateCopyQualityReview(receipt, review);

    expect(outcome.dimensions.brand_voice.score).toBe(2);
    expect(outcome.dimensions.cross_locale_quality.score).toBe(1);
    expect(outcome.reviewDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    [
      "unknown finding",
      (review: ReturnType<typeof reviewFor>) => ({
        ...review,
        findings: [
          {
            dimension: "brand_voice",
            slotKey: "home.hero.summary",
            code: "free_form_opinion",
          },
        ],
      }),
    ],
    [
      "wrong slot",
      (review: ReturnType<typeof reviewFor>) => ({
        ...review,
        findings: [
          {
            dimension: "brand_voice",
            slotKey: "home.hero.missing",
            code: "ignores_declared_style",
          },
        ],
      }),
    ],
    [
      "output digest drift",
      (review: ReturnType<typeof reviewFor>) => ({
        ...review,
        outputDigest: "b".repeat(64),
      }),
    ],
    [
      "repeat identity drift",
      (review: ReturnType<typeof reviewFor>) => ({
        ...review,
        repeatIndex: 1 as const,
      }),
    ],
    [
      "same-provider model reviewer",
      (review: ReturnType<typeof reviewFor>) => ({
        ...review,
        reviewer: {
          kind: "independent_model" as const,
          identityDigest: "c".repeat(64),
          providerFamily: "openai" as const,
        },
      }),
    ],
  ])("rejects %s before scoring", async (_name, mutate) => {
    const prepared = fixture("copy-brand-voice-en");
    const output = structuredClone(prepared.fixture.expectedOutput);
    const receipt = await execution(prepared, output, 0);
    const review = mutate(reviewFor(receipt));

    expect(() => evaluateCopyQualityReview(receipt, review)).toThrow(
      /COPY_QUALITY_REVIEW_/u,
    );
  });

  it("reconstructs cross-realm and custom-prototype values as local JSON", async () => {
    const prepared = fixture("copy-brand-voice-en");
    const output = structuredClone(prepared.fixture.expectedOutput);
    const receipt = await execution(prepared, output, 0);
    const crossRealmReview = runInNewContext("JSON.parse(serialized)", {
      serialized: JSON.stringify(reviewFor(receipt)),
    });

    expect(
      evaluateCopyQualityReview(receipt, crossRealmReview).dimensions
        .language_quality.score,
    ).toBe(4);

    const customReview = Object.assign(
      Object.create({ inherited: true }),
      reviewFor(receipt),
    );
    expect(
      evaluateCopyQualityReview(receipt, customReview).hardGatePassed,
    ).toBe(true);
  });

  it("binds reviewer-provider separation to the trusted candidate family", async () => {
    const prepared = fixture("copy-brand-voice-en");
    const output = structuredClone(prepared.fixture.expectedOutput);
    const openaiReceipt = await execution(prepared, output, 0);
    const review = {
      ...reviewFor(openaiReceipt),
      reviewer: {
        kind: "independent_model" as const,
        identityDigest: "c".repeat(64),
        providerFamily: "openai" as const,
      },
    };

    expect(() => evaluateCopyQualityReview(openaiReceipt, review)).toThrow(
      "COPY_QUALITY_REVIEW_REVIEWER_PROVIDER_CONFLICT",
    );

    const anthropicReceipt = await execution(
      prepared,
      output,
      0,
      "claude-sonnet-5",
    );
    expect(
      evaluateCopyQualityReview(anthropicReceipt, {
        ...review,
        executionId: anthropicReceipt.executionId,
        outputDigest: anthropicReceipt.outputDigest,
      }).hardGatePassed,
    ).toBe(true);
  });

  it("computes stability from two validated physical outputs", async () => {
    const prepared = fixture("copy-brand-voice-en");
    const first = structuredClone(prepared.fixture.expectedOutput);
    const identical = structuredClone(first);
    const divergent: CopyTaskOutput = {
      slots: {
        "home.hero.summary": {
          content: "Clear paths for technical teams",
          claimRefs: [],
        },
      },
    };

    expect(
      evaluateCopyRepeatStability(
        await execution(prepared, first, 0),
        await execution(prepared, identical, 1),
      ),
    ).toMatchObject({ applicable: true, score: 4 });
    expect(
      evaluateCopyRepeatStability(
        await execution(prepared, first, 0),
        await execution(prepared, divergent, 1),
      ).score,
    ).toBeLessThan(4);

    const duplicate = await execution(prepared, first, 0);
    expect(() => evaluateCopyRepeatStability(duplicate, duplicate)).toThrow(
      "COPY_QUALITY_REVIEW_STABILITY_IDENTITY_INVALID",
    );
  });

  it("aggregates complete coverage without turning it into route adoption", async () => {
    const { reviews, stability } = await completeCandidateOutcomes();
    const outcome = aggregateCopyCandidateQuality({
      candidateAlias: OPENAI_ALIAS,
      reviews,
      stability,
      hardGateFailures: 0,
    });

    expect(outcome.scoredQualityGatePassed).toBe(true);
    expect(outcome.qualityGatePassed).toBe(false);
    expect(outcome.blockers).toContain(
      "DURABLE_ACCEPTED_ARTIFACT_REPLAY_REQUIRED",
    );
    expect(outcome.routeAdoptionAuthorized).toBe(false);
    expect(outcome.promotionDecision).toBe("SEPARATE_PR_REQUIRED");
  });

  it("fails closed on a hard-gate failure or weak scored observation", async () => {
    const { reviews, stability } = await completeCandidateOutcomes({
      fixtureId: "copy-brand-voice-en",
      findings: [
        {
          dimension: "language_quality",
          slotKey: "home.hero.summary",
          code: "grammar_breakdown",
        },
      ],
    });
    const outcome = aggregateCopyCandidateQuality({
      candidateAlias: OPENAI_ALIAS,
      reviews,
      stability,
      hardGateFailures: 1,
    });

    expect(outcome.qualityGatePassed).toBe(false);
    expect(outcome.blockers).toContain("OBSERVATION_BELOW_MINIMUM");
    expect(outcome.blockers).toContain("HARD_GATE_FAILURE");
  });

  it("rejects caller-forged aggregate outcomes", () => {
    expect(() =>
      aggregateCopyCandidateQuality({
        candidateAlias: OPENAI_ALIAS,
        reviews: [
          {
            hardGatePassed: true,
            candidateAlias: OPENAI_ALIAS,
            fixtureId: "forged",
            repeatIndex: 0,
            executionId: "c".repeat(64),
            outputDigest: "a".repeat(64),
            evidenceClass: "fake_gateway_contract_only",
            ledgerDigest: "d".repeat(64),
            reviewDigest: "b".repeat(64),
            dimensions: {
              language_quality: {
                applicable: true,
                score: 4,
                findingCodes: [],
              },
              brand_voice: { applicable: true, score: 4, findingCodes: [] },
              cta_quality: { applicable: true, score: 4, findingCodes: [] },
              cross_locale_quality: {
                applicable: true,
                score: 4,
                findingCodes: [],
              },
            },
          },
        ],
        stability: [],
        hardGateFailures: 0,
      }),
    ).toThrow("COPY_QUALITY_AGGREGATE_UNTRUSTED_OUTCOME");
  });

  it("does not accept duplicate fixtures as complete candidate coverage", async () => {
    const { reviews, stability } = await completeCandidateOutcomes();
    const duplicatedReviews = reviews.map(() => reviews[0]!);
    const duplicatedStability = stability.map(() => stability[0]!);

    const outcome = aggregateCopyCandidateQuality({
      candidateAlias: OPENAI_ALIAS,
      reviews: duplicatedReviews,
      stability: duplicatedStability,
      hardGateFailures: 0,
    });

    expect(outcome.qualityGatePassed).toBe(false);
    expect(outcome.blockers).toContain("INCOMPLETE_REVIEW_COVERAGE");
    expect(outcome.blockers).toContain("INCOMPLETE_STABILITY_COVERAGE");
  });

  it("does not accept duplicate repeat identities as complete candidate coverage", async () => {
    const complete = await completeCandidateOutcomes();
    const reviews = complete.reviews.map((review, index) =>
      index % 2 === 1 ? complete.reviews[index - 1]! : review,
    );

    const outcome = aggregateCopyCandidateQuality({
      candidateAlias: OPENAI_ALIAS,
      reviews,
      stability: complete.stability,
      hardGateFailures: 0,
    });

    expect(outcome.qualityGatePassed).toBe(false);
    expect(outcome.blockers).toContain("INCOMPLETE_REVIEW_COVERAGE");
  });

  it("does not mix trusted outcomes from different admitted candidates", async () => {
    const complete = await completeCandidateOutcomes();
    const prepared = fixture(complete.reviews[0]!.fixtureId);
    const anthropicReceipt = await execution(
      prepared,
      structuredClone(prepared.fixture.expectedOutput),
      0,
      "claude-sonnet-5",
    );
    const mixedReviews = [
      evaluateCopyQualityReview(anthropicReceipt, reviewFor(anthropicReceipt)),
      ...complete.reviews.slice(1),
    ];

    const outcome = aggregateCopyCandidateQuality({
      candidateAlias: OPENAI_ALIAS,
      reviews: mixedReviews,
      stability: complete.stability,
      hardGateFailures: 0,
    });

    expect(outcome.qualityGatePassed).toBe(false);
    expect(outcome.blockers).toContain("CANDIDATE_IDENTITY_MISMATCH");
    expect(outcome.blockers).toContain("STABILITY_REVIEW_IDENTITY_MISMATCH");
  });

  it("deep-freezes trusted nested scores before aggregation", async () => {
    const complete = await completeCandidateOutcomes({
      fixtureId: "copy-brand-voice-en",
      findings: [
        {
          dimension: "language_quality",
          slotKey: "home.hero.summary",
          code: "grammar_breakdown",
        },
      ],
    });
    const scored = complete.reviews.find(
      (review) => review.fixtureId === "copy-brand-voice-en",
    )!;

    expect(() => {
      (scored.dimensions.language_quality as { score: number | null }).score =
        4;
    }).toThrow(TypeError);
    expect(
      aggregateCopyCandidateQuality({
        candidateAlias: OPENAI_ALIAS,
        ...complete,
        hardGateFailures: 0,
      }).qualityGatePassed,
    ).toBe(false);
  });
});
