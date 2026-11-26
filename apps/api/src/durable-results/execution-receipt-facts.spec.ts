import { describe, expect, it } from "vitest";
import {
  RECEIPT_FACT_MODEL_TASK_IDS,
  RECEIPT_FACT_TOOL_IDS,
  artifactExecutionReceiptFacts,
  modelExecutionReceiptFacts,
  toolExecutionReceiptFacts,
} from "./execution-receipt-facts";

const CONTACT_RECEIPT_TOOL_IDS = [
  "contact_email.find.hunter",
  "contact_email.find.prospeo",
  "contact_email.verify.millionverifier",
  "contact_email.verify.emailable",
  "contact_email.verify.zerobounce",
] as const;
const toolResult = (data: unknown, costCents = 2) => ({ data, costCents });
const modelResult = (overrides: Record<string, unknown> = {}) => ({
  data: { ok: true },
  provider: "test",
  model: "test-model",
  ...overrides,
});

describe("execution receipt fact producers", () => {
  it("locks explicit fact producers to 20 legacy plus five controlled contact Tools and 11 Model tasks", () => {
    expect(RECEIPT_FACT_TOOL_IDS).toHaveLength(25);
    expect(
      RECEIPT_FACT_TOOL_IDS.filter(
        (id) => !CONTACT_RECEIPT_TOOL_IDS.some((contactId) => contactId === id),
      ),
    ).toHaveLength(20);
    expect(RECEIPT_FACT_MODEL_TASK_IDS).toHaveLength(11);
    expect(new Set(RECEIPT_FACT_TOOL_IDS).size).toBe(25);
    expect(new Set(RECEIPT_FACT_MODEL_TASK_IDS).size).toBe(11);
  });

  it.each(
    RECEIPT_FACT_TOOL_IDS.filter(
      (id) =>
        id !== "google_patents.search" &&
        !CONTACT_RECEIPT_TOOL_IDS.some((contactId) => contactId === id),
    ),
  )(
    "uses an explicit declared upper bound for %s without inferring cost from result cents",
    (toolId) => {
      expect(
        toolExecutionReceiptFacts({
          toolId,
          resultSchema: "searxng-search/v1",
          result: toolResult({ ok: true }, 999),
          reservedMicrousd: 20_000n,
          chargedMicrousd: 999_0000n,
        }),
      ).toEqual({
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount: 1,
          upperBoundMicrousd: "20000",
        },
        costBasis: "estimated_upper_bound",
      });
    },
  );

  it.each([
    {
      costFacts: {
        costBasis: "not_incurred",
        maximumBytesBilled: "0",
        observedBytesBilled: null,
        maxRows: 0,
      },
      expected: {
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount: 0,
          chargedMicrousd: "0",
          upperBoundMicrousd: "0",
        },
        costBasis: "not_incurred",
      },
    },
    {
      costFacts: {
        costBasis: "provider_reported",
        maximumBytesBilled: "1000",
        observedBytesBilled: "512",
        maxRows: 50,
      },
      expected: {
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount: 1,
          bytesBilled: "512",
          maximumBytesBilled: "1000",
          chargedMicrousd: "12000",
          upperBoundMicrousd: "20000",
        },
        costBasis: "provider_reported",
      },
    },
    {
      costFacts: {
        costBasis: "estimated_upper_bound",
        maximumBytesBilled: "1000",
        observedBytesBilled: null,
        maxRows: 50,
      },
      expected: {
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount: 1,
          maximumBytesBilled: "1000",
          upperBoundMicrousd: "20000",
        },
        costBasis: "estimated_upper_bound",
      },
    },
  ])(
    "preserves canonical Patent $costFacts.costBasis facts",
    ({ costFacts, expected }) => {
      expect(
        toolExecutionReceiptFacts({
          toolId: "google_patents.search",
          resultSchema: "google-patents-search/v1",
          result: toolResult({ patents: [], costFacts }),
          reservedMicrousd: 20_000n,
          chargedMicrousd: 12_000n,
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    {
      costBasis: "provider_reported",
      maximumBytesBilled: "100",
      observedBytesBilled: null,
      maxRows: 50,
    },
    {
      costBasis: "estimated_upper_bound",
      maximumBytesBilled: "100",
      observedBytesBilled: "1",
      maxRows: 50,
    },
    {
      costBasis: "not_incurred",
      maximumBytesBilled: "1",
      observedBytesBilled: null,
      maxRows: 0,
    },
    {
      costBasis: "provider_reported",
      maximumBytesBilled: "100",
      observedBytesBilled: "101",
      maxRows: 50,
    },
  ])("rejects contradictory Patent cost facts %#", (costFacts) => {
    expect(() =>
      toolExecutionReceiptFacts({
        toolId: "google_patents.search",
        resultSchema: "google-patents-search/v1",
        result: toolResult({ patents: [], costFacts }),
        reservedMicrousd: 20_000n,
        chargedMicrousd: 12_000n,
      }),
    ).toThrow("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
  });

  it("keeps Model charged amount and provenance on the same provider/token/fallback branch", () => {
    expect(
      modelExecutionReceiptFacts({
        taskId: "taxonomy.normalize",
        resultSchema: "taxonomy-code/v1",
        result: modelResult({
          usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.0125 },
          callCount: 1,
        }),
        reservedMicrousd: 40_000n,
        chargedMicrousd: 12_500n,
      }),
    ).toEqual({
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount: 1,
        inputTokens: 7,
        outputTokens: 3,
        chargedMicrousd: "12500",
        upperBoundMicrousd: "40000",
      },
      costBasis: "provider_reported",
    });
    expect(
      modelExecutionReceiptFacts({
        taskId: "taxonomy.normalize",
        resultSchema: "taxonomy-code/v1",
        result: modelResult({ usage: { outputTokens: 3 }, callCount: 1 }),
        reservedMicrousd: 40_000n,
        chargedMicrousd: 10_000n,
      }),
    ).toEqual({
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount: 1,
        outputTokens: 3,
        chargedMicrousd: "10000",
        upperBoundMicrousd: "40000",
      },
      costBasis: "token_pricing",
    });
    expect(
      modelExecutionReceiptFacts({
        taskId: "taxonomy.normalize",
        resultSchema: "taxonomy-code/v1",
        result: modelResult({ callCount: 2 }),
        reservedMicrousd: 40_000n,
        chargedMicrousd: 20_000n,
      }),
    ).toEqual({
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount: 2,
        upperBoundMicrousd: "40000",
      },
      costBasis: "estimated_upper_bound",
    });
  });

  it("produces artifact-reference upper-bound facts without payload data", () => {
    expect(
      artifactExecutionReceiptFacts({
        resultSchema: "http-get/v1",
        reservedMicrousd: 30_000n,
      }),
    ).toEqual({
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount: 1,
        upperBoundMicrousd: "30000",
      },
      costBasis: "estimated_upper_bound",
    });
  });
});

