import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { ExecutionBudgetBinding } from "../../execution-budget/execution-budget-binding";
import type { VerifiedExecutionBudgetAuthority } from "../../execution-budget/execution-budget-authority.types";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import { EnrichmentExecutionRepository, EnrichmentExecutionQueryRepository } from "./enrichment-execution.repository";
import { canonicalSafetyJson } from "./enrichment-safety.contract";
import { linkEnrichmentStepSettled } from "./enrichment-execution.repository";
import type { DurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";

const W = "00000000-0000-4000-8000-000000000001",
  C = "00000000-0000-4000-8000-000000000002",
  A = "00000000-0000-4000-8000-000000000003",
  ACCOUNT = "00000000-0000-4000-8000-000000000004",
  R = "00000000-0000-4000-8000-000000000005";
const SHA = "a".repeat(64);
const plan = (run = false) =>
  buildFrozenEnrichmentPlan({
    workspaceId: W,
    companyId: C,
    entrypoint: run ? "discovery_run" : "http",
    businessRunId: run ? R : null,
    requestSha256: SHA,
    admittedAtMs: 1000,
    deadlineAtMs: 601000,
    targets: [
      {
        contactId: "c1",
        contactOrdinal: 0,
        inputVersion: "v1",
        beforeDigest: "b".repeat(64),
        pointRefs: [],
      },
    ],
    slots: [
      {
        slotKey: "f1",
        contactId: "c1",
        contactOrdinal: 0,
        phase: "FINDER",
        provider: "hunter",
        toolId: "contact_email.find.hunter",
        toolVersion: "1.0.0",
        quoteMicrousd: "1780",
        pricingVersion: "p1",
        dependsOnSlotKey: null,
      },
    ],
    limits: {
      authorityCapMicrousd: "500000",
      companyCapMicrousd: "500000",
      contactCapMicrousd: "150000",
      finderCompanyMax: 10,
      finderContactMax: 3,
      verifyAddressMax: 6,
      maxContacts: 10,
    },
  });
const binding = (run = false): ExecutionBudgetBinding => ({
  authorityId: A,
  replay: false,
  scopeKey: W,
  accountKey: run ? ["discovery.run", "discovery_run", "request:" + SHA, SHA].join(":") : ["contact.enrich", "company", C, SHA].join(":"),
  purpose: run ? "discovery.run" : "contact.enrich",
  subjectType: run ? "discovery_run" : "company",
  // Real run grants scope the request as a derived identity, not the business run UUID.
  subjectId: run ? "request:" + SHA : C,
  requestSha256: SHA,
});
const authority: VerifiedExecutionBudgetAuthority = {
  schemaVersion: "execution-budget-grant/v1",
  authorityKind: "WORKSPACE_GRANT",
  issuer: "https://issuer.example.invalid",
  audience: "global-backend:execution-budget",
  jti: "fake-jti",
  purpose: "contact.enrich",
  workspaceId: W,
  subjectType: "company",
  subjectId: C,
  requestSha256: SHA,
  scheduleId: null,
  currency: "USD",
  unit: "microusd",
  capMicrousd: 500000n,
  capPerRunMicrousd: null,
  campaignCapMicrousd: null,
  maxRuns: null,
  tokenSha256: "c".repeat(64),
  issuedAt: 1,
  notBefore: 1,
  expiresAt: 999,
};
function world(
  options: {
    run?: boolean;
    fail?: "head" | "step";
    account?: Record<string, unknown>;
    existing?: boolean;
  } = {},
) {
  const events: string[] = [];
  const p = plan(options.run);
  const b = binding(options.run);
  const head = {
    id: R,
    workspace_id: W,
    company_id: C,
    authority_id: A,
    account_id: ACCOUNT,
    generation: 1,
    operation_ref: "d".repeat(64),
    plan_sha256: p.planSha256,
    status: "PREPARED",
    admission_request_sha256: SHA,
  };
  const query = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      const sql = strings.join("?");
      events.push(sql);
      if (sql.includes("FROM public.execution_budget_authority"))
        return [{ id: A, scope_key: W, usable: true, revoked_at: null }];
      if (sql.includes("FROM public.tool_budget_account"))
        return [
          {
            account_id: ACCOUNT,
            authority_id: A,
            generation: 1,
            authorized_cap_microusd: 500000n,
            scope_key: W,
            account_key: b.accountKey,
            ...options.account,
          },
        ];
      if (
        sql.includes("INSERT INTO public.contact_enrichment_execution_step")
      ) {
        if (options.fail === "step") throw new Error("synthetic_step_failure");
        return [{ id: "step-1" }];
      }
      if (sql.includes("INSERT INTO public.contact_enrichment_execution")) {
        if (options.fail === "head") throw new Error("synthetic_head_failure");
        return [head];
      }
      if (sql.includes("FROM public.contact_enrichment_execution"))
        return options.existing ? [head] : [];
      throw new Error("unexpected_fake_transaction_query");
    },
  );
  // Fake existing transaction surface only; no proposed model delegate, DDL or real connection.
  const tx = {
    $queryRaw: query,
    $executeRaw: vi.fn(async () => 1),
  } as unknown as Prisma.TransactionClient;
  const db = {
    withWorkspace: vi.fn(
      async <T>(
        workspaceId: string,
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> => {
        expect(workspaceId).toBe(W);
        events.push("BEGIN_FAKE");
        try {
          const result = await fn(tx);
          events.push("COMMIT_FAKE");
          return result;
        } catch (error) {
          events.push("ROLLBACK_FAKE");
          throw error;
        }
      },
    ),
  };
  const consume = vi.fn(
    async (
      _a: VerifiedExecutionBudgetAuthority,
      t: Prisma.TransactionClient,
    ) => {
      expect(t).toBe(tx);
      events.push("CONSUME_SAME_TX");
      return b;
    },
  );
  const repo = new EnrichmentExecutionRepository(db, {
    consumeVerifiedWorkspaceGrantInTransaction: consume,
  });
  return { repo, p, b, events, consume, query };
}
describe("enrichment repository synthetic transaction-port contract, NOT PostgreSQL proof", () => {
  it("consumes verified HTTP grant and reads account identity in the same transaction before head/steps", async () => {
    const x = world();
    const view = await x.repo.admitHttp({
      authority,
      plan: x.p,
      admissionRequestSha256: SHA,
    });
    expect(view.accountId).toBe(ACCOUNT);
    expect(view.generation).toBe(1);
    expect(x.consume).toHaveBeenCalledTimes(1);
    expect(x.events.indexOf("CONSUME_SAME_TX")).toBeLessThan(
      x.events.findIndex((s) =>
        s.includes("INSERT INTO public.contact_enrichment_execution"),
      ),
    );
    expect(x.events.at(-1)).toBe("COMMIT_FAKE");
  });
  it.each(["head", "step"] as const)(
    "propagates %s failure without returning success after consumption",
    async (fail) => {
      const x = world({ fail });
      await expect(
        x.repo.admitHttp({ authority, plan: x.p, admissionRequestSha256: SHA }),
      ).rejects.toThrow("synthetic_" + fail + "_failure");
      expect(x.events.at(-1)).toBe("ROLLBACK_FAKE");
      expect(x.consume).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { authority_id: C },
    { generation: 0 },
    { authorized_cap_microusd: null },
    { scope_key: C },
  ])(
    "rejects current account identity/cap mismatch %j before insertion",
    async (account) => {
      const x = world({ account });
      await expect(
        x.repo.admitHttp({ authority, plan: x.p, admissionRequestSha256: SHA }),
      ).rejects.toThrow("CONTROL_MISMATCH");
      expect(x.events.some((s) => s.includes("INSERT INTO"))).toBe(false);
    },
  );
  it("uses actual run binding whose subject is the request scope, not the business run UUID", async () => {
    const x = world({ run: true });
    const view = await x.repo.admitRun({ binding: x.b, plan: x.p, admissionRequestSha256: SHA });
    expect(view.accountId).toBe(ACCOUNT); expect(x.consume).not.toHaveBeenCalled(); expect(x.events.at(-1)).toBe("COMMIT_FAKE");
  });
  it("uses actual run binding without a second grant", async () => {
    const x = world({ run: true });
    await x.repo.admitRun({
      binding: x.b,
      plan: x.p,
      admissionRequestSha256: SHA,
    });
    expect(x.consume).not.toHaveBeenCalled();
    expect(
      x.query.mock.calls.some((c) => c.slice(1).includes(x.b.accountKey)),
    ).toBe(true);
  });
  it("returns an existing run head without reselecting or overwriting its frozen plan", async () => {
    const x = world({ run: true, existing: true });
    const body = { ...x.p };
    const { version, planSha256, ...original } = body;
    void version;
    void planSha256;
    const changed = buildFrozenEnrichmentPlan({
      ...original,
      admittedAtMs: 2000,
      deadlineAtMs: 602000,
      targets: [
        { ...original.targets[0]!, inputVersion: "new-current-version" },
      ],
    });
    const view = await x.repo.admitRun({
      binding: x.b,
      plan: changed,
      admissionRequestSha256: SHA,
    });
    expect(view.planSha256).toBe(x.p.planSha256);
    expect(x.events.some((s) => s.includes("INSERT INTO"))).toBe(false);
    expect(x.consume).not.toHaveBeenCalled();
  });
});

