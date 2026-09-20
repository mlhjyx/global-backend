import { createHash } from "node:crypto";

export const OPENOX_PRICING_AUTHORITY = {
  provider: "openox_model_marketplace",
  origin: "https://openox.tech",
  catalogEndpoint: "/api/public/pricing-catalog",
} as const;

export interface OpenOxPricingRow {
  model_id?: unknown;
  product_line?: unknown;
  input_rate?: unknown;
  output_rate?: unknown;
  cache_read_rate?: unknown;
  cache_write_rate?: unknown;
  group_rates?: unknown;
  status?: unknown;
  updated_at?: unknown;
}

export interface OpenOxPricingGroup {
  name?: unknown;
  product_line?: unknown;
  rate_multiplier?: unknown;
}

export interface OpenOxPricingCatalog {
  success?: unknown;
  data?: { models?: unknown; groups?: unknown };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}

function decimalMicrounits(value: unknown): number | null {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const result = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  return Number.isSafeInteger(result) ? result : null;
}

function multiplyMicrounits(
  rateMicrounits: number,
  multiplierMicrounits: number,
): number | null {
  const result = Math.round(
    (rateMicrounits * multiplierMicrounits) / 1_000_000,
  );
  return Number.isSafeInteger(result) ? result : null;
}

function pricingCurrency(productLine: string): "USD" | "CNY" | null {
  if (productLine === "claude" || productLine === "kimi") return "USD";
  if (
    ["gpt", "deepseek", "glm", "grok", "gemini", "minimax", "doubao"].includes(
      productLine,
    )
  ) {
    return "CNY";
  }
  return null;
}

export function settlementOpenOxPrice(
  catalog: OpenOxPricingCatalog,
  modelId: string,
  groupName: string,
) {
  const models = catalog.data?.models;
  const groups = catalog.data?.groups;
  if (
    catalog.success !== true ||
    !Array.isArray(models) ||
    !Array.isArray(groups)
  ) {
    return null;
  }
  const matchingModels = (models as OpenOxPricingRow[]).filter(
    (entry) => entry.model_id === modelId,
  );
  if (matchingModels.length !== 1) return null;
  const model = matchingModels[0];
  if (
    !model ||
    model.status !== "enabled" ||
    typeof model.product_line !== "string"
  ) {
    return null;
  }
  const matchingGroups = (groups as OpenOxPricingGroup[]).filter(
    (entry) =>
      entry.name === groupName && entry.product_line === model.product_line,
  );
  if (matchingGroups.length !== 1) return null;
  const group = matchingGroups[0];
  const currency = pricingCurrency(model.product_line);
  if (!group || !currency) return null;

  const modelMultiplier =
    modelId === "glm-5.2" &&
    model.group_rates &&
    typeof model.group_rates === "object" &&
    !Array.isArray(model.group_rates)
      ? (model.group_rates as Record<string, unknown>).billing_multiplier
      : undefined;
  const multiplierMicrounits = decimalMicrounits(
    modelMultiplier ?? group.rate_multiplier,
  );
  const input = decimalMicrounits(model.input_rate);
  const output = decimalMicrounits(model.output_rate);
  const cacheRead = decimalMicrounits(model.cache_read_rate ?? 0);
  const cacheWrite = decimalMicrounits(model.cache_write_rate ?? 0);
  if (
    multiplierMicrounits === null ||
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null
  ) {
    return null;
  }
  const effective = {
    input: multiplyMicrounits(input, multiplierMicrounits),
    output: multiplyMicrounits(output, multiplierMicrounits),
    cacheRead: multiplyMicrounits(cacheRead, multiplierMicrounits),
    cacheWrite: multiplyMicrounits(cacheWrite, multiplierMicrounits),
  };
  if (Object.values(effective).some((value) => value === null)) return null;

  const source = {
    modelId,
    productLine: model.product_line,
    groupName,
    groupMultiplier: group.rate_multiplier,
    modelBillingMultiplier: modelMultiplier ?? null,
    currency,
    inputRate: model.input_rate,
    outputRate: model.output_rate,
    cacheReadRate: model.cache_read_rate ?? "0",
    cacheWriteRate: model.cache_write_rate ?? "0",
    status: model.status,
    updatedAt: model.updated_at,
  };
  return {
    source,
    pricingVersion: createHash("sha256")
      .update(canonicalJson(source))
      .digest("hex"),
    productLine: model.product_line,
    currency,
    inputPriceMicrounitsPerMillionTokens: effective.input!,
    outputPriceMicrounitsPerMillionTokens: effective.output!,
    cacheReadPriceMicrounitsPerMillionTokens: effective.cacheRead!,
    cacheWritePriceMicrounitsPerMillionTokens: effective.cacheWrite!,
  };
}
