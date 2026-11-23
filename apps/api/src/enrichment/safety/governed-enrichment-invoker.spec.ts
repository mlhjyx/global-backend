import { SmtpProbeProvider } from "../verification/smtp-probe.provider";
import {
  createSmtpRcptProbeTool,
  type SmtpProbeInput,
  type SmtpProbeOutput,
} from "../../tools/builtin-tools";
import { paidOperationKey } from "../../site-builder/site-build-cost-ledger";
import { smtpPhysicalInputFingerprint } from "./enrichment-target-snapshot";
import { describe, expect, it, vi } from "vitest";
import { ExecutionControlError } from "../../execution-budget/execution-control-error";
import type { DurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import type {
  ExecutionBroker,
  ToolContext,
  ToolResult,
} from "../../tools/tool-contract";
import type {
  BoundEnrichmentStep,
  OriginalEnrichmentStepReadback,
  SettledEnrichmentStepReference,
} from "./enrichment-safety.contract";
import {
  GovernedEnrichmentInvoker,
  type EnrichmentStepExecutionState,
  type GovernedEnrichmentInvokerDeps,
} from "./governed-enrichment-invoker";
const W = "00000000-0000-4000-8000-000000000001",
  C = "00000000-0000-4000-8000-000000000002",
  A = "00000000-0000-4000-8000-000000000003",
  ACCOUNT = "00000000-0000-4000-8000-000000000004",
  EXEC = "00000000-0000-4000-8000-000000000005",
  STEP = "00000000-0000-4000-8000-000000000006",
  CONTACT = "00000000-0000-4000-8000-000000000007",
  OP = "00000000-0000-4000-8000-000000000008",
  ART = "00000000-0000-4000-8000-000000000009";
function fixture(
  options: {
    phase?: "FINDER" | "SMTP";
    read?: "PENDING" | "UNAVAILABLE" | "SETTLED";
    dispatch?: EnrichmentStepExecutionState["dispatchPhase"];
    wireCrash?: boolean;
    preWireFailure?: boolean;
    claimFailure?: boolean;
    missingReceipt?: boolean;
    skipCallback?: boolean;
    swallowCallback?: boolean;
    doubleCallback?: boolean;
    linkFailsOnce?: boolean;
    receipt?: Partial<DurableExecutionReceipt>;
    denyAtWire?: boolean;
  } = {},
) {
  const events: string[] = [];
  let wires = 0;
  let authorizations = 0;
  let linksRemaining = options.linkFailsOnce ? 1 : 0;
  const step: BoundEnrichmentStep = {
    slotKey: "f1",
    contactId: CONTACT,
    contactOrdinal: 0,
    phase: options.phase ?? "FINDER",
    provider: options.phase === "SMTP" ? "smtp_self" : "hunter",
    toolId:
      options.phase === "SMTP"
        ? "smtp.rcpt_probe"
        : "contact_email.find.hunter",
    toolVersion: "1.0.0",
    quoteMicrousd: options.phase === "SMTP" ? "0" : "1780",
    pricingVersion: "p1",
    dependsOnSlotKey: null,
    stepId: STEP,
    executionId: EXEC,
    workspaceId: W,
    companyId: C,
    authorityId: A,
    accountId: ACCOUNT,
    generation: 1,
    accountKey: "actual-original-account-key",
    inputFingerprint: "e".repeat(64),
    operationKey: "original-operation-key",
    candidateRef: null,
    revision: 2,
    budgetOperationId: null,
  };
  const receipt: DurableExecutionReceipt = {
    schemaVersion: "durable-execution-receipt/v1",
    scopeKey: W,
    authorityId: A,
    accountId: ACCOUNT,
    operationId: OP,
    operationKey: step.operationKey,
    resultStrategy: "artifact_reference",
    resultSchema: "contact-email-find-hunter/v1",
    resultDigest: "d".repeat(64),
    artifactId: ART,
    usage: {
      currency: "USD",
      unit: "microusd",
      callCount: 1,
      upperBoundMicrousd: "1780",
    },
    costBasis: "estimated_upper_bound",
    status: "SETTLED",
    ...options.receipt,
  };
  const reference: SettledEnrichmentStepReference = {
    stepId: STEP,
    producerId: step.toolId,
    resultSchema: receipt.resultSchema,
    resultDigest: receipt.resultDigest,
    durableReceipt: receipt,
  };
  let state: EnrichmentStepExecutionState = {
    step,
    dispatchPhase: options.dispatch ?? "ADMITTED",
    domainState: "PENDING",
  };
  let original: OriginalEnrichmentStepReadback =
    options.read === "SETTLED"
      ? { status: "SETTLED", reference }
      : options.read
        ? { status: options.read }
        : { status: "NOT_FOUND" };
  const context = {
    workspaceId: W,
    companyId: C,
    authorizeExternalAction: vi.fn(async () => {
      authorizations += 1;
      events.push("AUTHORIZE_CURRENT");
      return !options.denyAtWire || authorizations < 2;
    }),
  };
  const claim = vi.fn(async (s: BoundEnrichmentStep) => {
    events.push("CLAIM_TX");
    if (options.claimFailure)
      throw new ExecutionControlError("EXECUTION_BUDGET_AUTHORITY_REVOKED");
    const claimed = { ...s, budgetOperationId: OP, revision: s.revision + 1 };
    state = {
      step: claimed,
      dispatchPhase: "RESERVED",
      domainState: "PENDING",
    };
    events.push("CLAIM_COMMITTED_FAKE");
    return claimed;
  });
  const invoke = vi.fn(
    async <I, O>(
      toolId: string,
      input: I,
      ctx: ToolContext,
    ): Promise<ToolResult<O>> => {
      events.push("BROKER_INVOKE");
      expect(toolId).toBe(step.toolId);
      expect(input).toEqual({ stepId: STEP });
      if (options.preWireFailure)
        throw new ExecutionControlError("BUDGET_STORE_UNAVAILABLE");
      if (!options.skipCallback) {
        try {
          await ctx.beforePhysicalWire!();
        } catch (error) {
          if (!options.swallowCallback) throw error;
        }
        if (state.dispatchPhase === "RESERVED") {
          wires += 1;
          events.push("SYNTHETIC_HTTP_WIRE");
        }
        if (options.doubleCallback) {
          try {
            await ctx.beforePhysicalWire!();
            wires += 1;
          } catch (error) {
            if (!options.swallowCallback) throw error;
          }
        }
      }
      if (options.wireCrash) {
        original = { status: "PENDING" };
        throw new Error("synthetic_response_ack_lost");
      }
      original = { status: "SETTLED", reference };
      return {
        data: { email: "PII_DO_NOT_RETURN" } as O,
        costCents: 0.178,
        costMicrousd: "1780",
        ...(options.missingReceipt ? {} : { durableReceipt: receipt }),
      };
    },
  );
  const broker: ExecutionBroker = {
    invoke,
    checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
  };
  const deps: GovernedEnrichmentInvokerDeps = {
    broker,
    loadCurrentStep: vi.fn(async () => {
      events.push("LOAD_CURRENT");
      return state;
    }),
    readOriginalResult: vi.fn(async (s) => {
      expect(s.generation).toBe(1);
      expect(s.accountKey).toBe(step.accountKey);
      events.push("READ_ORIGINAL");
      return original;
    }),
    claimBeforePhysicalWire: claim,
    linkSettledReference: vi.fn(async () => {
      events.push("LINK_ORIGINAL");
      if (linksRemaining > 0) {
        linksRemaining -= 1;
        throw new Error("synthetic_index_link_ack_lost");
      }
    }),
    hold: vi.fn(async () => {
      events.push("HOLD_METADATA_ONLY");
      state = { ...state, dispatchPhase: "RESULT_UNKNOWN" };
    }),
  };
  return {
    step,
    receipt,
    reference,
    context,
    deps,
    events,
    invoke,
    claim,
    invoker: new GovernedEnrichmentInvoker(deps),
    wires: () => wires,
  };
}
describe("governed invoker original-result/no-rebuy control flow, fake ports not real wire or storage", () => {
  it("uses trusted accountKey, contact subject and step-only input, then links only the closed original receipt", async () => {
    const x = fixture();
    const ref = await x.invoker.invoke(x.step, x.context);
    expect(ref).toEqual(x.reference);
    expect(Object.keys(ref).sort()).toEqual([
      "durableReceipt",
      "producerId",
      "resultDigest",
      "resultSchema",
      "stepId",
    ]);
    expect(JSON.stringify(ref)).not.toContain("PII_DO_NOT_RETURN");
    expect(x.invoke).toHaveBeenCalledTimes(1);
    const ctx = x.invoke.mock.calls[0]![2];
    expect(ctx.runId).toBe(x.step.accountKey);
    expect(ctx.workspaceId).toBe(W);
    expect(ctx.purpose).toBe("enrichment");
    expect(ctx.artifactSubject).toEqual({
      subjectType: "contact",
      subjectId: CONTACT,
    });
    expect(x.events.indexOf("CLAIM_COMMITTED_FAKE")).toBeLessThan(
      x.events.indexOf("SYNTHETIC_HTTP_WIRE"),
    );
    expect(x.events.indexOf("SYNTHETIC_HTTP_WIRE")).toBeLessThan(
      x.events.indexOf("LINK_ORIGINAL"),
    );
    expect(x.wires()).toBe(1);
  });
  it("reads an already settled original result without broker, reserve or new claim", async () => {
    const x = fixture({ read: "SETTLED", dispatch: "SETTLED_WAITING_APPLY" });
    expect(await x.invoker.invoke(x.step, x.context)).toEqual(x.reference);
    expect(x.invoke).not.toHaveBeenCalled();
    expect(x.claim).not.toHaveBeenCalled();
    expect(x.wires()).toBe(0);
  });
  it.each(["PENDING", "UNAVAILABLE"] as const)(
    "holds original %s without invoking a provider",
    async (read) => {
      const x = fixture({ read });
      await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
        "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
      );
      expect(x.invoke).not.toHaveBeenCalled();
      expect(x.wires()).toBe(0);
    },
  );
  it.each(["RESERVED", "RESULT_UNKNOWN", "RELEASED"] as const)(
    "does not rebuy an existing %s step even if result lookup says NOT_FOUND",
    async (dispatch) => {
      const x = fixture({ dispatch });
      await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
        "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
      );
      expect(x.invoke).not.toHaveBeenCalled();
    },
  );
  it("holds response loss across a new caller instance against the same persisted-port fixture", async () => {
    const x = fixture({ wireCrash: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
    );
    await expect(
      new GovernedEnrichmentInvoker(x.deps).invoke(x.step, x.context),
    ).rejects.toThrow("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
    expect(x.invoke).toHaveBeenCalledTimes(1);
    expect(x.wires()).toBe(1);
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
  });
  it("retries index linkage from the original settled receipt, never another execution", async () => {
    const x = fixture({ linkFailsOnce: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
    );
    expect(
      await new GovernedEnrichmentInvoker(x.deps).invoke(x.step, x.context),
    ).toEqual(x.reference);
    expect(x.invoke).toHaveBeenCalledTimes(1);
    expect(x.wires()).toBe(1);
    expect(x.deps.linkSettledReference).toHaveBeenCalledTimes(2);
  });
  it("preserves original pre-wire budget-control failure without execution fallback", async () => {
    const x = fixture({ preWireFailure: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "BUDGET_STORE_UNAVAILABLE",
    );
    expect(x.wires()).toBe(0);
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
  });
  it("does not send after losing the current claim/authority gate", async () => {
    const x = fixture({ claimFailure: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "EXECUTION_BUDGET_AUTHORITY_REVOKED",
    );
    expect(x.wires()).toBe(0);
  });
  it("does not accept an adapter that swallowed the before-wire denial and returned a result", async () => {
    const x = fixture({ denyAtWire: true, swallowCallback: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow();
    expect(x.wires()).toBe(0);
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
  });
  it("does not accept a broker result that skipped beforePhysicalWire", async () => {
    const x = fixture({ skipCallback: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
    );
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
  });
  it("rejects a second HTTP callback even if swallowed, without permitting another synthetic wire", async () => {
    const x = fixture({ doubleCallback: true, swallowCallback: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
    );
    expect(x.claim).toHaveBeenCalledTimes(1);
    expect(x.wires()).toBe(1);
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
  });
  it("does not link a paid response without its original durable receipt", async () => {
    const x = fixture({ missingReceipt: true });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH",
    );
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
  });
  it.each([
    { authorityId: C },
    { accountId: C },
    { operationKey: "different-original-key" },
    { resultSchema: "http-get/v1" },
    { operationId: ART },
  ])("rejects wrong original receipt identity %#", async (receipt) => {
    const x = fixture({ receipt });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH",
    );
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
  });
  it("does not cross the trusted workspace/company or accept a paidCost context", async () => {
    const x = fixture();
    await expect(
      x.invoker.invoke(x.step, { ...x.context, workspaceId: C }),
    ).rejects.toThrow();
    await expect(
      x.invoker.invoke(x.step, { ...x.context, paidCost: {} } as never),
    ).rejects.toThrow();
    expect(x.invoke).not.toHaveBeenCalled();
  });
  it("keeps SMTP held until the original protocol bridge is actually composed, never step-only rewrites it", async () => {
    const x = fixture({ phase: "SMTP" });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow(
      "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
    );
    expect(x.invoke).not.toHaveBeenCalled();
    expect(x.wires()).toBe(0);
  });
});

describe("step-bound proxy of the original SMTP broker input/key", () => {
  const input: SmtpProbeInput = {
    domain: "company.example.invalid",
    mxHost: "mx.company.example.invalid",
    rcptTo: [
      "person@company.example.invalid",
      "x-verify-0123456789abcdef0123@company.example.invalid",
    ],
  };
  const data: SmtpProbeOutput = {
    reachable: true,
    mailFromCode: 250,
    codes: [250, 550],
  };
  function smtpWorld(
    options: {
      crash?: boolean;
      linkFailsOnce?: boolean;
      pending?: boolean;
      settled?: boolean;
      missingReplay?: boolean;
      originalInput?: SmtpProbeInput;
    } = {},
  ) {
    const expectedInput = options.originalInput ?? input;
    const x = fixture({
      phase: "SMTP",
      linkFailsOnce: options.linkFailsOnce,
      receipt: {
        resultStrategy: "typed_projection",
        resultSchema: "smtp-probe-verdict/v1",
        artifactId: null,
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount: 1,
          chargedMicrousd: "0",
          upperBoundMicrousd: "0",
        },
      },
    });
    const operationKey = paidOperationKey([
      x.step.accountKey,
      "tool-budget",
      "smtp.rcpt_probe",
      "1.0.0",
      createSmtpRcptProbeTool().idempotencyKey(expectedInput),
    ]);
    Object.assign(x.step, {
      operationKey,
      inputFingerprint: smtpPhysicalInputFingerprint({
        workspaceId: W,
        contactId: CONTACT,
        originalInput: expectedInput,
      }),
      candidateRef: {
        operationId: ART,
        resultDigest: "b".repeat(64),
        artifactRef: {
          schemaVersion: "generic-operation-artifact-ref/v1",
          operationId: ART,
          artifactId: "00000000-0000-4000-8000-000000000010",
          resultSchema: "contact-email-find-hunter/v1",
          sha256: "b".repeat(64),
          sizeBytes: "128",
          mediaType: "application/octet-stream",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    });
    Object.assign(x.receipt, { operationKey });
    Object.assign(x.reference, { resultSchema: "smtp-probe-verdict/v1" });
    let status: "NOT_FOUND" | "PENDING" | "SETTLED" = options.pending
      ? "PENDING"
      : options.settled
        ? "SETTLED"
        : "NOT_FOUND";
    x.deps.readOriginalResult = vi.fn(async () =>
      status === "SETTLED" ? { status, reference: x.reference } : { status },
    );
    const raw: ToolResult<SmtpProbeOutput> = {
      data,
      costCents: 0,
      durableReceipt: x.receipt,
    };
    x.deps.readSmtpResult = vi.fn(async () =>
      options.missingReplay ? null : raw,
    );
    const send = vi.fn(
      async <I, O>(
        tool: string,
        originalInput: I,
        context: ToolContext,
      ): Promise<ToolResult<O>> => {
        expect(tool).toBe("smtp.rcpt_probe");
        expect(originalInput).toEqual(expectedInput);
        expect(context.runId).toBe(x.step.accountKey);
        expect(context.purpose).toBe("enrichment");
        expect(context.paidCost).toBeUndefined();
        await context.beforePhysicalWire!();
        status = options.crash ? "PENDING" : "SETTLED";
        if (options.crash) throw new Error("synthetic_original_smtp_ack_lost");
        return raw as ToolResult<O>;
      },
    );
    x.deps.broker = {
      invoke: send,
      checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
    };
    const originalContext: ToolContext = {
      workspaceId: W,
      runId: x.step.accountKey,
      correlationId: "smtp-probe:" + input.domain,
      authorizeExternalAction: x.context.authorizeExternalAction,
    };
    const broker = new GovernedEnrichmentInvoker(
      x.deps,
    ).createStepBoundSmtpBroker(x.step, x.context);
    return { ...x, send, raw, broker, originalContext };
  }
  it("passes the exact original input/account/key through the existing broker and returns its original verdict", async () => {
    const x = smtpWorld();
    expect(
      await x.broker.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).toEqual(x.raw);
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(x.claim).toHaveBeenCalledTimes(1);
    expect(x.deps.linkSettledReference).toHaveBeenCalledWith(
      expect.objectContaining({ budgetOperationId: OP }),
      x.reference,
    );
  });
  it("does not invoke after an existing pending original operation", async () => {
    const x = smtpWorld({ pending: true });
    await expect(
      x.broker.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).rejects.toThrow();
    expect(x.send).not.toHaveBeenCalled();
  });
  it("cold replays the original stored SMTP projection without broker reserve or wire", async () => {
    const x = smtpWorld({ settled: true });
    expect(
      await x.broker.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).toEqual(x.raw);
    expect(x.send).not.toHaveBeenCalled();
    expect(x.claim).not.toHaveBeenCalled();
    expect(x.deps.readSmtpResult).toHaveBeenCalledTimes(1);
  });
  it("holds a missing original projection instead of invoking again", async () => {
    const x = smtpWorld({ settled: true, missingReplay: true });
    await expect(
      x.broker.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).rejects.toThrow();
    expect(x.send).not.toHaveBeenCalled();
  });
  it("after a lost index ACK a new proxy reads the original result and never reinvokes", async () => {
    const x = smtpWorld({ linkFailsOnce: true });
    await expect(
      x.broker.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).rejects.toThrow();
    const restarted = new GovernedEnrichmentInvoker(
      x.deps,
    ).createStepBoundSmtpBroker(x.step, x.context);
    expect(
      await restarted.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).toEqual(x.raw);
    expect(x.send).toHaveBeenCalledTimes(1);
  });
  it("after an unknown SMTP response a new proxy never repeats the protocol", async () => {
    const x = smtpWorld({ crash: true });
    await expect(
      x.broker.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).rejects.toThrow();
    await expect(
      new GovernedEnrichmentInvoker(x.deps)
        .createStepBoundSmtpBroker(x.step, x.context)
        .invoke("smtp.rcpt_probe", input, x.originalContext),
    ).rejects.toThrow();
    expect(x.send).toHaveBeenCalledTimes(1);
  });
  it.each(["http.get", "contact_email.verify.emailable"])(
    "rejects a substituted producer %s",
    async (tool) => {
      const x = smtpWorld();
      await expect(
        x.broker.invoke(tool, input, x.originalContext),
      ).rejects.toThrow();
      expect(x.send).not.toHaveBeenCalled();
    },
  );
  it("rejects changed real input or original account context before broker invocation", async () => {
    const x = smtpWorld();
    await expect(
      x.broker.invoke(
        "smtp.rcpt_probe",
        {
          ...input,
          rcptTo: ["other@company.example.invalid", input.rcptTo[1]!],
        },
        x.originalContext,
      ),
    ).rejects.toThrow();
    expect(x.send).not.toHaveBeenCalled();
    await expect(
      x.broker.invoke("smtp.rcpt_probe", input, {
        ...x.originalContext,
        runId: "new-account",
      }),
    ).rejects.toThrow();
    expect(x.send).not.toHaveBeenCalled();
  });
  it("rejects the same physical input with a changed original tool key", async () => {
    const x = smtpWorld();
    Object.assign(x.step, { operationKey: "changed-key" });
    await expect(
      x.broker.invoke("smtp.rcpt_probe", input, x.originalContext),
    ).rejects.toThrow();
    expect(x.send).not.toHaveBeenCalled();
  });
  it("uses the actual original SMTP provider to derive the account-key nonce and protocol input exactly once", async () => {
    const authorize = vi.fn(async () => true);
    let originalInput: SmtpProbeInput | null = null;
    let current: ReturnType<typeof smtpWorld> | null = null;
    const invoke = vi.fn(
      async <I, O>(
        tool: string,
        nativeInput: I,
        caller: ToolContext,
      ): Promise<ToolResult<O>> => {
        originalInput = nativeInput as SmtpProbeInput;
        current = smtpWorld({ originalInput });
        const inner = new GovernedEnrichmentInvoker(
          current.deps,
        ).createStepBoundSmtpBroker(current.step, {
          ...current.context,
          authorizeExternalAction: authorize,
        });
        return inner.invoke<I, O>(tool, nativeInput, caller);
      },
    );
    const resolveMxHost = vi.fn(async () => [
      { exchange: "mx.company.example.invalid", priority: 10 },
    ]);
    const original = new SmtpProbeProvider(
      { invoke, checkSourcePolicy: vi.fn(async () => ({ allowed: true })) },
      { config: { enabled: true }, resolveMxHost },
    );
    const verdict = await original.verify({
      email: input.rcptTo[0]!,
      workspaceId: W,
      runId: "actual-original-account-key",
      authorizeExternalAction: authorize,
    });
    expect(verdict.state).toBe("VALID");
    expect(verdict.method).toBe("smtp_rcpt");
    expect(verdict.costMicrousd).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(resolveMxHost).toHaveBeenCalledTimes(1);
    const captured = originalInput as unknown as SmtpProbeInput;
    expect(captured.domain).toBe(input.domain);
    expect(captured.mxHost).toBe(input.mxHost);
    expect(captured.rcptTo[0]).toBe(input.rcptTo[0]);
    expect(captured.rcptTo[1]).toMatch(
      /^x-verify-[a-f0-9]{20}@company\.example\.invalid$/,
    );
    expect(
      (current as unknown as ReturnType<typeof smtpWorld>).send,
    ).toHaveBeenCalledTimes(1);
    expect(
      (current as unknown as ReturnType<typeof smtpWorld>).claim,
    ).toHaveBeenCalledTimes(1);
  });
});

describe("F19 terminal replay through the invoker", () => {
  it("replays an already settled original through the read-only link path without claim or wire", async () => {
    const x = fixture({ read: "SETTLED", dispatch: "SETTLED" });
    expect(await x.invoker.invoke(x.step, x.context)).toEqual(x.reference);
    expect(x.deps.linkSettledReference).toHaveBeenCalledTimes(1);
    expect(x.claim).not.toHaveBeenCalled();
    expect(x.invoke).not.toHaveBeenCalled();
    expect(x.wires()).toBe(0);
  });
  it.each(["SETTLED_WAITING_APPLY", "SETTLED"] as const)("holds a terminal %s step whose original readback is NOT_FOUND", async (dispatch) => {
    const x = fixture({ read: "NOT_FOUND", dispatch });
    await expect(x.invoker.invoke(x.step, x.context)).rejects.toThrow("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
    expect(x.deps.linkSettledReference).not.toHaveBeenCalled();
    expect(x.invoke).not.toHaveBeenCalled();
    expect(x.wires()).toBe(0);
  });
});

