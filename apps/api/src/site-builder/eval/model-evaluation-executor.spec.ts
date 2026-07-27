import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAND_PROFILE_TASK,
  type BrandProfileOutput,
} from "../agents/brand-profile";
import { SITE_BUILDER_TASK_IDS } from "../agents/task-route-bindings";
import { modelPolicyRegistry } from "../agents/model-policy.registry";
import {
  ModelEvaluationBudgetGuard,
  ModelEvaluationCallError,
  ModelEvaluationCapabilityCampaign,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
  runTaskEvaluationAttempt,
  validateCapabilityProbe,
  type CostSettlement,
  type ModelEvaluationExecutionRequest,
} from "./model-evaluation-harness";
import {
  MODEL_EVALUATION_PROTOCOL_ADMISSIONS,
  createModelEvaluationProtocolExecutor,
  isTrustedModelEvaluationProtocolExecute,
  type ModelEvaluationSettlementResolver,
  type ModelEvaluationWireClient,
  type ModelEvaluationWireResponse,
} from "./model-evaluation-executor";

function canonicalRequest(
  candidateIndex = 0,
  fixtureId = "auto-parts-rich",
): ModelEvaluationExecutionRequest {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const candidate = plan.candidates[candidateIndex];
  if (!candidate || !plan.evaluationSuite) {
    throw new Error("test requires the BrandProfile evaluation suite");
  }
  const evaluationCase = buildCanonicalModelEvaluationCase(plan, fixtureId);
  return {
    taskId: plan.taskId,
    profile: plan.profile,
    alias: candidate.alias,
    expectedProtocol: candidate.expectedProtocol,
    fixtureId,
    attempt: 1,
    maxTokens: plan.envelope.maxTokens,
    runtimeDeadlineMs: plan.envelope.runtimeDeadlineMs,
    hardStopMs: plan.envelope.hardStopMs,
    perCallCostCapCents: plan.envelope.perCallCostCapCents,
    reasoningEffort: plan.envelope.reasoningEffort,
    outputSchema: BRAND_PROFILE_TASK.outputSchema,
    repairTaskOutput: plan.evaluationSuite.repairTaskOutput,
    caseContract: evaluationCase.contract,
    casePayload: evaluationCase.payload,
    signal: new AbortController().signal,
  };
}

function canonicalAcceptedArtifact(
  fixtureId = "auto-parts-rich",
): BrandProfileOutput {
  const evaluationCase = buildCanonicalModelEvaluationCase(
    buildTaskEvaluationPlan("site_builder.brand_profile"),
    fixtureId,
  );
  const sources = [
    evaluationCase.payload.taskInput.intakeSource,
    ...evaluationCase.payload.taskInput.kbSources,
    ...evaluationCase.payload.taskInput.research,
  ];
  const facts =
    evaluationCase.payload.fixture.assertions.requiredAcceptedTerms.map(
      (term) => {
        const source = sources.find((entry) =>
          entry.content.toLowerCase().includes(term.toLowerCase()),
        );
        if (!source) {
          throw new Error(`test requires canonical evidence for ${term}`);
        }
        const index = source.content.toLowerCase().indexOf(term.toLowerCase());
        return {
          key: "products",
          value: term,
          evidence: {
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            contentHash: source.contentHash,
            quote: source.content.slice(
              Math.max(0, index - 120),
              Math.min(source.content.length, index + term.length + 120),
            ),
          },
        };
      },
    );
  return {
    valueProps: [],
    glossary: [],
    keywords: [],
    differentiators: [],
    competitors: [],
    gaps: [],
    factSheet: facts,
  };
}

function openAIResponsesBody(
  model: string | undefined,
  artifact: unknown,
  options: {
    status?: string;
    inputTokens?: number;
    outputTokens?: number;
  } = {},
): unknown {
  return {
    status: options.status ?? "completed",
    ...(model ? { model } : {}),
    output: [
      {
        content: [
          {
            type: "output_text",
            text:
              typeof artifact === "string"
                ? artifact
                : JSON.stringify(artifact),
          },
        ],
      },
    ],
    usage: {
      input_tokens: options.inputTokens ?? 100,
      output_tokens: options.outputTokens ?? 50,
    },
  };
}

