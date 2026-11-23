import { registerSourceResultProjections } from "../../durable-results/source-result-projections";
import { describe, expect, it, vi } from "vitest";
import { projectGenericOperationResult } from "../../tools/generic-operation-projection";
import type { BudgetOperationResultReadback } from "../../tools/budget-operation-result";
import type { DurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import { TypedProjectionRegistry } from "../../durable-results/typed-projection.registry";
import { registerContactEmailVerificationProjections } from "../../durable-results/contact-email-verification-projections";
import type { GenericOperationArtifactManifest } from "../../durable-results/artifact/artifact.types";
import type { BoundEnrichmentStep } from "./enrichment-safety.contract";
import {
  EnrichmentResultReader,
  EnrichmentOriginalResultRepository,
  type EnrichmentOriginalResultBinding,
  type EnrichmentResultReaderDeps,
} from "./enrichment-result-reader";
const W = "00000000-0000-4000-8000-000000000001",
  C = "00000000-0000-4000-8000-000000000002",
  A = "00000000-0000-4000-8000-000000000003",
  ACCOUNT = "00000000-0000-4000-8000-000000000004",
  EXEC = "00000000-0000-4000-8000-000000000005",
  STEP = "00000000-0000-4000-8000-000000000006",
  CONTACT = "00000000-0000-4000-8000-000000000007",
  OP = "00000000-0000-4000-8000-000000000008",
  ART = "00000000-0000-4000-8000-000000000009";
function world(
  options: {
    finder?: boolean;
    smtp?: boolean;
    budgetStatus?: Exclude<BudgetOperationResultReadback["status"], "SETTLED">;
    accountGeneration?: number;
    accountAuthority?: string;
    missingReader?: boolean;
    redacted?: boolean;
    receipt?: Partial<DurableExecutionReceipt>;
    digest?: string;
    materializerFails?: boolean;
    artifactExpired?: boolean;
    unknown?: boolean;
  } = {},
) {
  const projections = registerContactEmailVerificationProjections(
    new TypedProjectionRegistry(),
  );
  if (options.smtp) registerSourceResultProjections(projections);
  const schema = options.smtp
    ? "smtp-probe-verdict/v1"
    : "contact-email-verify-millionverifier/v1";
  const vote = options.smtp
    ? {
        data: { reachable: true, mailFromCode: 250, codes: [250, 550] },
        costCents: 0,
      }
    : {
        data: {
          providerKey: "millionverifier",
          state: "VALID",
          catchAll: "not_catch_all",
          catchAllClass: "not_catch_all",
          score: 90,
          acceptAll: false,
          disposable: false,
          role: false,
          reason: "provider_verdict",
          costBasis: "estimated_upper_bound",
        },
        costCents: 0.178,
        costMicrousd: "1780",
      };
  const projection = projectGenericOperationResult({
    kind: "tool",
    schema,
    data: JSON.parse(JSON.stringify(projections.project(schema, vote))),
  });
  const step: BoundEnrichmentStep = {
    slotKey: "slot1",
    contactId: CONTACT,
    contactOrdinal: 0,
    phase: options.finder ? "FINDER" : options.smtp ? "SMTP" : "VERIFY",
    provider: options.finder
      ? "hunter"
      : options.smtp
        ? "smtp_self"
        : "millionverifier",
    toolId: options.finder
      ? "contact_email.find.hunter"
      : options.smtp
        ? "smtp.rcpt_probe"
        : "contact_email.verify.millionverifier",
    toolVersion: "1.0.0",
    quoteMicrousd: options.smtp ? "0" : "1780",
    pricingVersion: "p1",
    dependsOnSlotKey: options.finder ? null : "finder-slot",
    stepId: STEP,
    executionId: EXEC,
    workspaceId: W,
    companyId: C,
    authorityId: A,
    accountId: ACCOUNT,
    generation: 1,
    accountKey: "frozen-actual-account-key",
    inputFingerprint: "e".repeat(64),
    operationKey: "original-op-key",
    candidateRef: null,
    revision: 3,
    budgetOperationId: OP,
  };
  const artifactReference = {
    schemaVersion: "generic-operation-artifact-ref/v1" as const,
    artifactId: ART,
    operationId: OP,
    resultSchema: "contact-email-find-hunter/v1",
    sha256: "a".repeat(64),
    sizeBytes: "29",
    mediaType: "application/octet-stream",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const receipt: DurableExecutionReceipt = {
    schemaVersion: "durable-execution-receipt/v1",
    scopeKey: W,
    authorityId: A,
    accountId: ACCOUNT,
    operationId: OP,
    operationKey: step.operationKey,
    resultStrategy: options.finder ? "artifact_reference" : "typed_projection",
    resultSchema: options.finder ? artifactReference.resultSchema : schema,
    resultDigest: options.finder ? artifactReference.sha256 : projection.digest,
    artifactId: options.finder ? ART : null,
    usage: {
      currency: "USD",
      unit: "microusd",
      callCount: 1,
      upperBoundMicrousd: options.smtp ? "0" : "1780",
    },
    costBasis: "estimated_upper_bound",
    status: "SETTLED",
    ...options.receipt,
  };
  const binding: EnrichmentOriginalResultBinding = {
    step,
    redacted: options.redacted ?? false,
    currentAccount: {
      accountId: ACCOUNT,
      authorityId: options.accountAuthority ?? A,
      generation: options.accountGeneration ?? 1,
    },
    originalOperationId: OP,
    expectedResultDigest: options.digest ?? receipt.resultDigest,
    ledgerStatus: options.unknown ? "RESULT_UNKNOWN" : "SETTLED",
    artifactReference:
      options.finder && !options.unknown ? artifactReference : null,
    originalReceipt: options.finder && !options.unknown ? receipt : null,
    originalReservation: {
      workspaceId: W,
      accountKey: step.accountKey,
      operationId: OP,
      estimatedMicrousd: options.smtp ? 0n : 1780n,
      authorityId: A,
      replay: true,
    },
  };
  let consumed = 0;
  const readOperation = vi.fn(async () =>
    options.budgetStatus
      ? { status: options.budgetStatus }
      : { status: "SETTLED" as const, projection, receipt },
  );
  const manifest: GenericOperationArtifactManifest = {
    schemaVersion: "generic-operation-artifact/v1",
    artifactId: ART,
    scopeKind: "workspace",
    workspaceId: W,
    authorityId: A,
    operationId: OP,
    resultSchema: artifactReference.resultSchema,
    objectKey: "pii/FAKE_OBJECT_KEY_NOT_RETURNED",
    sha256: artifactReference.sha256,
    sizeBytes: artifactReference.sizeBytes,
    mediaType: "application/octet-stream",
    privacyClass: "PERSONAL_DATA",
    sourceDigest: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    expiresAt: options.artifactExpired
      ? "2020-01-01T00:00:00.000Z"
      : artifactReference.expiresAt,
  };
  const readVerified = vi.fn(async () => ({
    manifest,
    expectedFacts: undefined,
    body: (async function* () {
      consumed += 1;
      yield Buffer.from("SYNTHETIC_FAKE_ARTIFACT_BYTES");
    })(),
  }));
  const recoverUnknown = vi.fn(async () => ({
    reference: artifactReference,
    durableReceipt: receipt,
  }));
  const materialize = vi.fn(async (input: AsyncIterable<Uint8Array>) => {
    if (options.materializerFails)
      throw new Error("synthetic_key_or_body_unavailable");
    for await (const chunk of input) {
      void chunk;
    }
    return { email: "PII_DO_NOT_RETURN" };
  });
  const deps: EnrichmentResultReaderDeps = {
    loadBinding: vi.fn(async () => binding),
    budgets: options.missingReader
      ? {}
      : {
          readOperationResult: readOperation as NonNullable<
            EnrichmentResultReaderDeps["budgets"]["readOperationResult"]
          >,
        },
    projections,
    artifacts: { readVerified, recoverUnknown },
    finderMaterializer: {
      resultSchema: artifactReference.resultSchema,
      materialize,
    },
    now: () => new Date("2026-11-22T00:00:00.000Z"),
  };
  return {
    reader: new EnrichmentResultReader(deps),
    deps,
    binding,
    receipt,
    projection,
    artifactReference,
    readOperation,
    readVerified,
    recoverUnknown,
    materialize,
    consumed: () => consumed,
    context: { workspaceId: W, companyId: C },
  };
}
describe("original-result reader pure/fake ports, not SQL provenance or object-store proof", () => {
  it("queries only the frozen typed account/generation/key/schema and returns no raw vote body", async () => {
    const x = world();
    const result = await x.reader.loadEnrichmentStepResult(STEP, x.context);
    expect(result.status).toBe("SETTLED");
    expect(x.readOperation).toHaveBeenCalledWith({
      scopeKey: W,
      authorityId: A,
      accountKey: "frozen-actual-account-key",
      accountGeneration: 1,
      operationKey: "original-op-key",
      resultSchema: "contact-email-verify-millionverifier/v1",
    });
    expect(x.readVerified).not.toHaveBeenCalled();
    expect(x.recoverUnknown).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PII_DO_NOT_RETURN");
  });
  it("does not require an account to remain open or unexpired for cold typed read", async () => {
    const x = world();
    Object.assign(x.binding.currentAccount!, {
      open: false,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
    ).toBe("SETTLED");
  });
  it.each([
    "RESERVED",
    "RELEASED",
    "RESULT_UNKNOWN",
    "SETTLED_NO_RESULT",
    "NOT_FOUND",
  ] as const)(
    "holds known original operation with read status %s without recovery or execute",
    async (budgetStatus) => {
      const x = world({ budgetStatus });
      expect(
        (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
      ).toBe("PENDING");
      expect(x.recoverUnknown).not.toHaveBeenCalled();
      expect(x.readVerified).not.toHaveBeenCalled();
    },
  );
  it("holds without an installed optional typed read port", async () => {
    const x = world({ missingReader: true });
    expect(
      (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
    ).toBe("UNAVAILABLE");
  });
  it.each([{ accountGeneration: 2 }, { accountAuthority: C }])(
    "does not replace frozen identity with the current account or generic fallback %#",
    async (options) => {
      const x = world(options);
      expect(
        (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
      ).toBe("UNAVAILABLE");
      expect(x.readOperation).not.toHaveBeenCalled();
      expect(x.readVerified).not.toHaveBeenCalled();
    },
  );
  it.each([
    { receipt: { accountId: C } },
    { receipt: { operationId: ART } },
    { receipt: { operationKey: "other-key" } },
    { receipt: { resultSchema: "http-get/v1" } },
    { digest: "b".repeat(64) },
  ])("holds mismatched original typed facts %#", async (options) => {
    const x = world(options);
    expect(
      (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
    ).toBe("UNAVAILABLE");
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
  it("uses original artifact readVerified and materializer, never typed lookup for finder", async () => {
    const x = world({ finder: true });
    const result = await x.reader.loadEnrichmentStepResult(STEP, x.context);
    expect(result.status).toBe("SETTLED");
    expect(x.readOperation).not.toHaveBeenCalled();
    expect(x.readVerified).toHaveBeenCalledWith({
      scopeKind: "workspace",
      workspaceId: W,
      authorityId: A,
      reference: x.artifactReference,
    });
    expect(x.materialize).toHaveBeenCalledTimes(1);
    expect(x.consumed()).toBe(1);
    expect(JSON.stringify(result)).not.toContain(
      "FAKE_OBJECT_KEY_NOT_RETURNED",
    );
    expect(JSON.stringify(result)).not.toContain("PII_DO_NOT_RETURN");
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
  it.each([
    { finder: true, materializerFails: true },
    { finder: true, artifactExpired: true },
  ])(
    "holds unreadable/expired artifact without implicit recovery %#",
    async (options) => {
      const x = world(options);
      expect(
        (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
      ).toBe("UNAVAILABLE");
      expect(x.recoverUnknown).not.toHaveBeenCalled();
      expect(x.readOperation).not.toHaveBeenCalled();
    },
  );
  it("keeps GET-style read of original UNKNOWN pure and does not recover it", async () => {
    const x = world({ finder: true, unknown: true });
    expect(
      (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
    ).toBe("PENDING");
    expect(x.recoverUnknown).not.toHaveBeenCalled();
    expect(x.readOperation).not.toHaveBeenCalled();
  });
  it("recovers only an explicitly authorized original reservation using the actual existing service signature", async () => {
    const x = world({ finder: true, unknown: true });
    const result = await x.reader.recoverEnrichmentStepResult(
      STEP,
      x.context,
      async () => true,
    );
    expect(result.status).toBe("SETTLED");
    expect(x.recoverUnknown).toHaveBeenCalledWith({
      reservation: x.binding.originalReservation,
      authorityId: A,
      observedMicrousd: 1780n,
      subjectRef: { subjectType: "contact", subjectId: CONTACT },
    });
    expect(x.readOperation).not.toHaveBeenCalled();
  });
  it("does not call recovery after a write/current-subject authorization denial", async () => {
    const x = world({ finder: true, unknown: true });
    expect(
      (
        await x.reader.recoverEnrichmentStepResult(
          STEP,
          x.context,
          async () => false,
        )
      ).status,
    ).toBe("UNAVAILABLE");
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
  it("does not resurrect redacted or foreign company metadata", async () => {
    const x = world({ finder: true, redacted: true });
    expect(
      (await x.reader.loadEnrichmentStepResult(STEP, x.context)).status,
    ).toBe("UNAVAILABLE");
    expect(
      (
        await x.reader.loadEnrichmentStepResult(STEP, {
          ...x.context,
          companyId: ART,
        })
      ).status,
    ).toBe("UNAVAILABLE");
    expect(x.readVerified).not.toHaveBeenCalled();
    expect(x.readOperation).not.toHaveBeenCalled();
  });
});

describe("original SMTP typed projection cold-read port for the internal protocol proxy", () => {
  it("returns the original closed zero-cost protocol result and receipt without another invoke", async () => {
    const x = world({ smtp: true });
    expect(await x.reader.loadOriginalSmtpResult(STEP, x.context)).toEqual({
      data: { reachable: true, mailFromCode: 250, codes: [250, 550] },
      costCents: 0,
      durableReceipt: x.receipt,
    });
    expect(x.readOperation).toHaveBeenCalledExactlyOnceWith({
      scopeKey: W,
      authorityId: A,
      accountKey: x.binding.step.accountKey,
      accountGeneration: 1,
      operationKey: x.binding.step.operationKey,
      resultSchema: "smtp-probe-verdict/v1",
    });
    expect(x.readVerified).not.toHaveBeenCalled();
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
  it("does not add an open/unexpired-account requirement to old settled protocol reads", async () => {
    const x = world({ smtp: true });
    Object.assign(x.binding.currentAccount!, {
      open: false,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      await x.reader.loadOriginalSmtpResult(STEP, x.context),
    ).not.toBeNull();
    expect(x.readOperation).toHaveBeenCalledTimes(1);
  });
  it.each([
    "NOT_FOUND",
    "RESERVED",
    "RELEASED",
    "RESULT_UNKNOWN",
    "SETTLED_NO_RESULT",
  ] as const)(
    "does not invent a protocol result for %s",
    async (budgetStatus) => {
      const x = world({ smtp: true, budgetStatus });
      expect(await x.reader.loadOriginalSmtpResult(STEP, x.context)).toBeNull();
      expect(x.recoverUnknown).not.toHaveBeenCalled();
    },
  );
  it("rejects another current generation without replacing the frozen query", async () => {
    const x = world({ smtp: true, accountGeneration: 2 });
    expect(await x.reader.loadOriginalSmtpResult(STEP, x.context)).toBeNull();
    expect(x.readOperation).not.toHaveBeenCalled();
  });
  it("does not read across a caller company boundary", async () => {
    const x = world({ smtp: true });
    expect(
      await x.reader.loadOriginalSmtpResult(STEP, {
        ...x.context,
        companyId: W,
      }),
    ).toBeNull();
    expect(x.readOperation).not.toHaveBeenCalled();
  });
  it("never treats a finder or new HTTP verification result as the original SMTP codec", async () => {
    const x = world();
    expect(await x.reader.loadOriginalSmtpResult(STEP, x.context)).toBeNull();
    expect(x.readOperation).not.toHaveBeenCalled();
  });
  it("holds a receipt/projection digest conflict without recovery", async () => {
    const x = world({ smtp: true, receipt: { resultDigest: "f".repeat(64) } });
    expect(await x.reader.loadOriginalSmtpResult(STEP, x.context)).toBeNull();
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
});

describe("controlled scoped original-ledger binding SELECT port, NOT PostgreSQL proof", () => {
  function bindingWorld(
    options: {
      typed?: boolean;
      missingOperation?: boolean;
      operationStatus?: string;
      patch?: Record<string, unknown>;
      missing?: boolean;
      duplicate?: boolean;
    } = {},
  ) {
    const x = world({ finder: !options.typed });
    const b = x.binding,
      step = b.step;
    const candidateRef = {
      operationId: ART,
      resultDigest: "b".repeat(64),
      artifactRef: {
        ...x.artifactReference,
        operationId: ART,
        artifactId: "00000000-0000-4000-8000-000000000010",
        sha256: "b".repeat(64),
      },
    };
    const row = {
      id: STEP,
      workspace_id: W,
      company_id: C,
      execution_id: EXEC,
      contact_id: CONTACT,
      contact_ordinal: 0,
      slot_key: step.slotKey,
      phase: step.phase,
      provider: step.provider,
      tool_id: step.toolId,
      tool_version: step.toolVersion,
      quote_microusd: 1780n,
      pricing_version: step.pricingVersion,
      depends_on_slot_key: step.dependsOnSlotKey,
      input_fingerprint: step.inputFingerprint,
      operation_key: step.operationKey,
      budget_operation_id: options.missingOperation ? null : OP,
      candidate_ref: options.typed ? candidateRef : null,
      revision: 3,
      dispatch_phase: options.missingOperation
        ? "ADMITTED"
        : "SETTLED_WAITING_APPLY",
      domain_state: "PENDING",
      authority_id: A,
      account_id: ACCOUNT,
      generation: 1,
      account_key: step.accountKey,
      execution_status: "COMPLETED",
      deadline_open: false,
      current_account_id: ACCOUNT,
      current_authority_id: A,
      current_generation: 1,
      original_operation_id: options.missingOperation ? null : OP,
      original_scope_key: W,
      original_account_id: ACCOUNT,
      original_generation: 1,
      original_operation_key: step.operationKey,
      ledger_status: options.operationStatus ?? "SETTLED",
      amount_unit: "microusd",
      reserved_microusd: 1780n,
      result_schema_version: options.typed
        ? "generic-operation-projection/v1"
        : "generic-operation-artifact-ref/v1",
      result_schema: x.receipt.resultSchema,
      result_digest: x.receipt.resultDigest,
      result_json: options.typed ? x.projection : x.artifactReference,
      receipt_usage: x.receipt.usage,
      receipt_cost_basis: x.receipt.costBasis,
      ...(options.missingOperation
        ? {
            original_scope_key: null,
            original_account_id: null,
            original_generation: null,
            original_operation_key: null,
            ledger_status: null,
            amount_unit: null,
            reserved_microusd: null,
            result_schema_version: null,
            result_schema: null,
            result_digest: null,
            result_json: null,
            receipt_usage: null,
            receipt_cost_basis: null,
          }
        : {}),
      ...options.patch,
    };
    const statements: string[] = [],
      parameters: unknown[][] = [];
    const query = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(strings.join("?"));
        parameters.push(values);
        return options.missing ? [] : options.duplicate ? [row, row] : [row];
      },
    );
    const transactions = {
      withWorkspace: vi.fn(
        async (_workspace: string, fn: (tx: unknown) => Promise<unknown>) =>
          fn({ $queryRaw: query }),
      ),
    };
    const repository = new EnrichmentOriginalResultRepository(
      transactions as never,
    );
    return {
      ...x,
      repository,
      row,
      query,
      transactions,
      statements,
      parameters,
    };
  }
  it("binds the original finder artifact/receipt through one scoped SELECT without imposing a fresh deadline", async () => {
    const x = bindingWorld();
    const result = await x.repository.loadBinding(STEP, x.context);
    expect(result?.step.stepId).toBe(STEP);
    expect(result?.ledgerStatus).toBe("SETTLED");
    expect(result?.artifactReference).toEqual(x.artifactReference);
    expect(result?.originalReceipt).toEqual(x.receipt);
    expect(x.transactions.withWorkspace).toHaveBeenCalledTimes(1);
    expect(x.query).toHaveBeenCalledTimes(1);
    expect(x.parameters[0]).toEqual(expect.arrayContaining([W, C, STEP]));
    expect(x.statements[0]).toContain("contact_enrichment_execution_step");
    expect(x.statements[0]).toContain("tool_budget_operation");
    expect(x.statements.join(" ")).not.toMatch(
      /INSERT INTO|UPDATE public|DELETE FROM|FOR UPDATE/,
    );
  });
  it("binds original typed metadata without returning its provider payload in the reference", async () => {
    const x = bindingWorld({ typed: true });
    const result = await x.repository.loadBinding(STEP, x.context);
    expect(result?.originalOperationId).toBe(OP);
    expect(result?.expectedResultDigest).toBe(x.receipt.resultDigest);
    expect(result?.artifactReference).toBeNull();
    expect(result?.originalReservation?.estimatedMicrousd).toBe(1780n);
    expect(
      JSON.stringify(result, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("provider_verdict");
  });
  it("returns NOT_FOUND only when neither original operation nor step operation link exists", async () => {
    const x = bindingWorld({ missingOperation: true });
    const result = await x.repository.loadBinding(STEP, x.context);
    expect(result?.ledgerStatus).toBe("NOT_FOUND");
    expect(result?.originalOperationId).toBeNull();
    expect(result?.originalReservation).toBeNull();
  });
  it("retains a reserved original operation as pending instead of authorizing a new purchase", async () => {
    const x = bindingWorld({
      operationStatus: "RESERVED",
      patch: {
        result_schema_version: null,
        result_schema: null,
        result_digest: null,
        result_json: null,
        receipt_usage: null,
        receipt_cost_basis: null,
      },
    });
    expect(
      (await x.repository.loadBinding(STEP, x.context))?.ledgerStatus,
    ).toBe("RESERVED");
  });
  it.each([
    { workspace_id: C },
    { company_id: W },
    { id: C },
    { original_scope_key: C },
    { original_account_id: C },
    { original_generation: 2 },
    { original_operation_key: "another-key" },
    { budget_operation_id: ART },
    { amount_unit: "cent" },
    { reserved_microusd: 1700n },
    { result_schema: "http-get/v1" },
    { result_digest: "f".repeat(64) },
    { candidate_ref: { address: "PII_SENTINEL" } },
  ])("refuses ambiguous or mismatched original binding %#", async (patch) => {
    const x = bindingWorld({ patch });
    expect(await x.repository.loadBinding(STEP, x.context)).toBeNull();
  });
  it("does not turn a missing original operation behind a non-null step link into NOT_FOUND", async () => {
    const x = bindingWorld({
      missingOperation: true,
      patch: { budget_operation_id: OP },
    });
    expect(await x.repository.loadBinding(STEP, x.context)).toBeNull();
  });
  it("does not expose duplicate or redacted rows", async () => {
    for (const x of [
      bindingWorld({ duplicate: true }),
      bindingWorld({ missing: true }),
      bindingWorld({
        patch: { contact_id: null, execution_status: "REDACTED" },
      }),
    ])
      expect(await x.repository.loadBinding(STEP, x.context)).toBeNull();
  });
});

describe("domain-internal original-result materialization, not public GET output", () => {
  const finderPayload = {
    status: "hit",
    email: "person@company.example.invalid",
    providerConfidence: 90,
    acceptAll: false,
    pattern: null,
    reason: "candidate_found",
  };
  it("materializes only the verified original finder body for authorized transient domain use", async () => {
    const x = world({ finder: true });
    x.materialize.mockImplementation(async (input) => {
      for await (const chunk of input) void chunk;
      return finderPayload as never;
    });
    const result = await x.reader.materializeForDomain(STEP, x.context);
    expect(result?.phase).toBe("FINDER");
    expect(result?.result).toEqual(finderPayload);
    expect(result?.reference.durableReceipt).toEqual(x.receipt);
    expect(x.readOperation).not.toHaveBeenCalled();
    expect(x.recoverUnknown).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await x.reader.loadEnrichmentStepResult(STEP, x.context)),
    ).not.toContain(finderPayload.email);
  });
  it("restores original exact-micro vote evidence rather than replay-zero or an invented final verdict", async () => {
    const x = world();
    const result = await x.reader.materializeForDomain(STEP, x.context);
    expect(result?.phase).toBe("VERIFY");
    expect(result?.result).toMatchObject({
      data: {
        providerKey: "millionverifier",
        state: "VALID",
        reason: "provider_verdict",
      },
      costMicrousd: "1780",
      costCents: 0.178,
    });
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
  it("materializes only the original SMTP codec and receipt without executing its protocol", async () => {
    const x = world({ smtp: true });
    const result = await x.reader.materializeForDomain(STEP, x.context);
    expect(result?.phase).toBe("SMTP");
    expect(result?.result).toEqual({
      data: { reachable: true, mailFromCode: 250, codes: [250, 550] },
      costCents: 0,
      durableReceipt: x.receipt,
    });
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
  it("never recovers or buys an unknown/unavailable original result while materializing", async () => {
    for (const x of [
      world({ finder: true, unknown: true }),
      world({ budgetStatus: "RESULT_UNKNOWN" }),
      world({ accountGeneration: 2 }),
      world({ redacted: true }),
    ]) {
      expect(await x.reader.materializeForDomain(STEP, x.context)).toBeNull();
      expect(x.recoverUnknown).not.toHaveBeenCalled();
    }
  });
  it("does not promote arbitrary materializer output into an application candidate", async () => {
    const x = world({ finder: true });
    expect(await x.reader.materializeForDomain(STEP, x.context)).toBeNull();
    expect(x.recoverUnknown).not.toHaveBeenCalled();
  });
});
