import { targetCountryCodes } from '../discovery/search-localization';
import { icpTradeRole } from '../discovery/icp-trade-role';
import type { RuleLike } from './rule-engine';

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_MARKETS = new Set(['CN', 'TW', 'HK', 'MO', 'SG', 'JP', 'KR']);

/**
 * 附加到 `icp.design` 提示词的业务质量护栏：
 * 1) 严禁把同行业竞争对手/上游制造厂混入下游买家画像；
 * 2) 买家大类品类词进 `product`/`keywords`/`MUST_HAVE`，卖方细分工艺/型号参数仅进 `NICE_TO_HAVE`/`value_props`；
 * 3) `trade_side` 与 `process_required` 规范落位，避免纯分销/EPC 被下游裁判误启制造工艺门；
 * 4) 非中文目标市场的规则与触发信号用英文/当地语言短词，禁止纯中文正则和 AI 元说明渗入 `exclusions`。
 */
export const ICP_GENERATION_QUALITY_RULES =
  '\n\nICP 生成质量硬约束（必须严格遵守）：\n' +
  '1. 买家角色聚焦：聚焦 1-2 类清晰的下游目标买家（如行业分销商/批发商、EPC工程承包商/系统集成商、终端采购方），严禁把同行业竞争对手或上游成品制造厂写进 sub_industry / business_model；同行制造厂必须放进 exclusions。\n' +
  '2. 大类与细分参数分层：company_attributes.product / keywords 与 MUST_HAVE 规则只写买家侧的通用大类品类词（兼顾英文与目标市场当地语言，如 photovoltaic modules / moduli fotovoltaici）；卖方特有的细分技术路线、工艺或型号参数（如 HJT / G12 / 0BB / 特定功率段）只能写进 value_props 或 NICE_TO_HAVE，不得设为 MUST_HAVE 硬门槛。\n' +
  '3. 规范贸易角色：company_attributes.trade_side 优先输出规范词（distributor | epc_integrator | end_buyer | oem_buyer）；若目标买家为纯渠道分销/批发/EPC 集成方（不要求买家自有生产工艺），请在 company_attributes.business_model 中明确写明「渠道分销/EPC采购（不要求制造工艺）」。\n' +
  '4. 机器可评估规则语言：当目标市场不是中文区时，qualification_rules 的关键词/正则值与 trigger_signals 必须包含英文或目标市场当地语言的简短可匹配词（如 solar, photovoltaic, distributor, EPC, tender, expansion），禁止写纯中文正则或长中文句子导致海外官网 0 命中。\n' +
  '5. 排除条件纯净：exclusions 只写具体的排除企业类型（如「上游光伏组件制造同行」「纯个人消费零售商」），严禁写入「执行约定：…」「数据约定：…」等规则说明或系统备注。';

const META_EXCLUSION_RE =
  /^(?:执行约定|数据约定|规则说明|评估说明|评估约定|数据说明|使用说明|注[：:]|备注[：:])/u;

const NON_MANUFACTURING_CHANNEL_RE =
  /\b(?:distributor|distribution|wholesale|wholesaler|reseller|dealer|importer|epc|installer|integrator|trading|channel)\b|分销|批发|贸易|经销|代理|渠道|工程承包|系统集成|安装商/iu;

const REQUIRES_MANUFACTURING_PROCESS_RE =
  /\b(?:oem\s*factory|contract\s*manufactur|cnc\s*machining|injection\s*molding|foundry|stamping|fabrication\s*plant)\b|自有产线|必须具备.*(?:工艺|制造|加工|产线)/iu;

const KEYWORD_RULE_FIELDS = new Set([
  'keywords',
  'industry',
  'sub_industry',
  'tech',
  'business_model',
  'end_markets',
  'product',
]);

const HALLUCINATED_EXCLUSION_PHRASE_RE =
  /已确认无|不具备.*(?:需求|影响力)|无相关.*(?:需求|采购)|无法确认/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(' ');
  return '';
}