function anthropicBody(model: string | undefined, artifact: unknown): unknown {
  return {
    stop_reason: "end_turn",
    ...(model ? { model } : {}),
    content: [
      {
        type: "text",
        text:
          typeof artifact === "string" ? artifact : JSON.stringify(artifact),
      },
    ],
    usage: { input_tokens: 90, output_tokens: 40 },
  };
}

function chatBody(model: string | undefined, artifact: unknown): unknown {
  return {
    ...(model ? { model } : {}),
    choices: [
      {
        finish_reason: "stop",
        message: {
          content:
            typeof artifact === "string" ? artifact : JSON.stringify(artifact),
        },
      },
    ],
    usage: { prompt_tokens: 80, completion_tokens: 30 },
  };
}

function wireResponse(
  body: unknown,
  providerReportedCostCents = 1,
): ModelEvaluationWireResponse {
  return { body, providerReportedCostCents };
}

function wireClient(
  overrides: Partial<ModelEvaluationWireClient> = {},
): ModelEvaluationWireClient {
  const unexpected = async (): Promise<ModelEvaluationWireResponse> => {
    throw new Error("unexpected wire protocol");
  };
  return {
    openAIResponses: overrides.openAIResponses ?? unexpected,
    anthropicMessages: overrides.anthropicMessages ?? unexpected,
    openAIChatCompletions: overrides.openAIChatCompletions ?? unexpected,
  };
}

