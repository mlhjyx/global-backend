import { resolveHunterConfig } from '../enrichment/finders/hunter.provider';
import { resolveProspeoConfig } from '../enrichment/finders/prospeo.provider';
import { resolveEmailableConfig } from '../enrichment/verification/emailable.provider';
import { resolveMillionVerifierConfig } from '../enrichment/verification/millionverifier.provider';
import { resolveZeroBounceConfig } from '../enrichment/verification/zerobounce.provider';
import { WorkspaceTechnicalBudgetQuoteError } from './workspace-technical-budget-quote';

/**
 * 受控补强工具的纯价格目录（只含非秘密元数据）。
 *
 * 单价投影自运行时同一套 env 归一化 resolver（不另存一套会漂移的默认价），
 * 版本仍用 CONTROLLED_ENRICHMENT_TOOL_DECLARATIONS 的原值 1.0.0，costUnit 仍是
 * 原工具的 request。报价是技术上界，不是 provider 可用性/出网授权声明：
 * 未配置 key 的工具照样计价，admission/pre-wire 仍按原门拒绝或跳过。
 */
export const ENRICH_CONTACT_PRICE_POLICY_VERSION = 1 as const;
export const MAX_CONTROLLED_ENRICHMENT_UNIT_MICROUSD = 150_000 as const;
export const ENRICH_CONTACT_PRICE_UNIT_CEIL_DIVISOR = 10_000n as const;

const PROVIDERS = Object.freeze([
  Object.freeze({
    provider: 'hunter' as const,
    toolId: 'contact_email.find.hunter',
  }),
  Object.freeze({
    provider: 'prospeo' as const,
    toolId: 'contact_email.find.prospeo',
  }),
  Object.freeze({
    provider: 'millionverifier' as const,
    toolId: 'contact_email.verify.millionverifier',
  }),
  Object.freeze({
    provider: 'emailable' as const,
    toolId: 'contact_email.verify.emailable',
  }),
  Object.freeze({
    provider: 'zerobounce' as const,
    toolId: 'contact_email.verify.zerobounce',
  }),
]);

export type EnrichContactPriceProvider =
  (typeof PROVIDERS)[number]['provider'];

export interface EnrichContactPriceConfigs {
  readonly hunter: number;
  readonly prospeo: number;
  readonly millionverifier: number;
  readonly emailable: number;
  readonly zerobounce: number;
}

export interface EnrichContactPriceEntry {
  readonly provider: EnrichContactPriceProvider;
  readonly toolId: string;
  readonly version: '1.0.0';
  readonly costUnit: 'request';
  readonly unitQuoteUpperMicrousd: number;
  readonly unitCeilCents: number;
}

export const ENRICH_CONTACT_PRICE_TOOL_IDS = Object.freeze(
  PROVIDERS.map((entry) => entry.toolId),
);

function unavailable(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
  );
}

function controlledUnitMicrousd(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_CONTROLLED_ENRICHMENT_UNIT_MICROUSD
  ) {
    return unavailable();
  }
  return value;
}

/**
 * ceil(µUSD / 10000) in integer cents; never floors a sub-cent paid call to zero.
 * `0` µUSD stays `0` (a genuinely free governed tool, not an unknown price).
 */
export function enrichUnitCeilCents(unitMicrousd: unknown): number {
  return Number(
    (BigInt(controlledUnitMicrousd(unitMicrousd)) +
      ENRICH_CONTACT_PRICE_UNIT_CEIL_DIVISOR -
      1n) /
      ENRICH_CONTACT_PRICE_UNIT_CEIL_DIVISOR,
  );
}

export function projectEnrichContactPriceCatalog(
  configs: EnrichContactPriceConfigs,
): readonly EnrichContactPriceEntry[] {
  if (
    configs === null ||
    typeof configs !== 'object' ||
    Array.isArray(configs)
  ) {
    return unavailable();
  }
  const keys = Object.keys(configs).sort();
  const expected = PROVIDERS.map((entry) => entry.provider).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return unavailable();
  }
  return Object.freeze(
    PROVIDERS.map(({ provider, toolId }) => {
      const unitQuoteUpperMicrousd = controlledUnitMicrousd(configs[provider]);
      return Object.freeze({
        provider,
        toolId,
        version: '1.0.0' as const,
        costUnit: 'request' as const,
        unitQuoteUpperMicrousd,
        unitCeilCents: enrichUnitCeilCents(unitQuoteUpperMicrousd),
      });
    }),
  );
}

export function enrichContactPriceCatalog(
  env: NodeJS.ProcessEnv = process.env,
): readonly EnrichContactPriceEntry[] {
  return projectEnrichContactPriceCatalog({
    hunter: resolveHunterConfig(env).costMicrousd,
    prospeo: resolveProspeoConfig(env).costMicrousd,
    millionverifier: resolveMillionVerifierConfig(env).costMicrousd,
    emailable: resolveEmailableConfig(env).costMicrousd,
    zerobounce: resolveZeroBounceConfig(env).costMicrousd,
  });
}