function isStrictlyNonCjkMarket(targetMarkets: readonly unknown[]): boolean {
  const strings = targetMarkets.filter((item): item is string => typeof item === 'string');
  if (strings.length === 0) return false;
  const codes = targetCountryCodes({ filters: { country: strings } }).map((code) => code.toUpperCase());
  if (codes.length === 0) return false;
  return codes.every((code) => !CJK_MARKETS.has(code));
}

function ruleValueStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function isUnmatchableCjkRuleValue(value: unknown): boolean {
  const items = ruleValueStrings(value);
  if (items.length === 0) return false;
  return items.every((item) => {
    const unwrapped = item.trim().replace(/^\((.*)\)$/u, '$1');
    const branches = unwrapped
      .split('|')
      .map((branch) => branch.trim())
      .filter(Boolean);
    if (branches.length === 0) return false;
    // 每一条匹配分支都包含中文/CJK 字符（如 `HJT电池片采购`），在非中文目标市场官网上必为 0 命中。
    return branches.every((branch) => CJK_RE.test(branch));
  });
}

/**
 * 清洗 `exclusions`：剔除模型泄出的「执行约定：… / 数据约定：…」类元说明。
 */
export function sanitizeIcpExclusions(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.filter((item) => {
    if (typeof item !== 'string') return true;
    const trimmed = item.trim();
    if (!trimmed) return false;
    return !META_EXCLUSION_RE.test(trimmed);
  });
}

/**
 * 规范化 `company_attributes`：
 * - 为纯分销/批发/EPC 等非制造类买家自动补齐 `process_required: false`，防止下游 `fit-v2` 误启 C3_PROCESS；
 * - 若 `trade_side` 是无法被 `icpTradeRole` 识别的长中文句，且 `business_model` 指向渠道分销，归一保留 `trade_side`。
 */
export function normalizeIcpCompanyAttributes(
  companyAttributes: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...companyAttributes };
  const resolvedRole = icpTradeRole(next);
  const roleBlob = [
    textOf(next.trade_side),
    textOf(next.business_model),
    textOf(next.sub_industry),
  ].join(' ');

  if (
    next.process_required === undefined &&
    (resolvedRole === 'distributor' ||
      (NON_MANUFACTURING_CHANNEL_RE.test(roleBlob) && !REQUIRES_MANUFACTURING_PROCESS_RE.test(roleBlob)))
  ) {
    next.process_required = false;
  }

  if (
    typeof next.trade_side === 'string' &&
    next.trade_side.trim().length > 24 &&
    CJK_RE.test(next.trade_side) &&
    resolvedRole !== null
  ) {
    next.trade_side = resolvedRole;
  }

  return next;
}

/**
 * 过滤不可执行的规则噪声：
 * 1) 目标市场为非中文区时，丢弃纯中文 `MUST_HAVE` / `EXCLUSION` 关键词正则（在海外官网恒 0 命中）；
 * 2) 丢弃编造的中文判断句式 `EXCLUSION`（如 `keywords contains "已确认无相关外购需求及采购影响力"`）。
 */
export function filterUnmatchableIcpRules<T extends Pick<RuleLike, 'kind' | 'field' | 'operator' | 'value'>>(
  rules: readonly T[],
  targetMarkets: readonly unknown[],
): T[] {
  const nonCjk = isStrictlyNonCjkMarket(targetMarkets);
  return rules.filter((rule) => {
    const field = String(rule.field ?? '').toLowerCase();
    const values = ruleValueStrings(rule.value);
    if (
      rule.kind === 'EXCLUSION' &&
      values.some((item) => HALLUCINATED_EXCLUSION_PHRASE_RE.test(item))
    ) {
      return false;
    }
    if (
      nonCjk &&
      (rule.kind === 'MUST_HAVE' || rule.kind === 'EXCLUSION') &&
      KEYWORD_RULE_FIELDS.has(field) &&
      isUnmatchableCjkRuleValue(rule.value)
    ) {
      return false;
    }
    return true;
  });
}

export function sanitizeIcpAttributesInPlace(
  companyAttributes: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainRecord(companyAttributes)) return companyAttributes;
  const normalized = normalizeIcpCompanyAttributes(companyAttributes);
  for (const [key, value] of Object.entries(normalized)) {
    companyAttributes[key] = value;
  }
  return companyAttributes;
}
