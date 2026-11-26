import { observedToolMicrousd } from "../tools/tool-cost-microusd";
import { assertMicrousd } from "../tools/microusd";
import type { ModelResult } from "../model-gateway/types";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { ToolResult } from "../tools/tool-contract";
import {
  parseDurableExecutionReceiptFacts,
  type DurableExecutionReceiptFacts,
} from "./durable-execution-receipt";

export const RECEIPT_FACT_TOOL_IDS = Object.freeze([
  "searxng.search",
  "crawl4ai.fetch",
  "wikidata.sparql",
  "osm.overpass",
  "smtp.rcpt_probe",
  "crawl4ai.render",
  "http.get",
  "wikidata.entity",
  "gleif.fetch",
  "vies.check",
  "ted.search",
  "openfda.search",
  "opencorporates.search",
  "companies_house.search",
  "inpi_rne.search",
  "google_patents.search",
  "tradefair.algolia",
  "mapyourshow.fetch",
  "samgov.search",
  "sanctions.download",
  "contact_email.find.hunter",
  "contact_email.find.prospeo",
  "contact_email.verify.millionverifier",
  "contact_email.verify.emailable",
  "contact_email.verify.zerobounce",
] as const);

export const RECEIPT_FACT_MODEL_TASK_IDS = Object.freeze([
  "company_understanding.extract_claims",
  "company_understanding.extract_profile",
  "company_understanding.extract_offerings",
  "icp.design",
  "discovery.query_plan",
  "taxonomy.normalize",
  "discovery.qualify_fit",
  "discovery.extract_company",
  "discovery.extract_list",
  "contact.find_decision_makers",
  "discovery.classify_trade_role",
] as const);

type PatentCostBasis =
  "not_incurred" | "provider_reported" | "estimated_upper_bound";

interface PatentCostFacts {
  readonly costBasis: PatentCostBasis;
  readonly maximumBytesBilled: string;
  readonly observedBytesBilled: string | null;
  readonly maxRows: number;
}

const DECIMAL = /^(0|[1-9][0-9]{0,39})$/u;

function microusd(value: bigint): string {
  if (value < 0n)
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
  return value.toString();
}

function patentCostFacts(result: ToolResult<unknown>): PatentCostFacts {
  const data = result.data as { readonly costFacts?: unknown };
  const value = data?.costFacts;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "costBasis,maxRows,maximumBytesBilled,observedBytesBilled"
  ) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
  }
  const basis = record.costBasis;
  const maximum = record.maximumBytesBilled;
  const observed = record.observedBytesBilled;
  const maxRows = record.maxRows;
  if (
    !["not_incurred", "provider_reported", "estimated_upper_bound"].includes(
      String(basis),
    ) ||
    typeof maximum !== "string" ||
    !DECIMAL.test(maximum) ||
    !(
      observed === null ||
      (typeof observed === "string" && DECIMAL.test(observed))
    ) ||
    !Number.isSafeInteger(maxRows) ||
    (maxRows as number) < 0 ||
    (maxRows as number) > 50 ||
    (observed !== null && BigInt(observed) > BigInt(maximum))
  ) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
  }
  if (
    (basis === "not_incurred" &&
      (maximum !== "0" || observed !== null || maxRows !== 0)) ||
    (basis === "provider_reported" && observed === null) ||
    (basis === "estimated_upper_bound" && observed !== null)
  ) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
  }
  return Object.freeze({
    costBasis: basis as PatentCostBasis,
    maximumBytesBilled: maximum,
    observedBytesBilled: observed,
    maxRows: maxRows as number,
  });
}

const CONTROLLED_CONTACT_RECEIPT_SCHEMAS = Object.freeze({
  "contact_email.find.hunter": "contact-email-find-hunter/v1",
  "contact_email.find.prospeo": "contact-email-find-prospeo/v1",
  "contact_email.verify.millionverifier":
    "contact-email-verify-millionverifier/v1",
  "contact_email.verify.emailable": "contact-email-verify-emailable/v1",
  "contact_email.verify.zerobounce": "contact-email-verify-zerobounce/v1",
} as const);
function controlledContactReceiptFacts(input: {
  toolId: string;
  resultSchema: string;
  result: ToolResult<unknown>;
  reservedMicrousd: bigint;
  chargedMicrousd: bigint;
}): DurableExecutionReceiptFacts {
  try {
    const expected =
      CONTROLLED_CONTACT_RECEIPT_SCHEMAS[
        input.toolId as keyof typeof CONTROLLED_CONTACT_RECEIPT_SCHEMAS
      ];
    const exact = Object.getOwnPropertyDescriptor(input.result, "costMicrousd");
    const shadow = Object.getOwnPropertyDescriptor(input.result, "costCents");
    if (
      !expected ||
      input.resultSchema !== expected ||
      !exact?.enumerable ||
      !Object.hasOwn(exact, "value") ||
      typeof exact.value !== "string" ||
      !shadow?.enumerable ||
      !Object.hasOwn(shadow, "value") ||
      typeof shadow.value !== "number"
    )
      throw new Error("invalid");
    const observed = observedToolMicrousd({
      costMicrousd: exact.value,
      costCents: shadow.value,
    });
    assertMicrousd("reservedMicrousd", input.reservedMicrousd);
    assertMicrousd("chargedMicrousd", input.chargedMicrousd);
    if (
      observed > 150000n ||
      observed !== input.reservedMicrousd ||
      !Number.isFinite(shadow.value) ||
      Object.is(shadow.value, -0) ||
      shadow.value !== Number(observed) / 10000 ||
      input.chargedMicrousd > input.reservedMicrousd
    )
      throw new Error("invalid");
  } catch {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_FACTS_INVALID");
  }
  // Only the original ledger's upper bound is published. No provider data or invoice claim is inferred.
  return parseDurableExecutionReceiptFacts(
    {
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount: 1,
        upperBoundMicrousd: microusd(input.reservedMicrousd),
      },
      costBasis: "estimated_upper_bound",
    },
    input.resultSchema,
  );
}