const contactReceiptProtocols = [
  ["contact_email.find.hunter", "contact-email-find-hunter/v1"],
  ["contact_email.find.prospeo", "contact-email-find-prospeo/v1"],
  [
    "contact_email.verify.millionverifier",
    "contact-email-verify-millionverifier/v1",
  ],
  ["contact_email.verify.emailable", "contact-email-verify-emailable/v1"],
  ["contact_email.verify.zerobounce", "contact-email-verify-zerobounce/v1"],
] as const;
describe("controlled contact receipt facts remain canonical micro upper bounds, never an invoice", () => {
  for (const [toolId, resultSchema] of contactReceiptProtocols) {
    it("explicitly registers " + toolId, () =>
      expect(RECEIPT_FACT_TOOL_IDS).toContain(toolId),
    );
    it.each(["1780", "1700"])(
      "preserves " + toolId + " micro %s without serializing provider data",
      (micro) => {
        const facts = toolExecutionReceiptFacts({
          toolId,
          resultSchema,
          result: {
            data: { sentinel: "PII_DO_NOT_PERSIST" },
            costCents: Number(BigInt(micro)) / 10000,
            costMicrousd: micro,
          },
          reservedMicrousd: BigInt(micro),
          chargedMicrousd: BigInt(micro),
        });
        expect(facts).toEqual({
          usage: {
            currency: "USD",
            unit: "microusd",
            callCount: 1,
            upperBoundMicrousd: micro,
          },
          costBasis: "estimated_upper_bound",
        });
        expect(JSON.stringify(facts)).not.toContain("PII_DO_NOT_PERSIST");
      },
    );
    it.each(["", "01", "1e3", null, undefined, 1700])(
      "rejects invalid explicit micro for " + toolId + " %#",
      (micro) =>
        expect(() =>
          toolExecutionReceiptFacts({
            toolId,
            resultSchema,
            result: { data: {}, costCents: 0.17, costMicrousd: micro as never },
            reservedMicrousd: 1700n,
            chargedMicrousd: 1700n,
          }),
        ).toThrow("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID"),
    );
    it(
      "does not let " + toolId + " fall back to legacy cents or another schema",
      () => {
        expect(() =>
          toolExecutionReceiptFacts({
            toolId,
            resultSchema,
            result: toolResult({}, 0),
            reservedMicrousd: 1700n,
            chargedMicrousd: 1700n,
          }),
        ).toThrow("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
        expect(() =>
          toolExecutionReceiptFacts({
            toolId,
            resultSchema: "searxng-search/v1",
            result: { data: {}, costCents: 0.17, costMicrousd: "1700" },
            reservedMicrousd: 1700n,
            chargedMicrousd: 1700n,
          }),
        ).toThrow("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
      },
    );
    it("rejects " + toolId + " quote/shadow/ledger contradictions", () => {
      const base = {
        toolId,
        resultSchema,
        result: { data: {}, costCents: 0.17, costMicrousd: "1700" },
        reservedMicrousd: 1700n,
        chargedMicrousd: 1700n,
      };
      expect(() =>
        toolExecutionReceiptFacts({ ...base, reservedMicrousd: 1780n }),
      ).toThrow("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
      expect(() =>
        toolExecutionReceiptFacts({
          ...base,
          result: { ...base.result, costCents: 0 },
        }),
      ).toThrow("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
      expect(() =>
        toolExecutionReceiptFacts({ ...base, chargedMicrousd: 1701n }),
      ).toThrow("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
    });
  }
});
