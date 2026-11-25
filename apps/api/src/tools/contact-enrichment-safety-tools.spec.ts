import { createSmtpRcptProbeTool } from "./builtin-tools";
import type { PinnedHttpExecutor } from "../adapters/guarded-http";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "./tool-registry";
import type { ToolContext } from "./tool-contract";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { enrichmentInputVersion } from "../enrichment/finders/email-enrichment-provider";
import {
  finderPhysicalInputFingerprint,
  verificationPhysicalInputFingerprint,
} from "../enrichment/safety/enrichment-target-snapshot";
import type { BoundEnrichmentStep } from "../enrichment/safety/enrichment-safety.contract";
import {
  CONTROLLED_ENRICHMENT_PROVIDERS as PROVIDERS,
  createContactEnrichmentSafetyTools,
  createStepAwareSmtpRcptProbeTool,
  registerContactEnrichmentSafetyTools,
  type ControlledEnrichmentProvider,
  type ControlledEnrichmentProviderState,
  type ControlledEnrichmentWireInput,
} from "./contact-enrichment-safety-tools";
const W = "00000000-0000-4000-8000-000000000001",
  C = "00000000-0000-4000-8000-000000000002",
  A = "00000000-0000-4000-8000-000000000003",
  ACCOUNT = "00000000-0000-4000-8000-000000000004",
  EXEC = "00000000-0000-4000-8000-000000000005",
  STEP = "00000000-0000-4000-8000-000000000006",
  CONTACT = "00000000-0000-4000-8000-000000000007",
  OP = "00000000-0000-4000-8000-000000000008",
  ART = "00000000-0000-4000-8000-000000000009";