export function toolExecutionReceiptFacts(input: {
  readonly toolId: string;
  readonly resultSchema: string;
  readonly result: ToolResult<unknown>;
  readonly reservedMicrousd: bigint;
  readonly chargedMicrousd: bigint;
}): DurableExecutionReceiptFacts {
  if (Object.hasOwn(CONTROLLED_CONTACT_RECEIPT_SCHEMAS, input.toolId))
    return controlledContactReceiptFacts(input);
  if (input.toolId === "google_patents.search") {
    const facts = patentCostFacts(input.result);
    if (facts.costBasis === "not_incurred") {
      return parseDurableExecutionReceiptFacts(
        {
          usage: {
            currency: "USD",
            unit: "microusd",
            callCount: 0,
            chargedMicrousd: "0",
            upperBoundMicrousd: "0",
          },
          costBasis: "not_incurred",
        },
        input.resultSchema,
      );
    }
    if (facts.costBasis === "provider_reported") {
      return parseDurableExecutionReceiptFacts(
        {
          usage: {
            currency: "USD",
            unit: "microusd",
            callCount: 1,
            bytesBilled: facts.observedBytesBilled,
            maximumBytesBilled: facts.maximumBytesBilled,
            chargedMicrousd: microusd(input.chargedMicrousd),
            upperBoundMicrousd: microusd(input.reservedMicrousd),
          },
          costBasis: "provider_reported",
        },
        input.resultSchema,
      );
    }
    return parseDurableExecutionReceiptFacts(
      {
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount: 1,
          maximumBytesBilled: facts.maximumBytesBilled,
          upperBoundMicrousd: microusd(input.reservedMicrousd),
        },
        costBasis: "estimated_upper_bound",
      },
      input.resultSchema,
    );
  }
  return parseDurableExecutionReceiptFacts(
    {
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount: 1,
        upperBoundMicrousd: microusd(input.reservedMicrousd),
      },
      costBasis: "estimated_upper_bound",
    },
    input.resultSchema,
  );
}

export function modelExecutionReceiptFacts(input: {
  readonly taskId: string;
  readonly resultSchema: string;
  readonly result: ModelResult<unknown>;
  readonly reservedMicrousd: bigint;
  readonly chargedMicrousd: bigint;
}): DurableExecutionReceiptFacts {
  const inputTokens = input.result.usage?.inputTokens;
  const outputTokens = input.result.usage?.outputTokens;
  const providerCostUsd = input.result.usage?.costUsd;
  const callCount = input.result.callCount ?? 1;
  const validInputTokens =
    inputTokens === undefined ||
    (Number.isSafeInteger(inputTokens) && inputTokens >= 0);
  const validOutputTokens =
    outputTokens === undefined ||
    (Number.isSafeInteger(outputTokens) && outputTokens >= 0);
  const tokenCountAvailable =
    validInputTokens &&
    validOutputTokens &&
    (inputTokens ?? 0) + (outputTokens ?? 0) > 0;
  const providerCostAvailable =
    Number.isFinite(providerCostUsd) && (providerCostUsd as number) >= 0;
  if (providerCostAvailable) {
    return parseDurableExecutionReceiptFacts(
      {
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount,
          ...(inputTokens === undefined || !validInputTokens
            ? {}
            : { inputTokens }),
          ...(outputTokens === undefined || !validOutputTokens
            ? {}
            : { outputTokens }),
          chargedMicrousd: microusd(input.chargedMicrousd),
          upperBoundMicrousd: microusd(input.reservedMicrousd),
        },
        costBasis: "provider_reported",
      },
      input.resultSchema,
    );
  }
  if (tokenCountAvailable) {
    return parseDurableExecutionReceiptFacts(
      {
        usage: {
          currency: "USD",
          unit: "microusd",
          callCount,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          chargedMicrousd: microusd(input.chargedMicrousd),
          upperBoundMicrousd: microusd(input.reservedMicrousd),
        },
        costBasis: "token_pricing",
      },
      input.resultSchema,
    );
  }
  return parseDurableExecutionReceiptFacts(
    {
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount,
        upperBoundMicrousd: microusd(input.reservedMicrousd),
      },
      costBasis: "estimated_upper_bound",
    },
    input.resultSchema,
  );
}

export function artifactExecutionReceiptFacts(input: {
  readonly resultSchema: string;
  readonly reservedMicrousd: bigint;
}): DurableExecutionReceiptFacts {
  return parseDurableExecutionReceiptFacts(
    {
      usage: {
        currency: "USD",
        unit: "microusd",
        callCount: 1,
        upperBoundMicrousd: microusd(input.reservedMicrousd),
      },
      costBasis: "estimated_upper_bound",
    },
    input.resultSchema,
  );
}