function settlementResolver(
  settlement?: CostSettlement,
): ModelEvaluationSettlementResolver {
  return {
    resolverId: "fake-settlement/v1",
    resolve: vi.fn((context) => {
      if (settlement) return settlement;
      const costs = context.providerReportedCostCents;
      return costs.every((amount): amount is number => amount !== null)
        ? {
            state: "settled" as const,
            amountCents: costs.reduce((sum, amount) => sum + amount, 0),
            basis: "provider_reported" as const,
          }
        : {
            state: "unknown" as const,
            reason: "provider_ack_unknown" as const,
          };
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("model evaluation protocol admission", () => {
  it("keeps text adapters separate from blocked media and embedding contracts", () => {
    expect(MODEL_EVALUATION_PROTOCOL_ADMISSIONS).toEqual([
      expect.objectContaining({
        protocol: "openai-responses",
        admission: "target_text_dispatch",
      }),
      expect.objectContaining({
        protocol: "anthropic-messages",
        admission: "target_text_dispatch",
      }),
      expect.objectContaining({
        protocol: "openai-chat-completions",
        admission: "legacy_comparator_only",
      }),
      expect.objectContaining({
        protocol: "google-generate-content",
        admission: "blocked_deferred",
      }),
      expect.objectContaining({
        protocol: "openai-images-generations",
        admission: "blocked_requires_media_gateway",
      }),
      expect.objectContaining({
        protocol: "openai-images-edits",
        admission: "blocked_requires_media_gateway",
      }),
      expect.objectContaining({
        protocol: "openai-videos",
        admission: "blocked_no_consumer",
        operations: ["create", "query", "cancel"],
      }),
      expect.objectContaining({
        protocol: "openai-embeddings",
        admission: "blocked_no_evaluation_suite",
      }),
    ]);
  });

  it.each([
    ["gpt-image-2", "openai-images-generations"],
    ["gemini-3.1-flash-image-preview", "openai-images-generations"],
    ["seedance-2-5s", "openai-videos"],
    ["site-builder-bge-m3-local", "openai-embeddings"],
    ["deepseek-v4-pro", "openai-chat-completions"],
    ["gemini-3.5-flash", "google-generate-content"],
  ] as const)(
    "rejects %s before any target wire call",
    async (alias, expectedProtocol) => {
      const request = {
        ...canonicalRequest(),
        alias,
        expectedProtocol,
      };
      const client = wireClient({
        openAIResponses: vi.fn(),
        anthropicMessages: vi.fn(),
        openAIChatCompletions: vi.fn(),
      });
      const executor = createModelEvaluationProtocolExecutor({
        wireClient: client,
        settlementResolver: settlementResolver(),
      });

      await expect(executor.execute(request)).rejects.toBeInstanceOf(
        ModelEvaluationCallError,
      );
      expect(client.openAIResponses).not.toHaveBeenCalled();
      expect(client.anthropicMessages).not.toHaveBeenCalled();
      expect(client.openAIChatCompletions).not.toHaveBeenCalled();
    },
  );

  it("rejects a task without a canonical suite before wire dispatch", async () => {
    const request = {
      ...canonicalRequest(),
      taskId: "site_builder.copy" as const,
      profile: "copy.premium" as const,
      alias: "claude-sonnet-5",
      expectedProtocol: "anthropic-messages" as const,
    };
    const call = vi.fn();
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ anthropicMessages: call }),
      settlementResolver: settlementResolver(),
    });
    await expect(executor.execute(request)).rejects.toMatchObject({
      failureCode: "task_has_no_canonical_evaluation_suite",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("model evaluation text wire adapters", () => {
  it("maps a canonical OpenAI Responses call and forwards the exact abort signal", async () => {
    const request = canonicalRequest(0);
    const artifact = canonicalAcceptedArtifact();
    const call = vi.fn(async (wireRequest) => {
      expect(wireRequest.signal).toBe(request.signal);
      expect(wireRequest.body).toMatchObject({
        model: "gpt-5.6-terra",
        max_output_tokens: 12_000,
        temperature: 0,
        reasoning: { effort: "low" },
        text: { format: { type: "json_object" } },
      });
      expect(wireRequest.body.input.at(-1)?.content).toBe(
        request.casePayload.prompt,
      );
      return wireResponse(openAIResponsesBody(request.alias, artifact));
    });
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: call }),
      settlementResolver: settlementResolver(),
    });

    await expect(executor.execute(request)).resolves.toMatchObject({
      artifactState: "complete",
      artifact,
      actualProtocol: "openai-responses",
      requestedModel: request.alias,
      reportedModel: request.alias,
      resolvedModel: request.alias,
      modelResolutionSource: "upstream_response",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        callCount: 1,
        source: "provider_reported",
      },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("maps canonical Anthropic Messages without accepting a caller protocol assertion as actual", async () => {
    const request = canonicalRequest(1);
    const artifact = canonicalAcceptedArtifact();
    const call = vi.fn(async (wireRequest) => {
      expect(wireRequest.signal).toBe(request.signal);
      expect(wireRequest.body).toMatchObject({
        model: "claude-sonnet-5",
        max_tokens: 12_000,
        temperature: 0,
        messages: [{ role: "user", content: request.casePayload.prompt }],
      });
      return wireResponse(anthropicBody(request.alias, artifact));
    });
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ anthropicMessages: call }),
      settlementResolver: settlementResolver(),
    });

    await expect(executor.execute(request)).resolves.toMatchObject({
      actualProtocol: "anthropic-messages",
      requestedModel: request.alias,
      reportedModel: request.alias,
      resolvedModel: request.alias,
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("keeps OpenAI Chat available only through the legacy comparator entrypoint", async () => {
    const request = {
      ...canonicalRequest(),
      alias: "deepseek-v4-pro",
      expectedProtocol: "openai-chat-completions" as const,
    };
    const artifact = canonicalAcceptedArtifact();
    const call = vi.fn(async (wireRequest) => {
      expect(wireRequest.body).toMatchObject({
        model: "deepseek-v4-pro",
        max_tokens: 12_000,
        response_format: { type: "json_object" },
        reasoning_effort: "low",
      });
      return wireResponse(chatBody(request.alias, artifact));
    });
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIChatCompletions: call }),
      settlementResolver: settlementResolver(),
    });

    await expect(executor.execute(request)).rejects.toMatchObject({
      failureCode: "candidate_legacy_only",
    });
    await expect(
      executor.executeLegacyComparator(request),
    ).resolves.toMatchObject({
      actualProtocol: "openai-chat-completions",
      requestedModel: "deepseek-v4-pro",
      reportedModel: "deepseek-v4-pro",
      resolvedModel: "deepseek-v4-pro",
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects a caller-supplied protocol mismatch before selecting an adapter", async () => {
    const call = vi.fn();
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ anthropicMessages: call }),
      settlementResolver: settlementResolver(),
    });
    await expect(
      executor.execute({
        ...canonicalRequest(),
        expectedProtocol: "anthropic-messages",
      }),
    ).rejects.toMatchObject({
      failureCode: "candidate_protocol_mismatch",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["OpenAI Responses", 0, false],
    ["Anthropic Messages", 1, false],
    ["OpenAI Chat comparator", 0, true],
  ] as const)(
    "preserves whitespace-padded reported identity from %s and fails it closed",
    async (_label, candidateIndex, legacyComparator) => {
      const request = legacyComparator
        ? {
            ...canonicalRequest(),
            alias: "deepseek-v4-pro",
            expectedProtocol: "openai-chat-completions" as const,
          }
        : canonicalRequest(candidateIndex);
      const artifact = canonicalAcceptedArtifact();
      const paddedReportedModel = ` ${request.alias}\n`;
      const client =
        request.expectedProtocol === "openai-responses"
          ? wireClient({
              openAIResponses: async () =>
                wireResponse(
                  openAIResponsesBody(paddedReportedModel, artifact),
                ),
            })
          : request.expectedProtocol === "anthropic-messages"
            ? wireClient({
                anthropicMessages: async () =>
                  wireResponse(anthropicBody(paddedReportedModel, artifact)),
              })
            : wireClient({
                openAIChatCompletions: async () =>
                  wireResponse(chatBody(paddedReportedModel, artifact)),
              });
      const executor = createModelEvaluationProtocolExecutor({
        wireClient: client,
        settlementResolver: settlementResolver(),
      });
      const result = legacyComparator
        ? await executor.executeLegacyComparator(request)
        : await executor.execute(request);

      expect(result).toMatchObject({
        requestedModel: request.alias,
        reportedModel: paddedReportedModel,
        resolvedModel: paddedReportedModel,
        modelResolutionSource: "upstream_response",
      });
      expect(
        validateCapabilityProbe(
          {
            ...buildTaskEvaluationPlan("site_builder.brand_profile")
              .candidates[0],
            alias: request.alias,
            expectedProtocol: request.expectedProtocol,
          },
          {
            actualProtocol: result.actualProtocol,
            requestedModel: result.requestedModel,
            reportedModel: result.reportedModel,
            resolvedModel: result.resolvedModel,
            modelResolutionSource: result.modelResolutionSource,
            outputState: result.artifactState,
          },
        ),
      ).toMatchObject({
        status: "identity_unproven",
        identityVerified: false,
      });
    },
  );

  it.each([
    ["missing", undefined, "requested_fallback", "gpt-5.6-terra"],
    ["wrong", "gpt-5.6-sol", "upstream_response", "gpt-5.6-sol"],
  ] as const)(
    "fails identity closed when reported model is %s",
    async (_label, reportedModel, source, resolvedModel) => {
      const request = canonicalRequest();
      const executor = createModelEvaluationProtocolExecutor({
        wireClient: wireClient({
          openAIResponses: async () =>
            wireResponse(
              openAIResponsesBody(reportedModel, canonicalAcceptedArtifact()),
            ),
        }),
        settlementResolver: settlementResolver(),
      });
      const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
      const result = await runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: request.fixtureId,
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
      });
      expect(result).toMatchObject({
        resultClass: "protocol_or_identity_invalid",
        identityVerified: false,
        artifactAccepted: false,
        failureCode: "identity_unproven",
        requestedModel: request.alias,
        resolvedModel,
        modelResolutionSource: source,
      });
      expect(result.reportedModel).toBe(reportedModel ?? null);
    },
  );
});

