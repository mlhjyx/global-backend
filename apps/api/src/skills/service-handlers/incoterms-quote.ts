/**
 * `quoting.incoterms.v1` handler：确定性 Incoterms 2020 成本/报价建议（L1 只读）。
 *
 * 红线（设计 S1-D8）：汇率必须由输入提供（不查外部牌价）；不生成 PI/CI/PL 或任何
 * 对外单据；不做税务/法律意见；结果需人工确认（manifest humanGate=true）。
 * 金额以「分」为单位整数累加，最终才四舍五入到两位小数，保证跨平台确定。
 */

export const INCOTERMS = ["EXW", "FOB", "CFR", "CIF", "DDP"] as const;
export type Incoterm = (typeof INCOTERMS)[number];

export const COST_LINE_KINDS = [
  "goods",
  "packaging",
  "inland_freight",
  "ocean_freight",
  "insurance",
  "duty",
  "other",
] as const;
export type CostLineKind = (typeof COST_LINE_KINDS)[number];

export const INCOTERMS_FORMULA_VERSION = "incoterms-2020/v1";

export interface CostLineInput {
  readonly kind: CostLineKind;
  readonly amount: number;
  readonly currency: string;
}

export interface IncotermsQuoteInput {
  readonly incoterm: Incoterm;
  readonly quantity: number;
  readonly currency: string;
  readonly costLines: readonly CostLineInput[];
  readonly exchangeRate?: number;
  readonly marginPct?: number;
}

export interface CostBreakdownLine {
  readonly kind: CostLineKind;
  readonly amount: number;
  readonly included: boolean;
}

export interface IncotermsQuoteOutput {
  readonly incoterm: Incoterm;
  readonly formulaVersion: typeof INCOTERMS_FORMULA_VERSION;
  readonly currency: string;
  readonly breakdown: readonly CostBreakdownLine[];
  readonly unitCost: number;
  readonly totalUnitPrice: number;
  readonly totalAmount: number;
  readonly assumptions: readonly string[];
  readonly warnings: readonly string[];
}

export class QuotingInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "QuotingInputError";
  }
}

/**
 * Incoterms 2020 卖方成本包含矩阵（v1 简化，不含出口清关/进口清关独立行；
 * `other` 视作卖方行政费用，全术语计入）。duty 仅 DDP 由卖方承担。
 */
const INCLUDED_KINDS: Readonly<Record<Incoterm, readonly CostLineKind[]>> = {
  EXW: ["goods", "packaging", "other"],
  FOB: ["goods", "packaging", "inland_freight", "other"],
  CFR: ["goods", "packaging", "inland_freight", "ocean_freight", "other"],
  CIF: ["goods", "packaging", "inland_freight", "ocean_freight", "insurance", "other"],
  DDP: [
    "goods",
    "packaging",
    "inland_freight",
    "ocean_freight",
    "insurance",
    "duty",
    "other",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseIncotermsQuoteInput(input: unknown): IncotermsQuoteInput {
  if (!isRecord(input)) throw new QuotingInputError("QUOTING_INPUT_INVALID", "input must be an object");
  const incoterm = input["incoterm"];
  if (typeof incoterm !== "string" || !INCOTERMS.includes(incoterm as Incoterm)) {
    throw new QuotingInputError("QUOTING_INCOTERM_INVALID", `incoterm must be one of ${INCOTERMS.join("|")}`);
  }
  const quantity = input["quantity"];
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    throw new QuotingInputError("QUOTING_QUANTITY_INVALID", "quantity must be a positive integer");
  }
  const currency = input["currency"];
  if (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency)) {
    throw new QuotingInputError("QUOTING_CURRENCY_INVALID", "currency must be an ISO 4217 code");
  }
  const exchangeRate = input["exchangeRate"];
  if (
    exchangeRate !== undefined &&
    (typeof exchangeRate !== "number" || !Number.isFinite(exchangeRate) || exchangeRate <= 0)
  ) {
    throw new QuotingInputError("QUOTING_EXCHANGE_RATE_INVALID", "exchangeRate must be a positive number");
  }
  const marginPct = input["marginPct"];
  if (
    marginPct !== undefined &&
    (typeof marginPct !== "number" || !Number.isFinite(marginPct) || marginPct < 0 || marginPct > 300)
  ) {
    throw new QuotingInputError("QUOTING_MARGIN_INVALID", "marginPct must be between 0 and 300");
  }
  const costLines = input["costLines"];
  if (!Array.isArray(costLines) || costLines.length === 0 || costLines.length > 64) {
    throw new QuotingInputError("QUOTING_COST_LINES_INVALID", "costLines must be a non-empty array");
  }
  const parsedLines: CostLineInput[] = costLines.map((line) => {
    if (
      !isRecord(line) ||
      typeof line["kind"] !== "string" ||
      !COST_LINE_KINDS.includes(line["kind"] as CostLineKind) ||
      typeof line["amount"] !== "number" ||
      !Number.isFinite(line["amount"]) ||
      line["amount"] < 0 ||
      typeof line["currency"] !== "string" ||
      !/^[A-Z]{3}$/u.test(line["currency"] as string)
    ) {
      throw new QuotingInputError("QUOTING_COST_LINES_INVALID", "invalid cost line");
    }
    return {
      kind: line["kind"] as CostLineKind,
      amount: line["amount"] as number,
      currency: line["currency"] as string,
    };
  });
  return {
    incoterm: incoterm as Incoterm,
    quantity,
    currency,
    costLines: parsedLines,
    ...(exchangeRate !== undefined ? { exchangeRate: exchangeRate as number } : {}),
    ...(marginPct !== undefined ? { marginPct: marginPct as number } : {}),
  };
}

