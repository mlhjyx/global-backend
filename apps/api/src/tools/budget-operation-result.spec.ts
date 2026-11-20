import { describe, expect, it } from "vitest";
import {
  readBudgetOperationResult,
  type BudgetOperationResultQuery,
} from "./budget-operation-result";
import { projectModelResultForReplay } from "../durable-results/model-result-replay";
const W = "11111111-1111-4111-8111-111111111111",
  A = "22222222-2222-4222-8222-222222222222",
  C = "33333333-3333-4333-8333-333333333333",
  O = "44444444-4444-4444-8444-444444444444";
const query: BudgetOperationResultQuery = {
  scopeKey: W,
  authorityId: A,
  accountKey: "generation-account",
  accountGeneration: 1,
  operationKey: "a".repeat(64),
  resultSchema: "market-candidates-generation/v1",
};
const projection = projectModelResultForReplay(
  "market-candidates-generation/v1",
  {
    data: { outcome: "COMPLETED_EMPTY", candidates: [] },
    provider: "synthetic",
    model: "synthetic",
  },
);
const usage = {
  currency: "USD",
  unit: "microusd",
  callCount: 1,
  chargedMicrousd: "10000",
  upperBoundMicrousd: "30000",
};
const account = () => ({
  scope_key: W,
  account_key: query.accountKey,
  account_id: C,
  authority_id: A,
  generation: 1,
});
const operation = () => ({
  scope_key: W,
  account_id: C,
  generation: 1,
  operation_id: O,
  operation_key: query.operationKey,
  status: "SETTLED",
  result_schema_version: projection.schemaVersion,
  result_schema: projection.schema,
  result_digest: projection.digest,
  result_json: projection,
  receipt_usage: usage,
  receipt_cost_basis: "provider_reported",
});
function tx(rows: unknown[][]) {
  const queue = [...rows],
    queries: Array<{ text: string; values: readonly unknown[] }> = [];
  return {
    queries,
    client: {
      $queryRaw: async (
        strings: TemplateStringsArray,
        ...values: readonly unknown[]
      ) => {
        queries.push({ text: strings.join("?"), values });
        return queue.shift() ?? [];
      },
    },
  };
}

describe("readBudgetOperationResult is a tuple-bound SELECT capability, never a replay dispatch", () => {
  it("reads the exact SETTLED projection with its one existing trusted ledger receipt", async () => {
    const executor = tx([[account()], [operation()]]);
    const value = await readBudgetOperationResult(
      executor.client as never,
      query,
    );
    expect(value).toEqual({
      status: "SETTLED",
      projection,
      receipt: {
        schemaVersion: "durable-execution-receipt/v1",
        scopeKey: W,
        authorityId: A,
        accountId: C,
        operationId: O,
        operationKey: query.operationKey,
        resultStrategy: "typed_projection",
        resultSchema: projection.schema,
        resultDigest: projection.digest,
        artifactId: null,
        usage,
        costBasis: "provider_reported",
        status: "SETTLED",
      },
    });
    expect(executor.queries).toHaveLength(2);
    for (const emitted of executor.queries) {
      expect(emitted.text.trim()).toMatch(/^SELECT\b/iu);
      expect(emitted.text).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|FOR UPDATE)\b|reserve_tool|open_tool|attest_authorized|settle_tool/iu,
      );
    }
    expect(executor.queries[0].values).toContain(W);
    expect(executor.queries[0].values).toContain(query.accountKey);
    expect(executor.queries[1].values).toContain(query.operationKey);
    expect(executor.queries[1].values).toContain(query.accountGeneration);
  });
  it.each(["RESERVED", "RELEASED", "RESULT_UNKNOWN"] as const)(
    "returns only known status %s and no payload",
    async (status) => {
      const executor = tx([[account()], [{ ...operation(), status }]]);
      expect(
        await readBudgetOperationResult(executor.client as never, query),
      ).toEqual({ status });
    },
  );
  it("distinguishes a missing account and missing operation without scanning other accounts", async () => {
    const absent = tx([]);
    expect(
      await readBudgetOperationResult(absent.client as never, query),
    ).toEqual({ status: "NOT_FOUND" });
    expect(absent.queries).toHaveLength(1);
    const missing = tx([[account()], []]);
    expect(
      await readBudgetOperationResult(missing.client as never, query),
    ).toEqual({ status: "NOT_FOUND" });
    expect(missing.queries).toHaveLength(2);
  });
  it.each([
    { authority_id: O },
    { generation: 2 },
    { account_key: "other" },
    { scope_key: A },
  ])(
    "rejects an account tuple mismatch %# before loading a result",
    async (change) => {
      const executor = tx([[{ ...account(), ...change }], [operation()]]);
      await expect(
        readBudgetOperationResult(executor.client as never, query),
      ).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");
      expect(executor.queries).toHaveLength(1);
    },
  );
  it.each([
    { account_id: O },
    { generation: 2 },
    { operation_key: "other" },
    { scope_key: A },
    { result_schema: "taxonomy-code/v1" },
    { result_digest: "f".repeat(64) },
    { result_json: null },
    { receipt_usage: null },
    { receipt_cost_basis: "unknown" },
  ])(
    "rejects malformed/mismatched settled row %# rather than claiming success",
    async (change) => {
      const executor = tx([[account()], [{ ...operation(), ...change }]]);
      await expect(
        readBudgetOperationResult(executor.client as never, query),
      ).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");
    },
  );
  it.each([
    { scopeKey: "platform" },
    { scopeKey: "not-uuid" },
    { authorityId: "bad" },
    { accountGeneration: 0 },
    { accountGeneration: 1.5 },
    { operationKey: "" },
    { resultSchema: "made-up/v1" },
  ])(
    "fails closed on query %# before selecting any tenant data",
    async (change) => {
      const executor = tx([[account()], [operation()]]);
      await expect(
        readBudgetOperationResult(
          executor.client as never,
          { ...query, ...change } as BudgetOperationResultQuery,
        ),
      ).rejects.toThrow();
      expect(executor.queries).toHaveLength(0);
    },
  );
  it("rejects ambiguous rows and does not substitute the first visible identity", async () => {
    const executor = tx([[account(), account()], [operation()]]);
    await expect(
      readBudgetOperationResult(executor.client as never, query),
    ).rejects.toThrow();
  });
});