describe("structured output, repair, errors, and settlement", () => {
  it.each([
    ["empty", openAIResponsesBody("gpt-5.6-terra", ""), "empty"],
    [
      "truncated",
      openAIResponsesBody("gpt-5.6-terra", "", {
        status: "incomplete",
      }),
      "truncated",
    ],
  ] as const)("maps %s output without repair", async (_label, body, state) => {
    const call = vi.fn(async () => wireResponse(body));
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: call }),
      settlementResolver: settlementResolver(),
    });
    await expect(executor.execute(canonicalRequest())).resolves.toMatchObject({
      artifactState: state,
      usage: { callCount: 1 },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("repairs a schema-invalid artifact once and aggregates all usage", async () => {
    const request = canonicalRequest();
    const artifact = canonicalAcceptedArtifact();
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        wireResponse(
          openAIResponsesBody(
            request.alias,
            {},
            {
              inputTokens: 10,
              outputTokens: 5,
            },
          ),
        ),
      )
      .mockResolvedValueOnce(
        wireResponse(
          openAIResponsesBody(request.alias, artifact, {
            inputTokens: 20,
            outputTokens: 10,
          }),
        ),
      );
    const resolver = settlementResolver();
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: call }),
      settlementResolver: resolver,
    });

    await expect(executor.execute(request)).resolves.toMatchObject({
      artifact,
      usage: {
        inputTokens: 30,
        outputTokens: 15,
        callCount: 2,
        source: "adapter_aggregated",
      },
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].body.input.at(-1)?.content).toContain(
      "JSON Schema",
    );
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        callCount: 2,
        usage: expect.objectContaining({ callCount: 2 }),
      }),
    );
  });

  it("reserves the full repair-call upper bound before any wire dispatch", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const request = canonicalRequest();
    const wireCall = vi.fn(async () =>
      wireResponse(
        openAIResponsesBody(request.alias, canonicalAcceptedArtifact()),
      ),
    );
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: wireCall }),
      settlementResolver: settlementResolver(),
    });
    const insufficientRunBudget = new ModelEvaluationBudgetGuard(
      plan.envelope.perCallCostCapCents * 2 - 1,
    );

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: request.fixtureId,
        attempt: 1,
        campaignBudget: insufficientRunBudget,
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "budget_stop",
      failureCode: "campaign_budget_exhausted",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    expect(wireCall).not.toHaveBeenCalled();
    expect(insufficientRunBudget.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      blocked: false,
    });

    const probeCandidate = plan.candidates.find(
      (candidate) => candidate.preflight === "capability_probe",
    );
    if (!probeCandidate) throw new Error("test requires a probe candidate");
    const insufficientProbeBudget = new ModelEvaluationBudgetGuard(
      plan.envelope.perCallCostCapCents * 2 - 1,
    );
    const campaign = new ModelEvaluationCapabilityCampaign(
      insufficientProbeBudget,
    );
    await expect(
      campaign.runCanonicalProbe({
        plan,
        candidate: probeCandidate,
        execute: executor.execute,
      }),
    ).resolves.toEqual({
      status: "budget_blocked",
      protocolVerified: false,
      identityVerified: false,
      outputVerified: false,
    });
    expect(wireCall).not.toHaveBeenCalled();
    expect(insufficientProbeBudget.snapshot()).toMatchObject({
      committedCents: 0,
      reservedCents: 0,
      blocked: false,
    });
  });

  it("keeps the original attempt cap after a two-call repair", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const request = canonicalRequest();
    const accepted = canonicalAcceptedArtifact();
    const wireCall = vi
      .fn()
      .mockResolvedValueOnce(
        wireResponse(openAIResponsesBody(request.alias, {}), 30),
      )
      .mockResolvedValueOnce(
        wireResponse(openAIResponsesBody(request.alias, accepted), 30),
      );
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: wireCall }),
      settlementResolver: settlementResolver(),
    });
    const budget = new ModelEvaluationBudgetGuard(
      plan.envelope.perCallCostCapCents * 2,
    );

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: request.fixtureId,
        attempt: 1,
        campaignBudget: budget,
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
      usage: { callCount: 2 },
      costSettlement: { state: "settled", amountCents: 60 },
      budgetCapExceeded: true,
    });
    expect(wireCall).toHaveBeenCalledTimes(2);
    expect(budget.snapshot()).toMatchObject({
      committedCents: 60,
      reservedCents: 0,
      remainingDispatchableCents: plan.envelope.perCallCostCapCents * 2 - 60,
      blocked: true,
      blockReason: "per_call_cap_exceeded",
    });
  });

  it("repairs a task-gate failure without weakening the canonical gate", async () => {
    const request = canonicalRequest();
    const accepted = canonicalAcceptedArtifact();
    const rejected = structuredClone(accepted);
    rejected.factSheet[0] = {
      ...rejected.factSheet[0],
      value: "fabricated unsupported product",
    };
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        wireResponse(openAIResponsesBody(request.alias, rejected)),
      )
      .mockResolvedValueOnce(
        wireResponse(openAIResponsesBody(request.alias, accepted)),
      );
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: call }),
      settlementResolver: settlementResolver(),
    });

    await expect(executor.execute(request)).resolves.toMatchObject({
      artifact: accepted,
      usage: { callCount: 2 },
    });
    expect(call.mock.calls[1][0].body.input.at(-1)?.content).toContain(
      "任务确定性硬门",
    );
  });

  it("returns the final invalid artifact so the harness classifies content_invalid", async () => {
    const request = canonicalRequest();
    const call = vi.fn(async () =>
      wireResponse(openAIResponsesBody(request.alias, {})),
    );
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: call }),
      settlementResolver: settlementResolver(),
    });
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate: plan.candidates[0],
      fixtureId: request.fixtureId,
      attempt: 1,
      campaignBudget: new ModelEvaluationBudgetGuard(100),
      execute: executor.execute,
    });
    expect(result).toMatchObject({
      resultClass: "content_invalid",
      artifactAccepted: false,
      failureCode: "assessment_failed",
      usage: { callCount: 2 },
    });
  });

  it("maps provider errors and aborts with conservative settlement", async () => {
    const unknown = settlementResolver({
      state: "unknown",
      reason: "provider_ack_unknown",
    });
    const providerExecutor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({
        openAIResponses: async () => {
          throw new Error("provider unavailable");
        },
      }),
      settlementResolver: unknown,
    });
    await expect(
      providerExecutor.execute(canonicalRequest()),
    ).rejects.toMatchObject({
      failureCode: "provider_error",
      costSettlement: {
        state: "unknown",
        reason: "provider_ack_unknown",
      },
    });

    const controller = new AbortController();
    const request = { ...canonicalRequest(), signal: controller.signal };
    const observed = vi.fn();
    const abortExecutor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({
        openAIResponses: ({ signal }) =>
          new Promise((_resolve, reject) => {
            observed(signal);
            signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      }),
      settlementResolver: unknown,
    });
    const pending = abortExecutor.execute(request);
    controller.abort(new Error("test abort"));
    await expect(pending).rejects.toMatchObject({
      failureCode: "evaluation_aborted",
    });
    expect(observed).toHaveBeenCalledWith(controller.signal);
  });

  it.each([undefined, null, "invalid"])(
    "maps a malformed wire response to provider_response_invalid with conservative settlement",
    async (wireResult) => {
      const resolver = settlementResolver({
        state: "unknown",
        reason: "provider_ack_unknown",
      });
      const executor = createModelEvaluationProtocolExecutor({
        wireClient: wireClient({
          openAIResponses: async () =>
            wireResult as unknown as ModelEvaluationWireResponse,
        }),
        settlementResolver: resolver,
      });

      await expect(executor.execute(canonicalRequest())).rejects.toMatchObject({
        failureCode: "provider_response_invalid",
        costSettlement: {
          state: "unknown",
          reason: "provider_ack_unknown",
        },
      });
      expect(resolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          callCount: 1,
          usage: null,
          providerReportedCostCents: [null],
        }),
      );
    },
  );

  it("forces provider-reported settlement without wire cost evidence to unknown rather than zero", async () => {
    const request = canonicalRequest();
    const resolver = settlementResolver({
      state: "settled",
      amountCents: 0,
      basis: "provider_reported",
    });
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({
        openAIResponses: async () => ({
          body: openAIResponsesBody(request.alias, canonicalAcceptedArtifact()),
        }),
      }),
      settlementResolver: resolver,
    });
    const result = await executor.execute(request);
    expect(result.costSettlement).toEqual({
      state: "unknown",
      reason: "invalid_settlement",
    });
    expect(result.costSettlement).not.toMatchObject({ amountCents: 0 });
  });

  it("preserves a settled cost and lets the harness fail a cap exceedance", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const request = canonicalRequest();
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({
        openAIResponses: async () =>
          wireResponse(
            openAIResponsesBody(request.alias, canonicalAcceptedArtifact()),
            41,
          ),
      }),
      settlementResolver: settlementResolver({
        state: "settled",
        amountCents: 41,
        basis: "provider_reported",
      }),
    });
    const result = await runTaskEvaluationAttempt({
      plan,
      candidate: plan.candidates[0],
      fixtureId: request.fixtureId,
      attempt: 1,
      campaignBudget: new ModelEvaluationBudgetGuard(100),
      execute: executor.execute,
    });
    expect(result).toMatchObject({
      costSettlement: {
        state: "settled",
        amountCents: 41,
      },
      budgetCapExceeded: true,
      artifactAccepted: true,
    });
  });
});