const hosts = {
  hunter: "api.hunter.io",
  prospeo: "api.prospeo.io",
  millionverifier: "api.millionverifier.com",
  emailable: "api.emailable.com",
  zerobounce: "api.zerobounce.net",
};
const replies: Record<ControlledEnrichmentProvider, unknown> = {
  hunter: {
    data: {
      first_name: "Synthetic",
      last_name: "Person",
      email: "person@company.example.invalid",
      score: 95,
      accept_all: false,
      verification: { status: "valid" },
    },
  },
  prospeo: {
    error: false,
    person: {
      email: {
        email: "person@company.example.invalid",
        status: "VERIFIED",
        revealed: true,
      },
    },
  },
  millionverifier: {
    result: "ok",
    accept_all: false,
    disposable: false,
    role: false,
  },
  emailable: {
    state: "deliverable",
    accept_all: false,
    disposable: false,
    role: false,
  },
  zerobounce: { status: "valid" },
};
function world(
  provider: ControlledEnrichmentProvider = "millionverifier",
  options: {
    status?: number;
    body?: unknown;
    rawBody?: string;
    transportFailure?: boolean;
    priceDrift?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const events: string[] = [];
  const configs = Object.fromEntries(
    PROVIDERS.map((p) => [
      p,
      {
        provider: p,
        apiKey: "fake",
        baseUrl: "https://" + hosts[p],
        timeoutMs: 8000,
        costMicrousd: p === "millionverifier" ? 1780 : 1700,
        pricingVersion: "p1",
        enabled: true,
        policyAllowed: true,
        retentionSeconds: 3600,
      },
    ]),
  ) as Record<ControlledEnrichmentProvider, ControlledEnrichmentProviderState>;
  if (options.timeoutMs !== undefined)
    Object.assign(configs[provider], { timeoutMs: options.timeoutMs });
  const isFinder = provider === "hunter" || provider === "prospeo";
  const step: BoundEnrichmentStep = {
    slotKey: "s1",
    contactId: CONTACT,
    contactOrdinal: 0,
    phase: isFinder ? "FINDER" : "VERIFY",
    provider,
    toolId: isFinder
      ? "contact_email.find." + provider
      : "contact_email.verify." + provider,
    toolVersion: "1.0.0",
    quoteMicrousd: String(configs[provider].costMicrousd),
    pricingVersion: "p1",
    dependsOnSlotKey: isFinder ? null : "finder-original",
    stepId: STEP,
    executionId: EXEC,
    workspaceId: W,
    companyId: C,
    authorityId: A,
    accountId: ACCOUNT,
    generation: 1,
    accountKey: "actual-original-account-key",
    inputFingerprint: "e".repeat(64),
    operationKey: "original-budget-operation-key",
    candidateRef: isFinder
      ? null
      : {
          operationId: OP,
          resultDigest: "b".repeat(64),
          artifactRef: {
            schemaVersion: "generic-operation-artifact-ref/v1",
            artifactId: ART,
            operationId: OP,
            resultSchema: "contact-email-find-hunter/v1",
            sha256: "b".repeat(64),
            sizeBytes: "128",
            mediaType: "application/octet-stream",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
    revision: 2,
    budgetOperationId: null,
  };
  const wire: ControlledEnrichmentWireInput = {
    step,
    finder: isFinder
      ? { fullName: "Synthetic Person", domain: "company.example.invalid" }
      : null,
    verification: isFinder
      ? null
      : {
          email: "person@company.example.invalid",
          domain: "company.example.invalid",
          providerTimeoutSeconds: provider === "millionverifier" ? 8 : null,
        },
  };
  Object.assign(step, {
    inputFingerprint: isFinder
      ? finderPhysicalInputFingerprint({
          workspaceId: W,
          contactId: CONTACT,
          inputVersion: enrichmentInputVersion(wire.finder!),
        })
      : verificationPhysicalInputFingerprint({
          workspaceId: W,
          contactId: CONTACT,
          provider: provider as Exclude<
            ControlledEnrichmentProvider,
            "hunter" | "prospeo"
          >,
          email: wire.verification!.email,
          providerTimeoutSeconds: wire.verification!.providerTimeoutSeconds,
        }),
  });
  const resolver = vi.fn(async (raw: string) => {
    events.push("FAKE_RESOLVE");
    if (options.priceDrift)
      Object.assign(configs[provider], { pricingVersion: "p2" });
    return {
      url: new URL(raw),
      ip: "93.184.216.34",
      family: 4 as const,
      addresses: [{ address: "93.184.216.34", family: 4 as const }],
    };
  });
  const executePinned = vi.fn<PinnedHttpExecutor>(async () => {
    events.push("FAKE_PINNED_EXECUTE");
    if (options.transportFailure) throw new Error("synthetic_network_failure");
    const text =
      options.rawBody ?? JSON.stringify(options.body ?? replies[provider]);
    return {
      status: options.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(options.status === 302
          ? { location: "https://different.example.invalid/" }
          : {}),
      },
      body: Buffer.from(text),
      text,
    };
  });
  const currentProvider = vi.fn(async (p: ControlledEnrichmentProvider) => {
    events.push("CURRENT_PROVIDER");
    return { ...configs[p] };
  });
  const loadTrustedInput = vi.fn(async () => {
    events.push("LOAD_TRUSTED");
    return wire;
  });
  const tools = createContactEnrichmentSafetyTools({
    providers: configs,
    currentProvider,
    loadTrustedInput,
    httpDependencies: { resolver, executePinned },
  });
  const tool = tools.find((t) => t.id === step.toolId)!;
  expect(tool).toBeDefined();
  const beforePhysicalWire = vi.fn(async () => {
    events.push("CTX_BEFORE_PHYSICAL_WIRE");
  });
  const context: ToolContext = {
    workspaceId: W,
    runId: step.accountKey,
    purpose: "enrichment",
    artifactSubject: { subjectType: "contact", subjectId: CONTACT },
    authorizeExternalAction: async () => true,
    beforePhysicalWire,
    dispatchPhysicalWire: async (_id, execute) => execute(),
  };
  return {
    tools,
    tool,
    wire,
    configs,
    currentProvider,
    loadTrustedInput,
    resolver,
    executePinned,
    beforePhysicalWire,
    context,
    events,
  };
}
describe("four original-parser controlled HTTP Tools; fake resolver/transport only", () => {
  it("declares exactly the five fixed producers with honest durable strategies and stable step keys", () => {
    const x = world();
    const r = new ToolRegistry();
    for (const tool of x.tools) r.register(tool);
    expect(
      r
        .all()
        .map((t) => t.id)
        .sort(),
    ).toEqual([
      "contact_email.find.hunter",
      "contact_email.find.prospeo",
      "contact_email.verify.emailable",
      "contact_email.verify.millionverifier",
      "contact_email.verify.zerobounce",
    ]);
    expect(x.tool.idempotencyKey({ stepId: STEP })).toBe(STEP);
    expect(() =>
      x.tool.idempotencyKey({ stepId: STEP, email: "PII" } as never),
    ).toThrow();
  });
  for (const provider of PROVIDERS) {
    it(
      "runs " +
        provider +
        " once through the original parser and bounded zero-redirect transport",
      async () => {
        const x = world(provider);
        const result = await x.tool.execute({ stepId: STEP }, x.context);
        expect(result.costMicrousd).toBe(x.wire.step.quoteMicrousd);
        expect(result.costCents).toBe(
          Number(x.wire.step.quoteMicrousd) / 10000,
        );
        expect(x.resolver).toHaveBeenCalledTimes(1);
        expect(x.executePinned).toHaveBeenCalledTimes(1);
        expect(x.beforePhysicalWire).toHaveBeenCalledTimes(1);
        const options = x.executePinned.mock.calls[0]![1];
        expect(options).toMatchObject({
          method: provider === "prospeo" ? "POST" : "GET",
          maxRedirects: 0,
          maxBytes: 1000000,
          timeoutMs: 8000,
        });
        expect(x.events.indexOf("CTX_BEFORE_PHYSICAL_WIRE")).toBeLessThan(
          x.events.indexOf("FAKE_PINNED_EXECUTE"),
        );
        expect(JSON.stringify(result.data)).not.toContain("raw");
        if (provider !== "hunter" && provider !== "prospeo") {
          expect(result.data).toMatchObject({
            providerKey: provider,
            state: "VALID",
            reason: "provider_verdict",
            costBasis: "estimated_upper_bound",
          });
          expect(JSON.stringify(result.data)).not.toContain("person@");
        }
      },
    );
    it.each([302, 429, 500])(
      "does not retry or convert " + provider + " HTTP %s to a free result",
      async (status) => {
        const x = world(provider, { status });
        await expect(
          x.tool.execute({ stepId: STEP }, x.context),
        ).rejects.toThrow("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
        expect(x.executePinned).toHaveBeenCalledTimes(1);
        expect(x.resolver).toHaveBeenCalledTimes(1);
      },
    );
    it(
      "preserves " +
        provider +
        " post-dispatch transport ambiguity despite adapter cost0 catches",
      async () => {
        const x = world(provider, { transportFailure: true });
        await expect(
          x.tool.execute({ stepId: STEP }, x.context),
        ).rejects.toThrow("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
        expect(x.executePinned).toHaveBeenCalledTimes(1);
      },
    );
    it(
      "does not settle a malformed " + provider + " body as a free miss",
      async () => {
        const x = world(provider, { rawBody: "{not-json" });
        await expect(
          x.tool.execute({ stepId: STEP }, x.context),
        ).rejects.toThrow("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
        expect(x.executePinned).toHaveBeenCalledTimes(1);
      },
    );
    it.each([{ apiKey: null }, { enabled: false }, { policyAllowed: false }])(
      "preflights current " +
        provider +
        " credential/source gates %# with zero wire",
      async (changes) => {
        const x = world(provider);
        Object.assign(x.configs[provider], changes);
        await expect(
          x.tool.execute({ stepId: STEP }, x.context),
        ).rejects.toThrow();
        expect(x.executePinned).not.toHaveBeenCalled();
        expect(x.beforePhysicalWire).not.toHaveBeenCalled();
      },
    );
    it(
      "rechecks " + provider + " price before the physical cut after DNS",
      async () => {
        const x = world(provider, { priceDrift: true });
        await expect(
          x.tool.execute({ stepId: STEP }, x.context),
        ).rejects.toThrow();
        expect(x.executePinned).not.toHaveBeenCalled();
        expect(x.beforePhysicalWire).not.toHaveBeenCalled();
      },
    );
    it(
      "preserves original " +
        provider +
        " control rejection even when adapter catches it",
      async () => {
        const x = world(provider);
        x.beforePhysicalWire.mockRejectedValueOnce(
          new ExecutionControlError("EXECUTION_BUDGET_AUTHORITY_REVOKED"),
        );
        await expect(
          x.tool.execute({ stepId: STEP }, x.context),
        ).rejects.toThrow("EXECUTION_BUDGET_AUTHORITY_REVOKED");
        expect(x.executePinned).not.toHaveBeenCalled();
      },
    );
    it(
      "rejects " + provider + " drifted physical input before dispatch",
      async () => {
        const x = world(provider);
        Object.assign(x.wire.step, { inputFingerprint: "a".repeat(64) });
        await expect(
          x.tool.execute({ stepId: STEP }, x.context),
        ).rejects.toThrow();
        expect(x.executePinned).not.toHaveBeenCalled();
      },
    );
    it(
      "requires the original " + provider + " beforePhysicalWire composition",
      async () => {
        const x = world(provider);
        await expect(
          x.tool.execute(
            { stepId: STEP },
            { ...x.context, beforePhysicalWire: undefined },
          ),
        ).rejects.toThrow();
        expect(x.executePinned).not.toHaveBeenCalled();
      },
    );
    it(
      "rejects " + provider + " paidCost before trusted PII load or wire",
      async () => {
        const x = world(provider);
        await expect(
          x.tool.execute({ stepId: STEP }, {
            ...x.context,
            paidCost: {},
          } as never),
        ).rejects.toThrow();
        expect(x.loadTrustedInput).not.toHaveBeenCalled();
        expect(x.executePinned).not.toHaveBeenCalled();
      },
    );
  }
  it("keeps a complete Hunter miss at the frozen estimated upper bound, not a forged provider invoice or cost0", async () => {
    const x = world("hunter", {
      body: { data: { emails: [], accept_all: false, pattern: null } },
    });
    const result = await x.tool.execute({ stepId: STEP }, x.context);
    expect(result.costMicrousd).toBe("1700");
    expect(result.data).toMatchObject({
      status: "miss",
      email: null,
      reason: "no_match",
    });
  });
  it.each([
    [400, { error: true, error_code: "NO_MATCH" }],
    [400, { error: true, error_code: "INVALID_DATAPOINTS" }],
    [404, { error: true, error_code: "NO_MATCH" }],
    [422, { error: true, error_code: "INVALID_DATAPOINTS" }],
  ] as const)(
    "settles deterministic Prospeo HTTP %s miss cleanly without BUDGET_OPERATION_REPLAY_UNAVAILABLE",
    async (status, body) => {
      const x = world("prospeo", { status, body });
      const result = await x.tool.execute({ stepId: STEP }, x.context);
      expect(result.costMicrousd).toBe("1700");
      expect(result.data).toEqual({
        status: "miss",
        email: null,
        providerConfidence: null,
        acceptAll: null,
        pattern: null,
        reason: "no_match",
      });
      expect(x.executePinned).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [400, { errors: [{ id: "wrong_params", code: 400, details: "Missing last_name" }] }],
    [400, { errors: [{ id: "invalid_full_name", code: 400, details: "Invalid name" }] }],
    [404, { errors: [{ id: "not_found", code: 404, details: "Not found" }] }],
    [422, { errors: [{ id: "unprocessable_entity", code: 422, details: "Invalid domain" }] }],
    [451, { errors: [{ id: "claimed_email", code: 451, details: "GDPR opt-out" }] }],
  ] as const)(
    "settles deterministic Hunter HTTP %s miss cleanly without BUDGET_OPERATION_REPLAY_UNAVAILABLE",
    async (status, body) => {
      const x = world("hunter", { status, body });
      const result = await x.tool.execute({ stepId: STEP }, x.context);
      expect(result.costMicrousd).toBe("1700");
      expect(result.data).toEqual({
        status: "miss",
        email: null,
        providerConfidence: null,
        acceptAll: null,
        pattern: null,
        reason: "no_match",
      });
      expect(x.executePinned).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ["prospeo", 400, { error: true, error_code: "INSUFFICIENT_CREDITS" }],
    ["prospeo", 400, {}],
    ["prospeo", 401, { error: true, error_code: "INVALID_API_KEY" }],
    ["prospeo", 403, { error: true, error_code: "FORBIDDEN" }],
    ["hunter", 400, { errors: [{ id: "insufficient_credits", code: 400 }] }],
    ["hunter", 400, {}],
    ["hunter", 401, { errors: [{ id: "unauthorized", code: 401 }] }],
    ["hunter", 403, { errors: [{ id: "forbidden", code: 403 }] }],
    ["millionverifier", 400, { error: "bad_request" }],
    ["emailable", 422, { message: "unprocessable" }],
    ["zerobounce", 404, { error: "not_found" }],
  ] as const)(
    "preserves fail-closed unknownResult for %s HTTP %s non-miss or auth/billing responses",
    async (provider, status, body) => {
      const x = world(provider, { status, body });
      await expect(
        x.tool.execute({ stepId: STEP }, x.context),
      ).rejects.toThrow("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
      expect(x.executePinned).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["hunter", "prospeo"] as const)(
    "preserves fail-closed unknownResult for %s HTTP 400 unparseable body",
    async (provider) => {
      const x = world(provider, { status: 400, rawBody: "<html>Bad Request</html>" });
      await expect(
        x.tool.execute({ stepId: STEP }, x.context),
      ).rejects.toThrow("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
      expect(x.executePinned).toHaveBeenCalledTimes(1);
    },
  );
  it("logs non-PII provider and HTTP status diagnostics without leaking email or API key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const x = world("hunter", {
        status: 400,
        body: { errors: [{ id: "wrong_params", code: 400, details: "secret@company.example.invalid" }] },
      });
      await x.tool.execute({ stepId: STEP }, x.context);
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain("provider=hunter");
      expect(logged).toContain("http_status=400");
      expect(logged).not.toContain("secret@");
      expect(logged).not.toContain("fake");
    } finally {
      warn.mockRestore();
    }
  });
  it("keeps a complete provider UNKNOWN verdict distinct from transport/error UNKNOWN", async () => {
    const x = world("millionverifier", {
      body: { result: "unknown", accept_all: false },
    });
    const result = await x.tool.execute({ stepId: STEP }, x.context);
    expect(result.costMicrousd).toBe("1780");
    expect(result.data).toMatchObject({
      state: "UNKNOWN",
      reason: "provider_verdict",
    });
  });
  it("requires the existing encryption key before a Hunter wire", async () => {
    const x = world("hunter");
    const key = process.env.PII_ENCRYPTION_KEY;
    delete process.env.PII_ENCRYPTION_KEY;
    try {
      await expect(
        x.tool.execute({ stepId: STEP }, x.context),
      ).rejects.toThrow();
      expect(x.executePinned).not.toHaveBeenCalled();
    } finally {
      if (key === undefined) delete process.env.PII_ENCRYPTION_KEY;
      else process.env.PII_ENCRYPTION_KEY = key;
    }
  });
  it("bounds oversized responses from even an injected executor", async () => {
    const x = world("millionverifier", { rawBody: "x".repeat(1000001) });
    await expect(x.tool.execute({ stepId: STEP }, x.context)).rejects.toThrow();
    expect(x.executePinned).toHaveBeenCalledTimes(1);
  });
  it("keeps a smaller original transport timeout and never expands it to the default", async () => {
    const x = world("emailable", { timeoutMs: 500 });
    await x.tool.execute({ stepId: STEP }, x.context);
    expect(x.executePinned.mock.calls[0]![1]).toMatchObject({ timeoutMs: 500 });
  });
});

it("composes exactly the five controlled definitions through the same actual ToolRegistry", () => {
  const x = world();
  const registry = new ToolRegistry();
  expect(
    registerContactEnrichmentSafetyTools(registry, {
      providers: x.configs,
      currentProvider: x.currentProvider,
      loadTrustedInput: x.loadTrustedInput,
      httpDependencies: {
        resolver: x.resolver,
        executePinned: x.executePinned,
      },
    }),
  ).toBe(registry);
  expect(registry.all()).toHaveLength(5);
  expect(new Set(registry.all().map((t) => t.id)).size).toBe(5);
  expect(x.executePinned).not.toHaveBeenCalled();
});

describe("step gate on the original SMTP protocol dependencies", () => {
  const input = {
    domain: "company.example.invalid",
    mxHost: "mx.company.example.invalid",
    rcptTo: [
      "person@company.example.invalid",
      "x-verify-0123456789abcdef0123@company.example.invalid",
    ],
  };
  const output = { reachable: true, mailFromCode: 250, codes: [250, 550] };
  function smtpWorld() {
    const events: string[] = [];
    const resolveMxHost = vi.fn(async () => {
      events.push("PUBLIC_IP_RESOLVE_FAKE");
      return { safe: true, ip: "93.184.216.34" };
    });
    const executeSmtpProbe = vi.fn(async () => {
      events.push("SMTP_PROTOCOL_FAKE");
      return output;
    });
    const authorizeExternalAction = vi.fn(async () => {
      events.push("AUTHORIZE_CURRENT");
      return true;
    });
    const beforePhysicalWire = vi.fn(async () => {
      events.push("CLAIM_COMMITTED_FAKE");
    });
    const tool = createStepAwareSmtpRcptProbeTool({
      resolveMxHost,
      executeSmtpProbe,
    });
    return {
      events,
      resolveMxHost,
      executeSmtpProbe,
      authorizeExternalAction,
      beforePhysicalWire,
      tool,
    };
  }
  it("keeps the original id, version, schema, zero cent quote, input and key", () => {
    const x = smtpWorld();
    const old = createSmtpRcptProbeTool({
      resolveMxHost: x.resolveMxHost,
      executeSmtpProbe: x.executeSmtpProbe,
    });
    expect(x.tool.id).toBe(old.id);
    expect(x.tool.version).toBe(old.version);
    expect(x.tool.cost).toEqual(old.cost);
    expect(x.tool.durableResultStrategy).toEqual(old.durableResultStrategy);
    expect(x.tool.idempotencyKey(input)).toBe(old.idempotencyKey(input));
    expect(x.tool.physicalWireObservation).toBe("before_each_wire");
  });
  it("claims only after the original public-IP and current-action checks, immediately before SMTP", async () => {
    const x = smtpWorld();
    const result = await x.tool.execute(input, {
      workspaceId: W,
      runId: "actual-account-key",
      authorizeExternalAction: x.authorizeExternalAction,
      beforePhysicalWire: x.beforePhysicalWire,
    });
    expect(x.events).toEqual([
      "AUTHORIZE_CURRENT",
      "PUBLIC_IP_RESOLVE_FAKE",
      "AUTHORIZE_CURRENT",
      "CLAIM_COMMITTED_FAKE",
      "SMTP_PROTOCOL_FAKE",
    ]);
    expect(x.beforePhysicalWire).toHaveBeenCalledTimes(1);
    expect(x.executeSmtpProbe).toHaveBeenCalledTimes(1);
    expect(x.executeSmtpProbe).toHaveBeenCalledWith(
      "93.184.216.34",
      expect.stringContaining("verify@"),
      input.rcptTo,
    );
    expect(result).toEqual({ data: output, costCents: 0 });
  });
  it("does not claim or send when the original SSRF guard denies the MX", async () => {
    const x = smtpWorld();
    x.resolveMxHost.mockResolvedValue({
      safe: false,
      reason: "private_ip",
    } as never);
    const result = await x.tool.execute(input, {
      workspaceId: W,
      authorizeExternalAction: x.authorizeExternalAction,
      beforePhysicalWire: x.beforePhysicalWire,
    });
    expect(result.data.reachable).toBe(false);
    expect(x.beforePhysicalWire).not.toHaveBeenCalled();
    expect(x.executeSmtpProbe).not.toHaveBeenCalled();
  });
  it("does not claim or send after current action denial", async () => {
    const x = smtpWorld();
    x.authorizeExternalAction.mockResolvedValue(false);
    await expect(
      x.tool.execute(input, {
        workspaceId: W,
        authorizeExternalAction: x.authorizeExternalAction,
        beforePhysicalWire: x.beforePhysicalWire,
      }),
    ).rejects.toThrow();
    expect(x.beforePhysicalWire).not.toHaveBeenCalled();
    expect(x.executeSmtpProbe).not.toHaveBeenCalled();
  });
  it("preserves a claim failure and never calls the original SMTP transport", async () => {
    const x = smtpWorld();
    const error = new ExecutionControlError(
      "EXECUTION_BUDGET_AUTHORITY_REVOKED",
    );
    x.beforePhysicalWire.mockRejectedValue(error);
    await expect(
      x.tool.execute(input, {
        workspaceId: W,
        authorizeExternalAction: x.authorizeExternalAction,
        beforePhysicalWire: x.beforePhysicalWire,
      }),
    ).rejects.toBe(error);
    expect(x.executeSmtpProbe).not.toHaveBeenCalled();
  });
  it("never retries a failed original SMTP protocol call", async () => {
    const x = smtpWorld();
    const error = new Error("synthetic_protocol_ack_lost");
    x.executeSmtpProbe.mockRejectedValue(error);
    await expect(
      x.tool.execute(input, {
        workspaceId: W,
        authorizeExternalAction: x.authorizeExternalAction,
        beforePhysicalWire: x.beforePhysicalWire,
      }),
    ).rejects.toBe(error);
    expect(x.beforePhysicalWire).toHaveBeenCalledTimes(1);
    expect(x.executeSmtpProbe).toHaveBeenCalledTimes(1);
  });
  it("does not change legacy SMTP behavior when no step gate was supplied", async () => {
    const x = smtpWorld();
    expect(
      await x.tool.execute(input, {
        workspaceId: W,
        authorizeExternalAction: x.authorizeExternalAction,
      }),
    ).toEqual({ data: output, costCents: 0 });
    expect(x.executeSmtpProbe).toHaveBeenCalledTimes(1);
  });
});