const STEP = "00000000-0000-4000-8000-000000000006",
  CONTACT = "00000000-0000-4000-8000-000000000007",
  OP = "00000000-0000-4000-8000-000000000008";
const FINGERPRINT = "e".repeat(64);
function stepWorld(
  options: {
    sealed?: boolean;
    phase?: "FINDER" | "VERIFY";
    row?: Record<string, unknown>;
    account?: Record<string, unknown>;
    operation?: Record<string, unknown>;
    price?: string;
    deny?: boolean;
    casZero?: boolean;
    pendingConflict?: boolean;
    noGuards?: boolean;
    originDeny?: boolean;
    secondRead?: Record<string, unknown>;
  } = {},
) {
  const events: string[] = [];
  const b = binding();
  const row: import("./enrichment-safety.contract").EnrichmentStepContextRow = {
    id: STEP,
    workspace_id: W,
    company_id: C,
    execution_id: R,
    contact_id: CONTACT,
    contact_ordinal: 0,
    slot_key: "f1",
    phase: options.phase ?? "FINDER",
    provider: options.phase === "VERIFY" ? "millionverifier" : "hunter",
    tool_id:
      options.phase === "VERIFY"
        ? "contact_email.verify.millionverifier"
        : "contact_email.find.hunter",
    tool_version: "1.0.0",
    quote_microusd: 1780n,
    pricing_version: "p1",
    depends_on_slot_key:
      options.phase === "VERIFY" ? "finder-predecessor" : null,
    input_fingerprint: options.sealed ? FINGERPRINT : null,
    operation_key: options.sealed ? "original-op-key" : null,
    budget_operation_id: null,
    candidate_ref: null,
    revision: options.sealed ? 2 : 1,
    dispatch_phase: "ADMITTED",
    domain_state: "PENDING",
    authority_id: A,
    account_id: ACCOUNT,
    generation: 1,
    account_key: b.accountKey,
    execution_status: "PREPARED",
    deadline_open: true,
    ...options.row,
  };
  let contextReads = 0;
  const query = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      const sql = strings.join("?");
      events.push(sql);
      if (sql.includes("FROM public.execution_budget_authority"))
        return [{ id: A, scope_key: W, usable: true, revoked_at: null }];
      if (sql.includes("FROM public.tool_budget_account"))
        return [
          {
            account_id: ACCOUNT,
            scope_key: W,
            account_key: b.accountKey,
            authority_id: A,
            generation: 1,
            authorized_cap_microusd: 500000n,
            closed_at: null,
            ref_count: 1,
            ...options.account,
          },
        ];
      if (sql.includes("FOR UPDATE OF e,s"))
        return [{ execution_id: R, step_id: STEP }];
      if (sql.includes("FROM public.contact_enrichment_execution_step s")) {
        contextReads += 1;
        return [{ ...row, ...(contextReads > 1 ? options.secondRead : {}) }];
      }
      if (sql.includes("FROM public.tool_budget_operation"))
        return [
          {
            operation_id: OP,
            scope_key: W,
            account_id: ACCOUNT,
            generation: 1,
            operation_key: "original-op-key",
            status: "RESERVED",
            amount_unit: "microusd",
            reserved_microusd: 1780n,
            ...options.operation,
          },
        ];
      if (sql.includes("UPDATE public.contact_enrichment_execution_step")) {
        if (options.pendingConflict)
          throw new Error("synthetic_pending_fence_conflict");
        if (options.casZero) return [];
        if (sql.includes("SET input_fingerprint")) {
          expect(typeof values[0]).toBe("string");
          expect(typeof values[1]).toBe("string");
          row.input_fingerprint = values[0] as string;
          row.operation_key = values[1] as string;
          row.candidate_ref =
            values[2] === null ? null : JSON.parse(values[2] as string);
          row.revision += 1;
        } else if (sql.includes("SET budget_operation_id")) {
          row.budget_operation_id = OP;
          row.dispatch_phase = "RESERVED";
          row.revision += 1;
        }
        return [{ id: STEP }];
      }
      throw new Error("unexpected_fake_step_query");
    },
  );
  const tx = {
    $queryRaw: query,
    $executeRaw: vi.fn(async () => 1),
  } as unknown as Prisma.TransactionClient;
  const database = {
    withWorkspace: vi.fn(
      async <T>(
        workspaceId: string,
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> => {
        expect(workspaceId).toBe(W);
        events.push("BEGIN_FAKE");
        try {
          const value = await fn(tx);
          events.push("COMMIT_FAKE");
          return value;
        } catch (error) {
          events.push("ROLLBACK_FAKE");
          throw error;
        }
      },
    ),
  };
  const guards = {
    assertCurrentSubjectAndPolicy: vi.fn(
      async (t: Prisma.TransactionClient) => {
        expect(t).toBe(tx);
        events.push("CURRENT_SQL_GATES");
        if (options.deny) throw new Error("synthetic_policy_denial");
        return { pricingVersion: options.price ?? "p1" };
      },
    ),
    assertCandidateOrigin: vi.fn(async (t: Prisma.TransactionClient) => {
      expect(t).toBe(tx);
      events.push("ORIGINAL_CANDIDATE_SQL_CHECK");
      if (options.originDeny)
        throw new Error("synthetic_original_receipt_mismatch");
    }),
  };
  const consumer = {
    consumeVerifiedWorkspaceGrantInTransaction: vi.fn(async () => b),
  };
  const repo = new EnrichmentExecutionRepository(
    database,
    consumer,
    options.noGuards ? undefined : guards,
  );
  const address = { workspaceId: W, companyId: C, stepId: STEP };
  const seal = {
    ...address,
    expectedRevision: 1,
    inputFingerprint: FINGERPRINT,
    operationKey: "original-op-key",
    candidateRef: null,
  };
  const claim = {
    ...address,
    expectedRevision: 2,
    operationKey: "original-op-key",
    expectedPricingVersion: "p1",
  };
  return { repo, row, events, guards, query, seal, claim, consumer };
}
describe("input sealing and before-wire original-ledger transaction ports, NOT real PostgreSQL exclusivity", () => {
  it("seals an admitted finder exactly once and replays only the same complete input", async () => {
    const x = stepWorld();
    const a = await x.repo.bindStepInput(x.seal);
    const b = await x.repo.bindStepInput(x.seal);
    expect(a.inputFingerprint).toBe(FINGERPRINT);
    expect(a.revision).toBe(2);
    expect(b).toEqual(a);
    expect(
      x.events.filter((s) => s.includes("SET input_fingerprint")),
    ).toHaveLength(1);
    expect(
      x.consumer.consumeVerifiedWorkspaceGrantInTransaction,
    ).not.toHaveBeenCalled();
  });
  it.each([
    { inputFingerprint: "f".repeat(64) },
    { operationKey: "different-original-operation" },
  ])("rejects a changed input binding after seal %j", async (changes) => {
    const x = stepWorld({ sealed: true });
    await expect(
      x.repo.bindStepInput({ ...x.seal, ...changes }),
    ).rejects.toThrow("INPUT_CONFLICT");
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("does not seal an unsealed row under a stale revision", async () => {
    const x = stepWorld({ row: { revision: 2 } });
    await expect(x.repo.bindStepInput(x.seal)).rejects.toThrow("HOLD");
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("does not seal verification without the original persisted candidate reference", async () => {
    const x = stepWorld({ phase: "VERIFY" });
    await expect(x.repo.bindStepInput(x.seal)).rejects.toThrow(
      "CONTROL_MISMATCH",
    );
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("propagates a pending-fence conflict without returning a new sealed operation", async () => {
    const x = stepWorld({ pendingConflict: true });
    await expect(x.repo.bindStepInput(x.seal)).rejects.toThrow(
      "synthetic_pending_fence_conflict",
    );
    expect(x.events.at(-1)).toBe("ROLLBACK_FAKE");
  });
  it("claims only the exact original RESERVED operation and resolves after the transaction port commits", async () => {
    const x = stepWorld({ sealed: true });
    const result = await x.repo.claimStepBeforeWire(x.claim);
    expect(result.budgetOperationId).toBe(OP);
    expect(result.revision).toBe(3);
    expect(x.events.indexOf("CURRENT_SQL_GATES")).toBeLessThan(
      x.events.findIndex((s) => s.includes("SET budget_operation_id")),
    );
    expect(x.events.at(-1)).toBe("COMMIT_FAKE");
    await expect(
      x.repo.claimStepBeforeWire({ ...x.claim, expectedRevision: 3 }),
    ).rejects.toThrow("HOLD");
    expect(
      x.events.filter((s) => s.includes("SET budget_operation_id")),
    ).toHaveLength(1);
  });
  it("does not look for a reserve before input sealing", async () => {
    const x = stepWorld();
    await expect(
      x.repo.claimStepBeforeWire({ ...x.claim, expectedRevision: 1 }),
    ).rejects.toThrow("HOLD");
    expect(
      x.events.some((s) => s.includes("FROM public.tool_budget_operation")),
    ).toBe(false);
  });
  it.each([
    { reserved_microusd: 1779n },
    { account_id: C },
    { generation: 2 },
    { operation_key: "wrong-key" },
    { scope_key: C },
  ])(
    "rejects original operation identity or quote drift %#",
    async (operation) => {
      const x = stepWorld({ sealed: true, operation });
      await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow(
        "CONTROL_MISMATCH",
      );
      expect(
        x.events.some((s) =>
          s.includes("UPDATE public.contact_enrichment_execution_step"),
        ),
      ).toBe(false);
    },
  );
  it.each(["RESULT_UNKNOWN", "SETTLED", "RELEASED"])(
    "holds an existing %s operation instead of claiming again",
    async (status) => {
      const x = stepWorld({ sealed: true, operation: { status } });
      await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow("HOLD");
      expect(
        x.events.some((s) =>
          s.includes("UPDATE public.contact_enrichment_execution_step"),
        ),
      ).toBe(false);
    },
  );
  it.each([{ authority_id: C }, { generation: 2 }, { closed_at: new Date(0) }])(
    "rejects current account identity/open-state mismatch %#",
    async (account) => {
      const x = stepWorld({ sealed: true, account });
      await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow(
        "CONTROL_MISMATCH",
      );
      expect(
        x.events.some((s) =>
          s.includes("UPDATE public.contact_enrichment_execution_step"),
        ),
      ).toBe(false);
    },
  );
  it("holds an expired frozen deadline", async () => {
    const x = stepWorld({ sealed: true, row: { deadline_open: false } });
    await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow("HOLD");
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("does not claim when the current trusted price version changed", async () => {
    const x = stepWorld({ sealed: true, price: "price-v2" });
    await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow(
      "CONTROL_MISMATCH",
    );
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("does not claim when the current subject/policy check rejects", async () => {
    const x = stepWorld({ sealed: true, deny: true });
    await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow(
      "synthetic_policy_denial",
    );
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("fails closed when current SQL/policy guards are not composed", async () => {
    const x = stepWorld({ sealed: true, noGuards: true });
    await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow("HOLD");
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("does not turn a lost CAS into a successful physical claim", async () => {
    const x = stepWorld({ sealed: true, casZero: true });
    await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow("HOLD");
    expect(x.events.at(-1)).toBe("ROLLBACK_FAKE");
  });
  it("keeps a redacted contact out of seal/claim", async () => {
    const x = stepWorld({ sealed: true, row: { contact_id: null } });
    await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow(
      "REDACTED",
    );
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
});

function originalCandidate() {
  return {
    operationId: OP,
    resultDigest: "b".repeat(64),
    artifactRef: {
      schemaVersion: "generic-operation-artifact-ref/v1" as const,
      artifactId: "00000000-0000-4000-8000-000000000010",
      operationId: OP,
      resultSchema: "contact-email-find-hunter/v1",
      sha256: "b".repeat(64),
      sizeBytes: "128",
      mediaType: "application/octet-stream",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
}
describe("original-candidate and locked immutable identity guard ports", () => {
  it("requires the original candidate SQL guard before persisting a verification input and again before its claim", async () => {
    const x = stepWorld({ phase: "VERIFY" });
    const candidateRef = originalCandidate();
    const sealed = await x.repo.bindStepInput({ ...x.seal, candidateRef });
    expect(sealed.candidateRef).toEqual(candidateRef);
    expect(x.guards.assertCandidateOrigin).toHaveBeenCalledTimes(1);
    await x.repo.claimStepBeforeWire(x.claim);
    expect(x.guards.assertCandidateOrigin).toHaveBeenCalledTimes(2);
    expect(x.events.indexOf("ORIGINAL_CANDIDATE_SQL_CHECK")).toBeLessThan(
      x.events.findIndex((s) => s.includes("SET input_fingerprint")),
    );
  });
  it("does not persist a candidate rejected by the original receipt/ledger SQL guard", async () => {
    const x = stepWorld({ phase: "VERIFY", originDeny: true });
    await expect(
      x.repo.bindStepInput({ ...x.seal, candidateRef: originalCandidate() }),
    ).rejects.toThrow("synthetic_original_receipt_mismatch");
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it("cannot swap a sealed candidate receipt even when account, phase and address fingerprint are unchanged", async () => {
    const a = originalCandidate();
    const x = stepWorld({
      sealed: true,
      phase: "VERIFY",
      row: { candidate_ref: a },
    });
    const b = {
      ...a,
      resultDigest: "a".repeat(64),
      artifactRef: { ...a.artifactRef, sha256: "a".repeat(64) },
    };
    await expect(
      x.repo.bindStepInput({ ...x.seal, candidateRef: b }),
    ).rejects.toThrow("INPUT_CONFLICT");
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
  it.each([
    { quote_microusd: 1700n },
    { pricing_version: "changed-price" },
    { authority_id: C },
    { generation: 2 },
  ])(
    "rejects immutable identity change between metadata read and row locks %#",
    async (secondRead) => {
      const x = stepWorld({ sealed: true, secondRead });
      await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow(
        "CONTROL_MISMATCH",
      );
      expect(
        x.events.some((s) =>
          s.includes("UPDATE public.contact_enrichment_execution_step"),
        ),
      ).toBe(false);
    },
  );
  it("rejects an unsupported producer before any mutation, not only before returning a bound value", async () => {
    const x = stepWorld({ sealed: true, row: { provider: "findymail" } });
    await expect(x.repo.claimStepBeforeWire(x.claim)).rejects.toThrow(
      "GOVERNANCE_PENDING",
    );
    expect(
      x.events.some((s) =>
        s.includes("UPDATE public.contact_enrichment_execution_step"),
      ),
    ).toBe(false);
  });
});


describe('frozen minimal original execution policy inside the admission transaction', () => {
  function frozenHeadOptions(x: ReturnType<typeof world>) {
    const call = x.query.mock.calls.find((call) => call[0].join('?').includes('INSERT INTO public.contact_enrichment_execution') && !call[0].join('?').includes('INSERT INTO public.contact_enrichment_execution_step'));
    const raw = call?.slice(1).find((value) => typeof value === 'string' && value.includes('"caps":'));
    if (typeof raw !== 'string') throw new Error('missing synthetic frozen limits observation');
    return JSON.parse(raw) as Record<string, unknown>;
  }
  it('freezes only original lawful-basis kind/tier and aggregate target count, not note/ref/PII or funds', async () => {
    const x = world(); await x.repo.admitHttp({ authority, plan: x.p, admissionRequestSha256: SHA, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' } } as never);
    expect(frozenHeadOptions(x)).toMatchObject({ targetCount: 1, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' } });
    expect(x.consume).toHaveBeenCalledTimes(1); expect(x.events.at(-1)).toBe('COMMIT_FAKE');
  });
  it('uses the same frozen policy for a run without consuming another Grant', async () => {
    const x = world({ run: true }); await x.repo.admitRun({ binding: x.b, plan: x.p, admissionRequestSha256: SHA, executionOptions: { lawfulBasisKind: 'contract', tier: 'A' } } as never);
    expect(frozenHeadOptions(x)).toMatchObject({ targetCount: 1, executionOptions: { lawfulBasisKind: 'contract', tier: 'A' } }); expect(x.consume).not.toHaveBeenCalled();
  });
  it.each([{ lawfulBasisKind: 'none', tier: 'B' }, { lawfulBasisKind: 'legitimate_interest', tier: 'C' }, { lawfulBasisKind: 'legitimate_interest', tier: 'B', apiKey: 'PII_SENTINEL' }])('rejects missing-policy or extra credential metadata before HTTP consumption %#', async (executionOptions) => {
    const x = world(); await expect(x.repo.admitHttp({ authority, plan: x.p, admissionRequestSha256: SHA, executionOptions } as never)).rejects.toThrow(); expect(x.consume).not.toHaveBeenCalled(); expect(x.query).not.toHaveBeenCalled();
  });
});


describe('frozen execution SELECT lookup, pure transaction port not SQL proof', () => {
  function queryWorld(options: { run?: boolean; redacted?: boolean; foreign?: boolean; duplicate?: boolean; generation?: number } = {}) {
    const { version, planSha256, ...original } = plan(options.run); void version; void planSha256;
    const p = buildFrozenEnrichmentPlan({ ...original, targets: [{ ...original.targets[0]!, contactId: CONTACT, inputVersion: 'a'.repeat(64) }], slots: original.slots.map((slot) => ({ ...slot, contactId: CONTACT })) });
    const b = binding(options.run); const head = { id: R, workspace_id: options.foreign ? C : W, company_id: C, authority_id: A, account_id: ACCOUNT, generation: 1, account_key: b.accountKey, entrypoint: p.entrypoint, business_run_id: p.businessRunId, request_sha256: p.requestSha256, admission_request_sha256: SHA, operation_ref: 'd'.repeat(64), protocol_version: 1, plan_sha256: p.planSha256, status: options.redacted ? 'REDACTED' : 'PREPARED', frozen_limits: { caps: p.limits, admittedAtMs: p.admittedAtMs, deadlineAtMs: p.deadlineAtMs, targetCount: 1, executionOptions: { lawfulBasisKind: 'legitimate_interest', tier: 'B' } }, target_snapshot: options.redacted ? [] : p.targets, created_at: new Date(1000), result_revision: 1, result_snapshot: null, current_account_id: ACCOUNT, current_authority_id: A, current_generation: options.generation ?? 1 };
    const slot = p.slots[0]!;
    const step = { id: STEP, workspace_id: W, company_id: C, execution_id: R, contact_id: options.redacted ? null : CONTACT, contact_ordinal: 0, slot_key: slot.slotKey, phase: slot.phase, provider: slot.provider, tool_id: slot.toolId, tool_version: slot.toolVersion, quote_microusd: BigInt(slot.quoteMicrousd), pricing_version: slot.pricingVersion, depends_on_slot_key: null, input_fingerprint: null, operation_key: null, budget_operation_id: null, candidate_ref: null, revision: 1, dispatch_phase: 'ADMITTED', domain_state: options.redacted ? 'REDACTED' : 'PENDING', authority_id: A, account_id: ACCOUNT, generation: 1, account_key: b.accountKey, execution_status: head.status, deadline_open: false, budget_original_id: null, budget_status: null, budget_amount_unit: null, budget_reserved_microusd: null, budget_charged_microusd: null, budget_result_schema: null, budget_result_digest: null, budget_result_json: null, budget_receipt_usage: null, budget_receipt_cost_basis: null };
    const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { void values; const sql = strings.join('?'); return sql.includes('FROM public.contact_enrichment_execution_step') ? [step] : options.duplicate ? [head, head] : [head]; });
    const database = { withWorkspace: vi.fn(async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRaw: query })) };
    return { repository: new EnrichmentExecutionQueryRepository(database as never), query, p, b, head, step, context: { workspaceId: W, companyId: C } };
  }
  it('cold-loads the exact frozen plan/options/targets/deadline and actual account key with scoped SELECTs only', async () => {
    const x = queryWorld(); const result = await x.repository.loadByRef(x.context, 'd'.repeat(64)); expect(result?.plan).toEqual(x.p); expect(result?.accountKey).toBe(x.b.accountKey); expect(result?.targetCount).toBe(1); expect(result?.executionOptions).toEqual({ lawfulBasisKind: 'legitimate_interest', tier: 'B' });
    expect(x.query).toHaveBeenCalledTimes(2); expect(x.query.mock.calls[0]?.slice(1)).toEqual(expect.arrayContaining([W, C, 'd'.repeat(64)])); expect(x.query.mock.calls.map((call) => call[0].join('?')).join(' ')).not.toMatch(/INSERT INTO|UPDATE public|DELETE FROM|FOR UPDATE/);
  });
  it('finds an old run before a caller can build a fresh plan', async () => { const x = queryWorld({ run: true }); expect((await x.repository.loadByRun(x.context, R))?.view.operationRef).toBe('d'.repeat(64)); expect(x.query.mock.calls[0]?.slice(1)).toEqual(expect.arrayContaining([W, C, R])); });
  it('preserves original frozen generation next to current account facts rather than rewriting history', async () => { const x = queryWorld({ generation: 2 }); const result = await x.repository.loadById(x.context, R); expect(result?.view.generation).toBe(1); expect(result?.currentAccount.generation).toBe(2); expect(result?.plan).toEqual(x.p); });
  it('keeps redacted audit metadata and aggregate target count without reconstructing live personal targets', async () => { const x = queryWorld({ redacted: true }); const result = await x.repository.loadById(x.context, R); expect(result?.view.status).toBe('REDACTED'); expect(result?.plan).toBeNull(); expect(result?.targetCount).toBe(1); });
  it('rejects a foreign row even if a fake executor ignores the SQL predicate', async () => { const x = queryWorld({ foreign: true }); expect(await x.repository.loadById(x.context, R)).toBeNull(); expect(x.query).toHaveBeenCalledTimes(1); });
  it('does not choose a new/latest run identity from ambiguous old heads', async () => { const x = queryWorld({ run: true, duplicate: true }); await expect(x.repository.loadByRun(x.context, R)).rejects.toThrow(); });
});

const LINK_STEP = "00000000-0000-4000-8000-000000000061";
const LINK_OP = "00000000-0000-4000-8000-000000000062";
const LINK_ART = "00000000-0000-4000-8000-000000000063";
const LINK_RECEIPT: DurableExecutionReceipt = {
  schemaVersion: "durable-execution-receipt/v1",
  scopeKey: W,
  authorityId: A,
  accountId: ACCOUNT,
  operationId: LINK_OP,
  operationKey: "original-op-key",
  resultStrategy: "artifact_reference",
  resultSchema: "contact-email-find-hunter/v1",
  resultDigest: "d".repeat(64),
  artifactId: LINK_ART,
  usage: { currency: "USD", unit: "microusd", callCount: 1, upperBoundMicrousd: "1780", chargedMicrousd: "1780" },
  costBasis: "estimated_upper_bound",
  status: "SETTLED",
};
const { version: LINK_VERSION, ...LINK_RECEIPT_BODY } = LINK_RECEIPT as unknown as Record<string, unknown> & { version?: unknown };
void LINK_VERSION;
const LINK_REFERENCE = Object.freeze({
  stepId: LINK_STEP,
  producerId: "contact_email.find.hunter",
  resultSchema: "contact-email-find-hunter/v1",
  resultDigest: LINK_RECEIPT.resultDigest,
  durableReceipt: LINK_RECEIPT,
});
function linkWorld(options: { phase: string; row?: Record<string, unknown>; updateRows?: number } = { phase: "RESERVED" }) {
  const events: string[] = [];
  const row = {
    id: LINK_STEP,
    revision: 3,
    dispatch_phase: options.phase,
    budget_operation_id: LINK_OP,
    operation_key: "original-op-key",
    result_digest: LINK_RECEIPT.resultDigest,
    receipt: LINK_RECEIPT_BODY,
    artifact_reference: { artifactId: LINK_ART, operationId: LINK_OP },
    ...options.row,
  };
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    void values;
    const sql = strings.join("?");
    events.push(sql);
    if (sql.includes("SELECT id::text,revision,dispatch_phase")) return [row];
    if (sql.includes("SET result_digest=")) return options.updateRows === 0 ? [] : [{ id: LINK_STEP }];
    throw new Error("unexpected_link_query: " + sql.slice(0, 120));
  });
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  return { tx, row, query, events };
}
describe("F19 exact link idempotence: only genuinely missing links take the narrow CAS", () => {
  it.each(["RESERVED", "RESULT_UNKNOWN"] as const)("links a %s step exactly once with the existing revision CAS", async (phase) => {
    const x = linkWorld({ phase });
    await linkEnrichmentStepSettled(x.tx, { workspaceId: W, executionId: R, stepId: LINK_STEP, expectedRevision: 3, operationId: LINK_OP, reference: LINK_REFERENCE });
    expect(x.events.filter((sql) => sql.includes("SET result_digest="))).toHaveLength(1);
    expect(x.events.find((sql) => sql.includes("SET result_digest="))).toContain("SETTLED_WAITING_APPLY");
    expect(x.events.find((sql) => sql.includes("SET result_digest="))).toContain("dispatch_phase IN ('RESERVED','RESULT_UNKNOWN')");
  });
  it.each(["SETTLED_WAITING_APPLY", "SETTLED"] as const)("replays a %s step read-only with no update or revision bump", async (phase) => {
    const x = linkWorld({ phase });
    await linkEnrichmentStepSettled(x.tx, { workspaceId: W, executionId: R, stepId: LINK_STEP, expectedRevision: 3, operationId: LINK_OP, reference: LINK_REFERENCE });
    expect(x.events.some((sql) => sql.includes("SET result_digest="))).toBe(false);
    expect(x.row.revision).toBe(3);
  });
  it.each([
    { result_digest: "e".repeat(64) },
    { receipt: { ...LINK_RECEIPT_BODY, operationId: LINK_ART } },
    { artifact_reference: { artifactId: LINK_ART, operationId: LINK_ART } },
  ])("holds a terminal step whose persisted facts are not byte-identical %#", async (row) => {
    const x = linkWorld({ phase: "SETTLED", row });
    await expect(linkEnrichmentStepSettled(x.tx, { workspaceId: W, executionId: R, stepId: LINK_STEP, expectedRevision: 3, operationId: LINK_OP, reference: LINK_REFERENCE })).rejects.toThrow("HOLD");
    expect(x.events.some((sql) => sql.includes("SET result_digest="))).toBe(false);
  });
  it("holds a missing row and a non-terminal phase instead of widening the CAS", async () => {
    const missing = linkWorld({ phase: "RESERVED" });
    missing.query.mockResolvedValueOnce([] as never);
    await expect(linkEnrichmentStepSettled(missing.tx, { workspaceId: W, executionId: R, stepId: LINK_STEP, expectedRevision: 3, operationId: LINK_OP, reference: LINK_REFERENCE })).rejects.toThrow("HOLD");
    const released = linkWorld({ phase: "RELEASED" });
    await expect(linkEnrichmentStepSettled(released.tx, { workspaceId: W, executionId: R, stepId: LINK_STEP, expectedRevision: 3, operationId: LINK_OP, reference: LINK_REFERENCE })).rejects.toThrow("HOLD");
    expect(released.events.some((sql) => sql.includes("SET result_digest="))).toBe(false);
  });
  it("receipt comparison uses the canonical body without the schema version field", async () => {
    const x = linkWorld({ phase: "SETTLED" });
    await linkEnrichmentStepSettled(x.tx, { workspaceId: W, executionId: R, stepId: LINK_STEP, expectedRevision: 3, operationId: LINK_OP, reference: LINK_REFERENCE });
    expect(canonicalSafetyJson(x.row.receipt)).toBe(canonicalSafetyJson(LINK_RECEIPT_BODY));
  });
});

