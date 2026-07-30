import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { BRAND_PROFILE_TASK } from "../agents/brand-profile";
import { modelPolicyRegistry } from "../agents/model-policy.registry";
import {
  ModelEvaluationBudgetGuard,
  ModelEvaluationCallError,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
  runLegacyComparatorEvaluationAttempt,
  runTaskEvaluationAttempt,
  type ModelEvaluationExecutionRequest,
} from "./model-evaluation-harness";
import {
  createCredentialBoundModelEvaluationWireClient,
  createFileBackedModelEvaluationAuthorizationLedger,
  createModelEvaluationProtocolExecutor as createRawModelEvaluationProtocolExecutor,
  MODEL_EVALUATION_TRANSPORT_RESPONSE_BODY_LIMIT_BYTES,
  modelEvaluationLedgerDirectorySha256,
  type ModelEvaluationWireClient,
} from "./model-evaluation-executor";
import {
  bindFakeModelEvaluationWireCredential,
  createFakeModelEvaluationAuthorizationLedger,
  createFakeModelEvaluationCostSafety,
} from "./model-evaluation-cost-safety.spec-support";
import {
  createModelEvaluationCostSafetyAttestation,
  type ModelEvaluationCostSafetyInput,
} from "./model-evaluation-cost-safety";

function createModelEvaluationProtocolExecutor(
  deps: Omit<
    Parameters<typeof createRawModelEvaluationProtocolExecutor>[0],
    "authorizationLedger" | "costSafety"
  >,
) {
  const costSafety = createFakeModelEvaluationCostSafety(
    deps.settlementResolver.resolverId,
  );
  return createRawModelEvaluationProtocolExecutor({
    ...deps,
    wireClient: bindFakeModelEvaluationWireCredential(
      deps.wireClient,
      costSafety,
    ),
    authorizationLedger:
      createFakeModelEvaluationAuthorizationLedger(costSafety),
    costSafety,
  });
}

function fakeWireClient(openAIResponses: ReturnType<typeof vi.fn>) {
  return {
    openAIResponses,
    anthropicMessages: vi.fn(async () => {
      throw new Error("unexpected Messages dispatch");
    }),
    openAIChatCompletions: vi.fn(async () => {
      throw new Error("unexpected Chat dispatch");
    }),
  } satisfies ModelEvaluationWireClient;
}

function fakeResolver() {
  return {
    resolverId: "authorization-spec-settlement/v1",
    resolve: (context: {
      executionId: string;
      providerReportedCostCents: readonly (number | null)[];
    }) => {
      const costs = context.providerReportedCostCents;
      return costs.every((amount): amount is number => amount !== null)
        ? {
            state: "settled" as const,
            amountCents: costs.reduce((sum, amount) => sum + amount, 0),
            basis: "provider_reported" as const,
            executionId: context.executionId,
          }
        : {
            state: "unknown" as const,
            reason: "provider_ack_unknown" as const,
          };
    },
  };
}

function designSpecTargetOnlyCostSafetyInput(
  resolverId: string,
): ModelEvaluationCostSafetyInput {
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const input = structuredClone(
    createFakeModelEvaluationCostSafety(resolverId),
  ) as ModelEvaluationCostSafetyInput;
  const allowedDispatches = plan.candidates.map((candidate) => ({
    mode: "target" as const,
    alias: candidate.alias,
    protocol: candidate.expectedProtocol,
  }));
  input.authorization.approvedDispatchExecutions = 73;
  input.credential.allowedDispatches = allowedDispatches;
  input.pricing.entries = allowedDispatches.map(({ alias, protocol }) => ({
    alias,
    protocol,
    inputCentsPerMillionTokens: 1,
    outputCentsPerMillionTokens: 2,
  }));
  input.limits.maxDispatchExecutions = 73;
  input.limits.maxWireCalls = 146;
  return input;
}

function replaceLoadedContractsModuleIdentity(): () => void {
  const cachePath = Object.keys(require.cache).find((path) =>
    path.endsWith("/packages/contracts/dist/site-builder/design-catalog-v2.js"),
  );
  if (!cachePath) throw new Error("loaded design catalog contract not found");
  const original = require.cache[cachePath];
  if (!original) throw new Error("loaded design catalog contract disappeared");
  const replacement = Object.assign(
    Object.create(Object.getPrototypeOf(original)),
    original,
  ) as NodeModule;
  require.cache[cachePath] = replacement;
  return () => {
    require.cache[cachePath] = original;
  };
}

function directRequest(): ModelEvaluationExecutionRequest {
  const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
  const candidate = plan.candidates[0];
  const evaluationCase = buildCanonicalModelEvaluationCase(
    plan,
    "auto-parts-rich",
  );
  return {
    executionId: "authorization-spec:direct:1",
    taskId: plan.taskId,
    profile: plan.profile,
    alias: candidate.alias,
    expectedProtocol: candidate.expectedProtocol,
    fixtureId: evaluationCase.contract.fixtureId,
    attempt: 1,
    maxTokens: plan.envelope.maxTokens,
    runtimeDeadlineMs: plan.envelope.runtimeDeadlineMs,
    hardStopMs: plan.envelope.hardStopMs,
    perCallCostCapCents: plan.envelope.perCallCostCapCents,
    reasoningEffort: plan.envelope.reasoningEffort,
    outputSchema: BRAND_PROFILE_TASK.outputSchema,
    repairTaskOutput: plan.evaluationSuite!.repairTaskOutput,
    caseContract: evaluationCase.contract,
    casePayload: evaluationCase.payload,
    signal: new AbortController().signal,
  };
}