describe("harness integration and unchanged runtime routes", () => {
  it("rejects arbitrary or wrapped execute callbacks before dispatch and budget reservation", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const wireCall = vi.fn(async () =>
      wireResponse(
        openAIResponsesBody(
          plan.candidates[0].alias,
          canonicalAcceptedArtifact(),
        ),
      ),
    );
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({ openAIResponses: wireCall }),
      settlementResolver: settlementResolver(),
    });
    const wrappedExecute = vi.fn(executor.execute);
    const budget = new ModelEvaluationBudgetGuard(100);
    const before = budget.snapshot();

    expect(isTrustedModelEvaluationProtocolExecute(executor.execute)).toBe(
      true,
    );
    expect(isTrustedModelEvaluationProtocolExecute(wrappedExecute)).toBe(false);
    const weakSetHas = vi.spyOn(WeakSet.prototype, "has").mockReturnValue(true);
    expect(isTrustedModelEvaluationProtocolExecute(wrappedExecute)).toBe(false);
    weakSetHas.mockRestore();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: budget,
        execute: wrappedExecute,
      }),
    ).rejects.toMatchObject({
      failureCode: "untrusted_evaluation_executor",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    expect(wrappedExecute).not.toHaveBeenCalled();
    expect(wireCall).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual(before);

    const probeBudget = new ModelEvaluationBudgetGuard(100);
    const probeBefore = probeBudget.snapshot();
    await expect(
      new ModelEvaluationCapabilityCampaign(probeBudget).runCanonicalProbe({
        plan,
        candidate: plan.candidates[2],
        execute: wrappedExecute,
      }),
    ).rejects.toMatchObject({
      failureCode: "untrusted_evaluation_executor",
    });
    expect(probeBudget.snapshot()).toEqual(probeBefore);
    expect(wrappedExecute).not.toHaveBeenCalled();
    expect(wireCall).not.toHaveBeenCalled();
  });

  it("creates a canonical preflight attestation through the injected executor", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[2];
    const request = canonicalRequest(2);
    const budget = new ModelEvaluationBudgetGuard(100);
    const campaign = new ModelEvaluationCapabilityCampaign(budget);
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({
        openAIResponses: async () =>
          wireResponse(
            openAIResponsesBody(request.alias, canonicalAcceptedArtifact()),
          ),
      }),
      settlementResolver: settlementResolver(),
    });

    await expect(
      campaign.runCanonicalProbe({
        plan,
        candidate,
        execute: executor.execute,
      }),
    ).resolves.toEqual({
      status: "capability_proven",
      protocolVerified: true,
      identityVerified: true,
      outputVerified: true,
    });
    expect(campaign.attestationFor(plan, candidate, budget)).toMatchObject({
      alias: "gpt-5.5",
      actualProtocol: "openai-responses",
      reportedModel: "gpt-5.5",
      resolvedModel: "gpt-5.5",
    });
  });

  it("preserves on-time and late quality while the harness owns the deadlines", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const artifact = canonicalAcceptedArtifact();
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({
        openAIResponses: async () =>
          wireResponse(openAIResponsesBody(candidate.alias, artifact)),
      }),
      settlementResolver: settlementResolver(),
    });
    const onTimeNow = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(plan.envelope.runtimeDeadlineMs);
    const lateNow = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(plan.envelope.runtimeDeadlineMs + 1);

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
        now: onTimeNow,
      }),
    ).resolves.toMatchObject({
      resultClass: "quality_valid_runtime_on_time",
    });
    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
        now: lateNow,
      }),
    ).resolves.toMatchObject({
      resultClass: "quality_valid_runtime_late",
    });
  });

  it("lets the harness hard stop abort the exact wire signal", async () => {
    vi.useFakeTimers();
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const observed = vi.fn();
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: wireClient({
        openAIResponses: ({ signal }) =>
          new Promise((_resolve, reject) => {
            observed(signal);
            signal.addEventListener("abort", () =>
              reject(new Error("hard stop abort")),
            );
          }),
      }),
      settlementResolver: settlementResolver({
        state: "unknown",
        reason: "provider_ack_unknown",
      }),
    });
    const pending = runTaskEvaluationAttempt({
      plan,
      candidate,
      fixtureId: "auto-parts-rich",
      attempt: 1,
      campaignBudget: new ModelEvaluationBudgetGuard(100),
      execute: executor.execute,
      now: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValue(plan.envelope.hardStopMs),
    });
    await vi.advanceTimersByTimeAsync(plan.envelope.hardStopMs);
    await expect(pending).resolves.toMatchObject({
      resultClass: "diagnostic_window_exhausted",
      failureCode: "diagnostic_window_exhausted",
    });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0][0].aborted).toBe(true);
  });

  it("keeps the promoted BrandProfile route, rollback, and all six other current routes unchanged", () => {
    expect(
      modelPolicyRegistry.getActiveTaskPolicy("site_builder.brand_profile"),
    ).toMatchObject({
      state: "promotedRoute",
      route: {
        primary: "gpt-5.6-terra",
        fallbacks: ["claude-sonnet-5"],
      },
    });
    expect(
      modelPolicyRegistry.getLegacyTaskPolicy("site_builder.brand_profile"),
    ).toMatchObject({
      state: "currentRoute",
      route: {
        primary: "deepseek-v4-pro",
        fallbacks: ["glm-5.2"],
      },
    });
    expect(
      SITE_BUILDER_TASK_IDS.slice(1).map((taskId) => [
        taskId,
        modelPolicyRegistry.getActiveTaskPolicy(taskId),
      ]),
    ).toEqual([
      [
        "site_builder.copy",
        expect.objectContaining({
          state: "currentRoute",
          route: {
            primary: "deepseek-v4-pro",
            fallbacks: ["glm-5.2", "doubao-seed-2.0-pro"],
          },
        }),
      ],
      [
        "site_builder.design_spec",
        expect.objectContaining({
          state: "currentRoute",
          route: {
            primary: "minimax-m3",
            fallbacks: ["doubao-seed-2.0-pro"],
          },
        }),
      ],
      [
        "site_builder.assemble",
        expect.objectContaining({
          state: "currentRoute",
          route: {
            primary: "glm-5.2",
            fallbacks: ["deepseek-v4-pro"],
          },
        }),
      ],
      [
        "site_builder.assembly_fix",
        expect.objectContaining({
          state: "currentRoute",
          route: {
            primary: "glm-5.2",
            fallbacks: ["deepseek-v4-pro"],
          },
        }),
      ],
      [
        "site_builder.qa_summarize",
        expect.objectContaining({
          state: "currentRoute",
          route: {
            primary: "deepseek-v4-flash",
            fallbacks: ["doubao-seed-2.0-lite"],
          },
        }),
      ],
      [
        "site_builder.seo_review",
        expect.objectContaining({
          state: "currentRoute",
          route: {
            primary: "deepseek-v4-flash",
            fallbacks: ["doubao-seed-2.0-lite"],
          },
        }),
      ],
    ]);
  });
});