export function computeIncotermsQuote(input: unknown): IncotermsQuoteOutput {
  const parsed = parseIncotermsQuoteInput(input);
  const included = new Set(INCLUDED_KINDS[parsed.incoterm]);
  const breakdown: CostBreakdownLine[] = [];
  let totalCostCents = 0;
  const assumptions: string[] = [
    "Incoterms 2020 语义；成本行由输入提供，未含进口清关/增值税等未列出项",
    "汇率为输入值，不查询外部牌价；未列汇率时要求成本币与报价币一致",
    "本输出是 L1 报价建议，不构成正式要约或对外单据（PI/CI/PL 需人工另行处理）",
  ];
  const warnings: string[] = [];

  for (const line of parsed.costLines) {
    let amount = line.amount;
    if (line.currency !== parsed.currency) {
      if (parsed.exchangeRate === undefined) {
        throw new QuotingInputError(
          "QUOTING_EXCHANGE_RATE_REQUIRED",
          `cost line in ${line.currency} needs exchangeRate to ${parsed.currency}`,
        );
      }
      amount = line.amount * parsed.exchangeRate;
      if (!assumptions.some((entry) => entry.includes(`1 ${line.currency} =`))) {
        assumptions.push(`1 ${line.currency} = ${parsed.exchangeRate} ${parsed.currency}（输入汇率）`);
      }
    }
    const amountCents = Math.round(amount * 100);
    const isIncluded = included.has(line.kind);
    if (isIncluded) totalCostCents += amountCents;
    breakdown.push({ kind: line.kind, amount: amountCents / 100, included: isIncluded });
  }

  if (!breakdown.some((line) => line.kind === "goods" && line.included)) {
    throw new QuotingInputError("QUOTING_GOODS_REQUIRED", "a goods cost line is required");
  }

  const unitCost = totalCostCents / parsed.quantity / 100;
  const marginPct = parsed.marginPct ?? 0;
  const totalUnitPrice = Math.round(unitCost * (1 + marginPct / 100) * 100) / 100;
  const totalAmount = Math.round(totalUnitPrice * parsed.quantity * 100) / 100;

  if (unitCost === 0) warnings.push("unitCost 为 0，请核对成本行");
  warnings.push(`${parsed.incoterm} 下的费用分界以 Incoterms 2020 规则为准，请人工复核`);

  return {
    incoterm: parsed.incoterm,
    formulaVersion: INCOTERMS_FORMULA_VERSION,
    currency: parsed.currency,
    breakdown,
    unitCost,
    totalUnitPrice,
    totalAmount,
    assumptions,
    warnings,
  };
}