describe("model evaluation executor authorization", () => {
  it("constructs transport from the captured credential handle instead of a mutable preconfigured client", async () => {
    const credential = {
      attestationId: "fake-evaluation-credential/transport-boundary",
      snapshotSha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bearerTokenSha256: createHash("sha256")
        .update("limited-evaluation-secret")
        .digest("hex"),
      gatewayOrigin: "https://fake-model-evaluation.invalid",
      bearerToken: "limited-evaluation-secret",
    };
    const observedAuthorization: string[] = [];
    const fakeFetch = vi.fn(async (_input, init?: RequestInit) => {
      observedAuthorization.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential,
      baseUrl: "https://fake-model-evaluation.invalid/v1",
      fetch: fakeFetch as typeof fetch,
    });
    credential.bearerToken = "historical-broad-secret";

    await wireClient.openAIResponses({
      executionId: "credential-boundary:1",
      body: {
        model: "gpt-5.6-terra",
        input: [{ role: "user", content: "probe" }],
        max_output_tokens: 1,
        temperature: 0,
        text: { format: { type: "json_object" } },
      },
      signal: new AbortController().signal,
    });

    expect(observedAuthorization).toEqual(["Bearer limited-evaluation-secret"]);
  });

  it("rejects a bearer secret that does not match the attested digest", () => {
    expect(() =>
      createCredentialBoundModelEvaluationWireClient({
        credential: {
          attestationId: "fake-evaluation-credential/secret-mismatch",
          snapshotSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          bearerTokenSha256: createHash("sha256")
            .update("dedicated-limited-secret")
            .digest("hex"),
          gatewayOrigin: "https://fake-model-evaluation.invalid",
          bearerToken: "historical-broad-secret",
        },
        baseUrl: "https://fake-model-evaluation.invalid/v1",
        fetch: vi.fn() as typeof fetch,
      }),
    ).toThrow("attested evaluation credential handle");
  });

  it("rejects a transport origin that does not match the credential attestation", () => {
    const bearerToken = "limited-evaluation-secret";
    expect(() =>
      createCredentialBoundModelEvaluationWireClient({
        credential: {
          attestationId: "fake-evaluation-credential/origin-mismatch",
          snapshotSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          bearerTokenSha256: createHash("sha256")
            .update(bearerToken)
            .digest("hex"),
          gatewayOrigin: "https://expected-gateway.invalid",
          bearerToken,
        },
        baseUrl: "https://attacker-controlled.invalid/v1",
        fetch: vi.fn() as typeof fetch,
      }),
    ).toThrow("gateway origin does not match");
  });

  it("admits the explicitly loopback-bound Ubuntu development gateway over HTTP", async () => {
    const bearerToken = "limited-evaluation-secret";
    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential: {
        attestationId: "fake-evaluation-credential/loopback-http",
        snapshotSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bearerTokenSha256: createHash("sha256")
          .update(bearerToken)
          .digest("hex"),
        gatewayOrigin: "http://127.0.0.1:3001",
        bearerToken,
      },
      baseUrl: "http://127.0.0.1:3001/v1",
      fetch: fakeFetch as typeof fetch,
    });

    await wireClient.openAIResponses({
      executionId: "loopback-http:1",
      body: {
        model: "gpt-5.6-terra",
        input: [{ role: "user", content: "probe" }],
        max_output_tokens: 1,
        temperature: 0,
        text: { format: { type: "json_object" } },
      },
      signal: new AbortController().signal,
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-loopback HTTP before fetch", () => {
    const bearerToken = "limited-evaluation-secret";
    expect(() =>
      createCredentialBoundModelEvaluationWireClient({
        credential: {
          attestationId: "fake-evaluation-credential/remote-http",
          snapshotSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          bearerTokenSha256: createHash("sha256")
            .update(bearerToken)
            .digest("hex"),
          gatewayOrigin: "http://new-api.example.invalid",
          bearerToken,
        },
        baseUrl: "http://new-api.example.invalid/v1",
        fetch: vi.fn() as typeof fetch,
      }),
    ).toThrow("HTTPS or explicit loopback HTTP");
  });

  it("adds the Anthropic protocol version header only to Messages", async () => {
    const observedHeaders: Headers[] = [];
    const fakeFetch = vi.fn(async (_input, init?: RequestInit) => {
      observedHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const bearerToken = "limited-evaluation-secret";
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential: {
        attestationId: "fake-evaluation-credential/protocol-headers",
        snapshotSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bearerTokenSha256: createHash("sha256")
          .update(bearerToken)
          .digest("hex"),
        gatewayOrigin: "https://fake-model-evaluation.invalid",
        bearerToken,
      },
      baseUrl: "https://fake-model-evaluation.invalid/v1",
      fetch: fakeFetch as typeof fetch,
    });

    await wireClient.anthropicMessages({
      executionId: "protocol-headers:messages",
      body: {
        model: "claude-sonnet-5",
        system: "system",
        messages: [{ role: "user", content: "probe" }],
        max_tokens: 1,
        temperature: 0,
      },
      signal: new AbortController().signal,
    });
    await wireClient.openAIResponses({
      executionId: "protocol-headers:responses",
      body: {
        model: "gpt-5.6-terra",
        input: [{ role: "user", content: "probe" }],
        max_output_tokens: 1,
        temperature: 0,
        text: { format: { type: "json_object" } },
      },
      signal: new AbortController().signal,
    });

    expect(observedHeaders[0]?.get("anthropic-version")).toBe("2023-06-01");
    expect(observedHeaders[1]?.has("anthropic-version")).toBe(false);
  });

  it("preserves a provider cost observation on non-success HTTP responses", async () => {
    const bearerToken = "limited-evaluation-secret";
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential: {
        attestationId: "fake-evaluation-credential/http-cost",
        snapshotSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bearerTokenSha256: createHash("sha256")
          .update(bearerToken)
          .digest("hex"),
        gatewayOrigin: "https://fake-model-evaluation.invalid",
        bearerToken,
      },
      baseUrl: "https://fake-model-evaluation.invalid/v1",
      fetch: vi.fn(
        async () =>
          new Response("provider rejected after acceptance", {
            status: 429,
            headers: { "x-provider-cost-cents": "7" },
          }),
      ) as typeof fetch,
    });

    await expect(
      wireClient.openAIResponses({
        executionId: "http-cost:1",
        body: {
          model: "gpt-5.6-terra",
          input: [{ role: "user", content: "probe" }],
          max_output_tokens: 1,
          temperature: 0,
          text: { format: { type: "json_object" } },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      providerReportedCostCents: 7,
    });
  });

  it("preserves a non-success provider cost when body cancellation fails", async () => {
    const bearerToken = "limited-evaluation-secret";
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential: {
        attestationId: "fake-evaluation-credential/http-cancel-cost",
        snapshotSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bearerTokenSha256: createHash("sha256")
          .update(bearerToken)
          .digest("hex"),
        gatewayOrigin: "https://fake-model-evaluation.invalid",
        bearerToken,
      },
      baseUrl: "https://fake-model-evaluation.invalid/v1",
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                throw new Error("stream cancellation failed");
              },
            }),
            {
              status: 429,
              headers: { "x-provider-cost-cents": "7" },
            },
          ),
      ) as typeof fetch,
    });

    await expect(
      wireClient.openAIResponses({
        executionId: "http-cancel-cost:1",
        body: {
          model: "gpt-5.6-terra",
          input: [{ role: "user", content: "probe" }],
          max_output_tokens: 1,
          temperature: 0,
          text: { format: { type: "json_object" } },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      providerReportedCostCents: 7,
    });
  });

  it("settles a non-success response from its preserved provider cost", async () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);
    const bearerToken = "fake-limited-evaluation-token";
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential: {
        attestationId: costSafety.credential.attestationId,
        snapshotSha256: costSafety.credential.snapshotSha256,
        bearerTokenSha256: costSafety.credential.bearerTokenSha256,
        gatewayOrigin: costSafety.credential.gatewayOrigin,
        bearerToken,
      },
      baseUrl: "https://fake-model-evaluation.invalid/v1",
      fetch: vi.fn(
        async () =>
          new Response("provider rejected after acceptance", {
            status: 429,
            headers: { "x-provider-cost-cents": "7" },
          }),
      ) as typeof fetch,
    });
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient,
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "capability_unavailable",
      costSettlement: {
        state: "settled",
        amountCents: 7,
        basis: `${"provider_reported"}@${resolver.resolverId}`,
      },
    });
  });

  it("settles a successful response parse failure from its preserved provider cost", async () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential: {
        attestationId: costSafety.credential.attestationId,
        snapshotSha256: costSafety.credential.snapshotSha256,
        bearerTokenSha256: costSafety.credential.bearerTokenSha256,
        gatewayOrigin: costSafety.credential.gatewayOrigin,
        bearerToken: "fake-limited-evaluation-token",
      },
      baseUrl: "https://fake-model-evaluation.invalid/v1",
      fetch: vi.fn(
        async () =>
          new Response("{not-json", {
            status: 200,
            headers: { "x-provider-cost-cents": "7" },
          }),
      ) as typeof fetch,
    });
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient,
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "capability_unavailable",
      costSettlement: {
        state: "settled",
        amountCents: 7,
        basis: `${"provider_reported"}@${resolver.resolverId}`,
      },
    });
  });

  it("rejects an oversized chunked response before JSON parsing", async () => {
    const oversizedChunk = new Uint8Array(
      MODEL_EVALUATION_TRANSPORT_RESPONSE_BODY_LIMIT_BYTES + 1,
    );
    const fakeFetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversizedChunk);
            controller.close();
          },
        }),
        { status: 200 },
      );
    });
    const wireClient = createCredentialBoundModelEvaluationWireClient({
      credential: {
        attestationId: "fake-evaluation-credential/response-boundary",
        snapshotSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        bearerTokenSha256: createHash("sha256")
          .update("limited-evaluation-secret")
          .digest("hex"),
        gatewayOrigin: "https://fake-model-evaluation.invalid",
        bearerToken: "limited-evaluation-secret",
      },
      baseUrl: "https://fake-model-evaluation.invalid/v1",
      fetch: fakeFetch as typeof fetch,
    });

    await expect(
      wireClient.openAIResponses({
        executionId: "response-boundary:1",
        body: {
          model: "gpt-5.6-terra",
          input: [{ role: "user", content: "probe" }],
          max_output_tokens: 1,
          temperature: 0,
          text: { format: { type: "json_object" } },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("evaluation transport response body exceeds byte limit");
  });

  it("requires the immutable wire credential identity to match the attestation", () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);

    expect(() =>
      createRawModelEvaluationProtocolExecutor({
        wireClient: fakeWireClient(vi.fn()),
        authorizationLedger:
          createFakeModelEvaluationAuthorizationLedger(costSafety),
        settlementResolver: resolver,
        costSafety,
      }),
    ).toThrow("trusted cost safety must match");
  });

  it("uses captured brand intrinsics after WeakMap and WeakSet monkeypatches", () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);
    const untrustedWire = Object.assign(fakeWireClient(vi.fn()), {
      credentialAttestationId: costSafety.credential.attestationId,
      credentialSnapshotSha256: costSafety.credential.snapshotSha256,
      credentialBearerTokenSha256: costSafety.credential.bearerTokenSha256,
      credentialGatewayOrigin: costSafety.credential.gatewayOrigin,
    });
    const duckLedger = {
      ledgerId: costSafety.authorization.ledgerId,
      directorySha256: costSafety.authorization.ledgerDirectorySha256,
      claim: vi.fn(() => true),
      reserve: vi.fn(() => true),
      settle: vi.fn(() => true),
      freeze: vi.fn(() => true),
    };
    const weakMapGet = vi.spyOn(WeakMap.prototype, "get").mockReturnValue({
      credentialAttestationId: costSafety.credential.attestationId,
      credentialSnapshotSha256: costSafety.credential.snapshotSha256,
      credentialBearerTokenSha256: costSafety.credential.bearerTokenSha256,
      credentialGatewayOrigin: costSafety.credential.gatewayOrigin,
    });
    const weakSetHas = vi.spyOn(WeakSet.prototype, "has").mockReturnValue(true);
    let thrown: unknown;
    try {
      try {
        createRawModelEvaluationProtocolExecutor({
          wireClient: untrustedWire,
          authorizationLedger: duckLedger,
          settlementResolver: resolver,
          costSafety,
        });
      } catch (error) {
        thrown = error;
      }
    } finally {
      weakMapGet.mockRestore();
      weakSetHas.mockRestore();
    }
    expect(thrown).toMatchObject({
      message: expect.stringContaining("trusted cost safety must match"),
    });
  });

  it("rejects a ledger directory that does not match the spend authorization", async () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);
    const unrelatedDirectory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-mismatch-spec-"),
    );
    try {
      expect(() =>
        createRawModelEvaluationProtocolExecutor({
          wireClient: bindFakeModelEvaluationWireCredential(
            fakeWireClient(vi.fn()),
            costSafety,
          ),
          authorizationLedger:
            createFileBackedModelEvaluationAuthorizationLedger({
              ledgerId: costSafety.authorization.ledgerId,
              directory: unrelatedDirectory,
            }),
          settlementResolver: resolver,
          costSafety,
        }),
      ).toThrow("trusted cost safety must match");
    } finally {
      await rm(unrelatedDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked durable ledger directory", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-symlink-spec-"),
    );
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    try {
      await mkdir(target);
      await symlink(target, linked);
      expect(() =>
        createFileBackedModelEvaluationAuthorizationLedger({
          ledgerId: "symlink-spec-ledger/durable-v1",
          directory: linked,
        }),
      ).toThrow("stable real directory");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects a durable ledger directory whose device or inode identity changed", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-replaced-spec-"),
    );
    const directory = join(parent, "ledger");
    const resolver = fakeResolver();
    const ledgerId = "replaced-spec-ledger/durable-v1";
    try {
      const costSafety = createFakeModelEvaluationCostSafety(
        resolver.resolverId,
        10_000,
        { ledgerId, directory },
      );
      await rename(directory, join(parent, "original-ledger"));
      await mkdir(directory);
      expect(() =>
        createRawModelEvaluationProtocolExecutor({
          wireClient: bindFakeModelEvaluationWireCredential(
            fakeWireClient(vi.fn()),
            costSafety,
          ),
          authorizationLedger:
            createFileBackedModelEvaluationAuthorizationLedger({
              ledgerId,
              directory,
            }),
          settlementResolver: resolver,
          costSafety,
        }),
      ).toThrow("trusted cost safety must match");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("changes durable ledger identity when a deleted directory is recreated", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-marker-spec-"),
    );
    try {
      const first = modelEvaluationLedgerDirectorySha256(directory);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory);
      const second = modelEvaluationLedgerDirectorySha256(directory);
      expect(second).not.toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a malformed durable ledger directory marker", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-invalid-marker-spec-"),
    );
    try {
      modelEvaluationLedgerDirectorySha256(directory);
      await writeFile(
        join(directory, ".site-builder-model-evaluation-ledger-id"),
        "00000000-0000-0000-0000-000000000000\n",
        "utf8",
      );
      expect(() => modelEvaluationLedgerDirectorySha256(directory)).toThrow(
        "directory marker is invalid",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows one executor factory to claim an authorization id only once", () => {
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(resolver.resolverId);
    const firstWire = fakeWireClient(vi.fn());
    const secondWire = fakeWireClient(vi.fn());

    expect(() =>
      createRawModelEvaluationProtocolExecutor({
        wireClient: bindFakeModelEvaluationWireCredential(
          firstWire,
          costSafety,
        ),
        authorizationLedger:
          createFakeModelEvaluationAuthorizationLedger(costSafety),
        settlementResolver: resolver,
        costSafety,
      }),
    ).not.toThrow();
    expect(() =>
      createRawModelEvaluationProtocolExecutor({
        wireClient: bindFakeModelEvaluationWireCredential(
          secondWire,
          costSafety,
        ),
        authorizationLedger:
          createFakeModelEvaluationAuthorizationLedger(costSafety),
        settlementResolver: fakeResolver(),
        costSafety,
      }),
    ).toThrow("trusted cost safety must match");
  });

  it("rejects an authorization already claimed in the durable ledger before wire dispatch", async () => {
    const resolver = fakeResolver();
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-restart-spec-"),
    );
    const ledgerId = "restart-spec-ledger/durable-v1";
    const costSafety = createFakeModelEvaluationCostSafety(
      resolver.resolverId,
      10_000,
      { ledgerId, directory },
    );
    try {
      const priorProcessLedger =
        createFileBackedModelEvaluationAuthorizationLedger({
          ledgerId,
          directory,
        });
      await expect(
        Promise.resolve(
          priorProcessLedger.claim({
            authorizationId: costSafety.authorization.authorizationId,
            executorClaimId: "claim-from-prior-process",
            campaignBudgetCents: costSafety.limits.campaignBudgetCents,
            maxDispatchExecutions: costSafety.limits.maxDispatchExecutions,
            maxWireCalls: costSafety.limits.maxWireCalls,
          }),
        ),
      ).resolves.toBe(true);
      const authorizationLedger =
        createFileBackedModelEvaluationAuthorizationLedger({
          ledgerId,
          directory,
        });
      const wire = vi.fn();
      expect(() =>
        createRawModelEvaluationProtocolExecutor({
          wireClient: bindFakeModelEvaluationWireCredential(
            fakeWireClient(wire),
            costSafety,
          ),
          authorizationLedger,
          settlementResolver: resolver,
          costSafety,
        }),
      ).toThrow("trusted cost safety must match");
      expect(wire).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a claimed authorization after its JSONL file is deleted", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-deleted-claim-spec-"),
    );
    const ledgerId = "deleted-claim-spec-ledger/durable-v1";
    const claim = {
      authorizationId: "deleted-claim-spec/authorization-v1",
      executorClaimId: "deleted-claim-spec/executor-v1",
      campaignBudgetCents: 100,
      maxDispatchExecutions: 1,
      maxWireCalls: 1,
    };
    try {
      const priorProcessLedger =
        createFileBackedModelEvaluationAuthorizationLedger({
          ledgerId,
          directory,
        });
      expect(priorProcessLedger.claim(claim)).toBe(true);
      const claimFiles = (await readdir(directory)).filter((entry) =>
        entry.endsWith(".jsonl"),
      );
      expect(claimFiles).toHaveLength(1);
      await rm(join(directory, claimFiles[0]!), { force: true });

      const restartedLedger =
        createFileBackedModelEvaluationAuthorizationLedger({
          ledgerId,
          directory,
        });
      expect(restartedLedger.claim(claim)).toBe(false);
      expect(
        (await readdir(directory)).filter((entry) => entry.endsWith(".jsonl")),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a rewritten marker claim history instead of adopting it as authoritative", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-rewritten-marker-spec-"),
    );
    const ledger = createFileBackedModelEvaluationAuthorizationLedger({
      ledgerId: "rewritten-marker-spec-ledger/durable-v1",
      directory,
    });
    const firstAuthorizationId = "rewritten-marker-spec/authorization-first-v1";
    const secondAuthorizationId =
      "rewritten-marker-spec/authorization-second-v1";
    const claim = (authorizationId: string) => ({
      authorizationId,
      executorClaimId: `rewritten-marker-spec/${authorizationId.split("/").at(-1)}`,
      campaignBudgetCents: 100,
      maxDispatchExecutions: 1,
      maxWireCalls: 1,
    });
    const markerPath = join(
      directory,
      ".site-builder-model-evaluation-ledger-id",
    );
    try {
      expect(ledger.claim(claim(firstAuthorizationId))).toBe(true);
      const originalDigest = createHash("sha256")
        .update(firstAuthorizationId)
        .digest("hex");
      const replacementDigest = createHash("sha256")
        .update(secondAuthorizationId)
        .digest("hex");
      const marker = await readFile(markerPath, "utf8");
      expect(marker).toContain(`claim:${originalDigest}\n`);
      await writeFile(
        markerPath,
        marker.replace(
          `claim:${originalDigest}\n`,
          `claim:${replacementDigest}\n`,
        ),
        { flag: "w", mode: 0o600 },
      );

      expect(() => ledger.claim(claim(secondAuthorizationId))).toThrow(
        "append-only claim history changed",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes marker claims without burning an authorization on lock contention", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-claim-lock-spec-"),
    );
    const ledger = createFileBackedModelEvaluationAuthorizationLedger({
      ledgerId: "claim-lock-spec-ledger/durable-v1",
      directory,
    });
    const claim = {
      authorizationId: "claim-lock-spec/authorization-v1",
      executorClaimId: "claim-lock-spec/executor-v1",
      campaignBudgetCents: 100,
      maxDispatchExecutions: 1,
      maxWireCalls: 1,
    };
    const lockPath = join(
      directory,
      ".site-builder-model-evaluation-claim.lock",
    );
    try {
      await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
      expect(() => ledger.claim(claim)).toThrow(
        "claim index is locked; retry without reissuing authorization",
      );
      await rm(lockPath, { force: true });
      expect(ledger.claim(claim)).toBe(true);
      expect(await readdir(directory)).not.toContain(
        ".site-builder-model-evaluation-claim.lock",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets the same spend authorization retry after transient claim lock contention", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-executor-lock-retry-spec-"),
    );
    const ledgerId = "executor-lock-retry-spec-ledger/durable-v1";
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(
      resolver.resolverId,
      10_000,
      { ledgerId, directory },
    );
    const wire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: "gpt-5.6-terra",
        output: [{ content: [{ type: "output_text", text: "" }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      providerReportedCostCents: 1,
    }));
    const lockPath = join(
      directory,
      ".site-builder-model-evaluation-claim.lock",
    );
    try {
      const executor = createRawModelEvaluationProtocolExecutor({
        wireClient: bindFakeModelEvaluationWireCredential(
          fakeWireClient(wire),
          costSafety,
        ),
        authorizationLedger: createFileBackedModelEvaluationAuthorizationLedger(
          {
            ledgerId,
            directory,
          },
        ),
        settlementResolver: resolver,
        costSafety,
      });
      const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
      await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });

      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate: plan.candidates[0],
          fixtureId: "auto-parts-rich",
          attempt: 1,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: executor.execute,
        }),
      ).resolves.toMatchObject({
        resultClass: "capability_unavailable",
      });
      expect(wire).not.toHaveBeenCalled();

      await rm(lockPath, { force: true });
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate: plan.candidates[0],
          fixtureId: "auto-parts-rich",
          attempt: 2,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: executor.execute,
        }),
      ).resolves.toMatchObject({
        resultClass: "content_invalid",
      });
      expect(wire).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("durably freezes the authorization when the first call reaches the attempt cap", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-at-cap-freeze-spec-"),
    );
    const ledgerId = "at-cap-freeze-spec-ledger/durable-v1";
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(
      resolver.resolverId,
      10_000,
      { ledgerId, directory },
    );
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const wire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: plan.candidates[0]!.alias,
        output: [{ content: [{ type: "output_text", text: "{}" }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      providerReportedCostCents: plan.envelope.perCallCostCapCents,
    }));
    try {
      const executor = createRawModelEvaluationProtocolExecutor({
        wireClient: bindFakeModelEvaluationWireCredential(
          fakeWireClient(wire),
          costSafety,
        ),
        authorizationLedger: createFileBackedModelEvaluationAuthorizationLedger(
          {
            ledgerId,
            directory,
          },
        ),
        settlementResolver: resolver,
        costSafety,
      });

      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate: plan.candidates[0],
          fixtureId: "auto-parts-rich",
          attempt: 1,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: executor.execute,
        }),
      ).resolves.toMatchObject({
        resultClass: "capability_unavailable",
      });
      expect(wire).toHaveBeenCalledTimes(1);
      const claimFile = (await readdir(directory)).find((entry) =>
        entry.endsWith(".jsonl"),
      );
      expect(claimFile).toBeDefined();
      const events = (await readFile(join(directory, claimFile!), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; reason?: string });
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "authorization_frozen",
          reason: "known_attempt_cost_cap_reached_before_repair",
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a complete claim lock whose process identity no longer exists", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-stale-claim-lock-spec-"),
    );
    const ledger = createFileBackedModelEvaluationAuthorizationLedger({
      ledgerId: "stale-claim-lock-spec-ledger/durable-v1",
      directory,
    });
    const lockPath = join(
      directory,
      ".site-builder-model-evaluation-claim.lock",
    );
    const claim = {
      authorizationId: "stale-claim-lock-spec/authorization-v1",
      executorClaimId: "stale-claim-lock-spec/executor-v1",
      campaignBudgetCents: 100,
      maxDispatchExecutions: 1,
      maxWireCalls: 1,
    };
    try {
      const staleOwner = {
        pid: 2_147_483_647,
        bootId: (
          await readFile("/proc/sys/kernel/random/boot_id", "utf8")
        ).trim(),
        processStartTimeTicks: "1",
        nonce: "00000000-0000-4000-8000-000000000001",
      };
      const staleTemporaryPath = `${lockPath}.${staleOwner.pid}.${staleOwner.nonce}.tmp`;
      await writeFile(staleTemporaryPath, `${JSON.stringify(staleOwner)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await link(staleTemporaryPath, lockPath);

      expect(ledger.claim(claim)).toBe(true);
      const entries = await readdir(directory);
      expect(entries).not.toContain(
        ".site-builder-model-evaluation-claim.lock",
      );
      expect(entries).not.toContain(staleTemporaryPath.split("/").at(-1));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not recover a complete claim lock owned by the current process", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-live-claim-lock-spec-"),
    );
    const ledger = createFileBackedModelEvaluationAuthorizationLedger({
      ledgerId: "live-claim-lock-spec-ledger/durable-v1",
      directory,
    });
    const lockPath = join(
      directory,
      ".site-builder-model-evaluation-claim.lock",
    );
    const processStat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const commandEnd = processStat.lastIndexOf(")");
    const processStartTimeTicks = processStat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/)[19];
    if (!processStartTimeTicks || !/^\d+$/.test(processStartTimeTicks)) {
      throw new Error("test requires the current Linux process start time");
    }
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid: process.pid,
          bootId: (
            await readFile("/proc/sys/kernel/random/boot_id", "utf8")
          ).trim(),
          processStartTimeTicks,
          nonce: "00000000-0000-4000-8000-000000000002",
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );

      expect(() =>
        ledger.claim({
          authorizationId: "live-claim-lock-spec/authorization-v1",
          executorClaimId: "live-claim-lock-spec/executor-v1",
          campaignBudgetCents: 100,
          maxDispatchExecutions: 1,
          maxWireCalls: 1,
        }),
      ).toThrow("claim index is locked; retry without reissuing authorization");
      expect(await readdir(directory)).toContain(
        ".site-builder-model-evaluation-claim.lock",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a replaced or symlinked claim file before ledger append", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-file-identity-spec-"),
    );
    const ledger = createFileBackedModelEvaluationAuthorizationLedger({
      ledgerId: "claim-file-identity-spec/durable-v1",
      directory,
    });
    const authorizationId = "claim-file-identity-spec/authorization-v1";
    const claim = {
      authorizationId,
      executorClaimId: "claim-file-identity-spec/executor-v1",
      campaignBudgetCents: 100,
      maxDispatchExecutions: 1,
      maxWireCalls: 1,
    };
    try {
      expect(ledger.claim(claim)).toBe(true);
      const filePath = join(
        directory,
        `${createHash("sha256").update(authorizationId).digest("hex")}.jsonl`,
      );
      const originalPath = `${filePath}.original`;
      await rename(filePath, originalPath);
      await symlink(originalPath, filePath);

      expect(() =>
        ledger.reserve({
          authorizationId,
          executorClaimId: claim.executorClaimId,
          executionId: "claim-file-identity-spec:1",
          wireCalls: 1,
          upperBoundCents: 1,
        }),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not claim durable authorization for an unbranded request", async () => {
    const resolver = fakeResolver();
    const directory = await mkdtemp(
      join(tmpdir(), "evaluation-ledger-prevalidation-spec-"),
    );
    const ledgerId = "prevalidation-spec-ledger/durable-v1";
    const costSafety = createFakeModelEvaluationCostSafety(
      resolver.resolverId,
      10_000,
      { ledgerId, directory },
    );
    const wire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: "gpt-5.6-terra",
        output: [{ content: [{ type: "output_text", text: "" }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      providerReportedCostCents: 1,
    }));
    try {
      const executor = createRawModelEvaluationProtocolExecutor({
        wireClient: bindFakeModelEvaluationWireCredential(
          fakeWireClient(wire),
          costSafety,
        ),
        authorizationLedger: createFileBackedModelEvaluationAuthorizationLedger(
          {
            ledgerId,
            directory,
          },
        ),
        settlementResolver: resolver,
        costSafety,
      });

      await expect(executor.execute(directRequest())).rejects.toMatchObject({
        failureCode: "evaluation_dispatch_not_authorized",
      });
      expect(await readdir(directory)).toEqual([
        ".site-builder-model-evaluation-ledger-id",
      ]);

      const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate: plan.candidates[0],
          fixtureId: "auto-parts-rich",
          attempt: 1,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: executor.execute,
        }),
      ).resolves.toMatchObject({
        resultClass: "content_invalid",
      });
      expect(await readdir(directory)).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects direct target and legacy dispatch before any wire call", async () => {
    const targetWire = vi.fn();
    const wireClient = fakeWireClient(targetWire);
    const executor = createModelEvaluationProtocolExecutor({
      wireClient,
      settlementResolver: fakeResolver(),
    });
    const target = directRequest();
    const legacy = {
      ...target,
      executionId: "authorization-spec:legacy:1",
      alias: modelPolicyRegistry.getLegacyTaskPolicy(target.taskId).route
        .primary,
      expectedProtocol: "openai-chat-completions" as const,
    };

    await expect(executor.execute(target)).rejects.toMatchObject({
      failureCode: "evaluation_dispatch_not_authorized",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    await expect(
      executor.executeLegacyComparator(legacy),
    ).rejects.toMatchObject({
      failureCode: "evaluation_dispatch_not_authorized",
    });
    expect(targetWire).not.toHaveBeenCalled();
    expect(wireClient.openAIChatCompletions).not.toHaveBeenCalled();
  });

  it("authorizes a canonical legacy comparator through the harness runner", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const alias = modelPolicyRegistry.getLegacyTaskPolicy(plan.taskId).route
      .primary;
    const artifact = {
      valueProps: [],
      glossary: [],
      keywords: [],
      differentiators: [],
      competitors: [],
      gaps: [],
      factSheet: [],
    };
    const chat = vi.fn(async () => ({
      body: {
        model: alias,
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(artifact) },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      providerReportedCostCents: 1,
    }));
    const executor = createModelEvaluationProtocolExecutor({
      wireClient: {
        openAIResponses: vi.fn(async () => {
          throw new Error("unexpected Responses dispatch");
        }),
        anthropicMessages: vi.fn(async () => {
          throw new Error("unexpected Messages dispatch");
        }),
        openAIChatCompletions: chat,
      },
      settlementResolver: fakeResolver(),
    });

    await expect(
      runLegacyComparatorEvaluationAttempt({
        plan,
        alias,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        executeLegacyComparator: executor.executeLegacyComparator,
      }),
    ).resolves.toMatchObject({
      actualProtocol: "openai-chat-completions",
      requestedModel: alias,
      reportedModel: alias,
      costSettlement: { state: "settled", amountCents: 1 },
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("binds one budget campaign to one branded executor identity", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const firstWire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: candidate.alias,
        output: [{ content: [{ type: "output_text", text: "" }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      providerReportedCostCents: 1,
    }));
    const secondWire = vi.fn();
    const firstExecutor = createModelEvaluationProtocolExecutor({
      wireClient: fakeWireClient(firstWire),
      settlementResolver: fakeResolver(),
    });
    const secondExecutor = createModelEvaluationProtocolExecutor({
      wireClient: fakeWireClient(secondWire),
      settlementResolver: fakeResolver(),
    });
    const budget = new ModelEvaluationBudgetGuard(100);

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: budget,
        execute: firstExecutor.execute,
      }),
    ).resolves.toMatchObject({
      resultClass: "content_invalid",
    });
    const snapshot = budget.snapshot();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "industrial-pump-sparse",
        attempt: 1,
        campaignBudget: budget,
        execute: secondExecutor.execute,
      }),
    ).rejects.toEqual(
      expect.objectContaining<ModelEvaluationCallError>({
        failureCode: "evaluation_executor_campaign_mismatch",
      }),
    );
    expect(firstWire).toHaveBeenCalledTimes(1);
    expect(secondWire).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual(snapshot);
  });

  it("rejects an incomplete target credential scope before budget or client", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const wire = vi.fn();
    const resolver = fakeResolver();
    const input = structuredClone(
      createFakeModelEvaluationCostSafety(resolver.resolverId),
    ) as ModelEvaluationCostSafetyInput;
    input.credential.allowedDispatches =
      input.credential.allowedDispatches.filter(
        (entry) => entry.alias !== "gpt-5.5",
      );
    input.pricing.entries = input.pricing.entries.filter(
      (entry) => entry.alias !== "gpt-5.5",
    );
    const costSafety = createModelEvaluationCostSafetyAttestation(input);
    const wireClient = fakeWireClient(wire);
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(wireClient, costSafety),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    const budget = new ModelEvaluationBudgetGuard(100);
    const snapshot = budget.snapshot();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: budget,
        execute: executor.execute,
      }),
    ).rejects.toMatchObject({
      failureCode: "evaluation_cost_safety_mismatch",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    expect(wire).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual(snapshot);
  });

  it("rejects an unrelated legacy alias in an otherwise complete scope", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const wire = vi.fn();
    const resolver = fakeResolver();
    const input = structuredClone(
      createFakeModelEvaluationCostSafety(resolver.resolverId),
    ) as ModelEvaluationCostSafetyInput;
    input.credential.allowedDispatches = [
      ...input.credential.allowedDispatches,
      {
        mode: "legacy_comparator",
        alias: "unrelated-legacy-model",
        protocol: "openai-chat-completions",
      },
    ];
    input.pricing.entries = [
      ...input.pricing.entries,
      {
        alias: "unrelated-legacy-model",
        protocol: "openai-chat-completions",
        inputCentsPerMillionTokens: 1,
        outputCentsPerMillionTokens: 1,
      },
    ];
    const costSafety = createModelEvaluationCostSafetyAttestation(input);
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    const budget = new ModelEvaluationBudgetGuard(100);

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate: plan.candidates[0],
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: budget,
        execute: executor.execute,
      }),
    ).rejects.toMatchObject({
      failureCode: "evaluation_cost_safety_mismatch",
    });
    expect(wire).not.toHaveBeenCalled();
  });

  it("binds design_spec to the exact 73-execution target-only scope", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    const candidate = plan.candidates[0];
    const evaluationCase = buildCanonicalModelEvaluationCase(
      plan,
      "precision-industrial-rich",
    );
    const selected = (
      evaluationCase.payload.taskInput as {
        candidates: Array<{ id: string }>;
      }
    ).candidates[0]!;
    const wire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: candidate.alias,
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  candidateId: selected.id,
                  reasons: [],
                  warnings: [],
                }),
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
      providerReportedCostCents: 1,
    }));
    const resolver = fakeResolver();
    const costSafety = createModelEvaluationCostSafetyAttestation(
      designSpecTargetOnlyCostSafetyInput(resolver.resolverId),
    );
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "precision-industrial-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      actualProtocol: "openai-responses",
      costSettlement: { state: "settled", amountCents: 1 },
    });
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it("rejects a replaced loaded contracts module identity before dispatch", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    const candidate = plan.candidates[0];
    const wire = vi.fn();
    const resolver = fakeResolver();
    const costSafety = createModelEvaluationCostSafetyAttestation(
      designSpecTargetOnlyCostSafetyInput(resolver.resolverId),
    );
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    const restore = replaceLoadedContractsModuleIdentity();
    try {
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId: "precision-industrial-rich",
          attempt: 1,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: executor.execute,
        }),
      ).rejects.toMatchObject({
        failureCode: "compiled_contracts_runtime_attestation_mismatch",
        costSettlement: {
          state: "not_incurred",
          reason: "rejected_before_dispatch",
        },
      });
      expect(wire).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("runs the post-wire guard on rejection and durably freezes drift", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    const candidate = plan.candidates[0];
    let restore = () => {};
    const wire = vi.fn(async () => {
      restore = replaceLoadedContractsModuleIdentity();
      throw new Error("provider failed while contracts drifted");
    });
    const resolver = fakeResolver();
    const costSafety = createModelEvaluationCostSafetyAttestation(
      designSpecTargetOnlyCostSafetyInput(resolver.resolverId),
    );
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    try {
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId: "precision-industrial-rich",
          attempt: 1,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: executor.execute,
        }),
      ).resolves.toMatchObject({
        failureCode: "compiled_contracts_runtime_attestation_mismatch",
        resultClass: "capability_unavailable",
        costSettlement: {
          state: "unknown",
          reason: "provider_ack_unknown",
        },
      });
    } finally {
      restore();
    }

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "precision-industrial-sparse",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(100),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      failureCode: "post_dispatch_settlement_incoherent",
      resultClass: "capability_unavailable",
      costSettlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
    });
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it("preserves reported settlement when a malformed response also drifts", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    const candidate = plan.candidates[0];
    let restore = () => {};
    const wire = vi.fn(async () => {
      restore = replaceLoadedContractsModuleIdentity();
      return {
        body: null,
        providerReportedCostCents: 2,
      };
    });
    const resolver = fakeResolver();
    const costSafety = createModelEvaluationCostSafetyAttestation(
      designSpecTargetOnlyCostSafetyInput(resolver.resolverId),
    );
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    try {
      await expect(
        runTaskEvaluationAttempt({
          plan,
          candidate,
          fixtureId: "precision-industrial-rich",
          attempt: 1,
          campaignBudget: new ModelEvaluationBudgetGuard(100),
          execute: executor.execute,
        }),
      ).resolves.toMatchObject({
        failureCode: "compiled_contracts_runtime_attestation_mismatch",
        resultClass: "capability_unavailable",
        costSettlement: {
          state: "settled",
          amountCents: 2,
          basis: "provider_reported@authorization-spec-settlement/v1",
        },
      });
    } finally {
      restore();
    }
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it("rejects retired design_spec scope before budget reservation or dispatch", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    const candidate = plan.candidates[0];
    const wire = vi.fn();
    const resolver = fakeResolver();
    const input = designSpecTargetOnlyCostSafetyInput(resolver.resolverId);
    input.credential.allowedDispatches = [
      ...input.credential.allowedDispatches,
      {
        mode: "legacy_comparator",
        alias: "minimax-m3",
        protocol: "openai-chat-completions",
      },
    ];
    input.pricing.entries = [
      ...input.pricing.entries,
      {
        alias: "minimax-m3",
        protocol: "openai-chat-completions",
        inputCentsPerMillionTokens: 1,
        outputCentsPerMillionTokens: 2,
      },
    ];
    const costSafety = createModelEvaluationCostSafetyAttestation(input);
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });
    const budget = new ModelEvaluationBudgetGuard(100);
    const before = budget.snapshot();

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "precision-industrial-rich",
        attempt: 1,
        campaignBudget: budget,
        execute: executor.execute,
      }),
    ).rejects.toMatchObject({
      failureCode: "evaluation_cost_safety_mismatch",
      costSettlement: {
        state: "not_incurred",
        reason: "rejected_before_dispatch",
      },
    });
    expect(wire).not.toHaveBeenCalled();
    expect(budget.snapshot()).toEqual(before);
  });

  it("keeps campaign spend shared when one executor is presented to fresh budget guards", async () => {
    const plan = buildTaskEvaluationPlan("site_builder.brand_profile");
    const candidate = plan.candidates[0];
    const wire = vi.fn(async () => ({
      body: {
        status: "completed",
        model: candidate.alias,
        output: [{ content: [{ type: "output_text", text: "{}" }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      providerReportedCostCents: 20,
    }));
    const resolver = fakeResolver();
    const costSafety = createFakeModelEvaluationCostSafety(
      resolver.resolverId,
      80,
    );
    const executor = createRawModelEvaluationProtocolExecutor({
      wireClient: bindFakeModelEvaluationWireCredential(
        fakeWireClient(wire),
        costSafety,
      ),
      authorizationLedger:
        createFakeModelEvaluationAuthorizationLedger(costSafety),
      settlementResolver: resolver,
      costSafety,
    });

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "auto-parts-rich",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(80),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({ resultClass: "content_invalid" });
    expect(wire).toHaveBeenCalledTimes(2);

    await expect(
      runTaskEvaluationAttempt({
        plan,
        candidate,
        fixtureId: "industrial-pump-sparse",
        attempt: 1,
        campaignBudget: new ModelEvaluationBudgetGuard(80),
        execute: executor.execute,
      }),
    ).resolves.toMatchObject({
      failureCode: "post_dispatch_settlement_incoherent",
      costSettlement: {
        state: "unknown",
        reason: "invalid_settlement",
      },
    });
    expect(wire).toHaveBeenCalledTimes(2);
  });
});
