/**
 * ICP 行业词 → NACE 前缀映射（ch03 §3.9.12 的确定性离线底座，T3-05 子集）。
 *
 * 两条来源都能给出 NACE 前缀：
 *  1. 计划 filters 里的行业自由词（中/英/德）→ 复用 `ISIC_SEED` 的别名与 `crosswalks.nace`
 *     交叉表做**词面**匹配（语义归一仍归 taxonomy 冷路径，这里是确定性兜底）；
 *  2. taxonomy 归一注入的 `_industryCodes`（ISIC 码）→ 直接查交叉表。
 *
 * 另外提供 `canonicalNace`：把各国派生码（NAF rev2 的 `28.13Z`、无点号的 `2813`）归一到
 * NACE Rev.2 类目形态 `28.13`，装载时统一存储（原始码留在源快照里，可从快照回放）。
 *
 * 全部为纯函数：无 IO、无模型调用，可被适配器、装载器与单测共用。
 */
import { ISIC_SEED, type IsicNode } from '../discovery/isic-seed';

const CJK = /[㐀-鿿豈-﫿]/u;

export type NationalIndustryScheme =
  | 'NACE-2'
  | 'NAF-rev2'
  | 'UK-SIC-2007'
  | 'BR-CNAE-2.0'
  | 'AU-ANZSIC-2006';

/** 光伏 / 太阳能 / 电气安装 / 电气设备批发 / 发电工程核心 NACE Rev.2 类目。 */
export const SOLAR_ELECTRICAL_NACE_PREFIXES: readonly string[] = Object.freeze([
  '26.11',
  '27.11',
  '27.12',
  '27.20',
  '27.32',
  '27.33',
  '27.90',
  '35.11',
  '42.22',
  '43.21',
  '46.69',
]);

/** 英国 UK SIC 2007 光伏/电气/发电/设备批发目标 5 位码。 */
export const UK_SOLAR_ELECTRICAL_SIC_CODES: readonly string[] = Object.freeze([
  '26110',
  '27110',
  '27120',
  '27200',
  '27320',
  '27330',
  '27900',
  '35110',
  '42220',
  '43210',
  '46690',
]);

/** 巴西 CNAE 2.0 → NACE Rev.2 权威核对映射（覆盖光伏、电气制造、发电、配网工程、电气安装、电气/机械批发、工程设计）。 */
export const BR_CNAE_TO_NACE: Readonly<Record<string, string>> = Object.freeze({
  '2610800': '26.11',
  '2710401': '27.11',
  '2710402': '27.11',
  '2710403': '27.11',
  '2721000': '27.20',
  '2722801': '27.20',
  '2731700': '27.12',
  '2732500': '27.33',
  '2733300': '27.32',
  '2740602': '27.40',
  '2790201': '27.90',
  '2790202': '27.90',
  '2790299': '27.90',
  '3511500': '35.11',
  '3511501': '35.11',
  '3511502': '35.11',
  '3512300': '35.12',
  '3513100': '35.14',
  '3514000': '35.13',
  '4221901': '42.22',
  '4221902': '42.22',
  '4221903': '42.22',
  '4321500': '43.21',
  '4649401': '46.43',
  '4669901': '46.69',
  '4669999': '46.69',
  '4673700': '46.69',
  '4679604': '46.73',
  '4679699': '46.73',
  '7112000': '71.12',
});

/** 巴西 CNAE 2.0 光伏/电气安装/电气批发/发电工程目标 7 位码。 */
export const BR_SOLAR_ELECTRICAL_CNAE_CODES: readonly string[] = Object.freeze([
  '2610800',
  '2710401',
  '2710402',
  '2721000',
  '2731700',
  '2732500',
  '2733300',
  '2790299',
  '3511500',
  '3511501',
  '4221902',
  '4221903',
  '4321500',
  '4673700',
]);

/** 澳洲 ANZSIC 2006 → NACE Rev.2 权威核对映射（覆盖光伏/电气制造、发电、配网施工、电气安装、电气批发、工程设计）。 */
export const AU_ANZSIC_TO_NACE: Readonly<Record<string, string>> = Object.freeze({
  '2429': '26.11',
  '2431': '27.32',
  '2432': '27.40',
  '2439': '27.90',
  '2611': '35.11',
  '2612': '35.11',
  '2619': '35.11',
  '2620': '35.12',
  '2630': '35.13',
  '2640': '35.14',
  '3109': '42.22',
  '3232': '43.21',
  '3339': '46.73',
  '3494': '46.69',
  '6923': '71.12',
});

/** 澳洲 ANZSIC 2006 光伏/电气/发电/批发目标 4 位码。 */
export const AU_SOLAR_ELECTRICAL_ANZSIC_CODES: readonly string[] = Object.freeze([
  '2429',
  '2431',
  '2439',
  '2619',
  '3109',
  '3232',
  '3494',
]);

/** 4 位 ISIC Rev.4 补充交叉表（补齐 ISIC_SEED 父节点之下的细分行业码，避免细码查询落空）。 */
const ISIC4_TO_NACE_SUPPLEMENT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '2710': ['27.11', '27.12'],
  '2720': ['27.20'],
  '2732': ['27.32'],
  '2733': ['27.33'],
  '2740': ['27.40'],
  '2790': ['27.90'],
  '3510': ['35.11'],
  '4220': ['42.22'],
  '4659': ['46.69'],
});

/** 非 NACE 英国行政占位码（99999 Dormant、74990 Non-trading）。 */
const UK_SIC_NON_OPERATING = new Set(['99999', '74990']);

/**
 * 从 Companies House `SICCode.SicText_*` 抽取 5 位 UK SIC 2007 码。
 * 同时兼容官方格式 `"43210 - Electrical installation"`、括号格式 `"Wholesale ... (46690)"` 与裸码 `"43210"`。
 */
export function extractUkSicCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed || /^none supplied$/iu.test(trimmed)) return null;
  const leading = /^(\d{5})(?:\s*[-–]|$)/u.exec(trimmed);
  const code = leading?.[1] ?? /\((\d{5})\)\s*$/u.exec(trimmed)?.[1] ?? null;
  if (!code || UK_SIC_NON_OPERATING.has(code)) return null;
  return code;
}

/** UK SIC 2007（5 位）→ NACE Rev.2（`AA.BB`）。UK SIC 前 4 位与 NACE Rev.2 类目一一对应。 */
export function mapUkSicToNace(raw: string | null | undefined): string | null {
  const code = extractUkSicCode(raw);
  if (!code) return null;
  return `${code.slice(0, 2)}.${code.slice(2, 4)}`;
}

/** 归一巴西 7 位 CNAE 2.0 码（`4321-5/00` / `4321500` → `4321500`）。 */
export function normalizeBrCnae(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = raw.replace(/[^0-9]/gu, '');
  return digits.length === 7 ? digits : null;
}

/** 巴西 CNAE 2.0 → NACE Rev.2（优先精确交叉表；未登记则拒绝猜测返回 null）。 */
export function mapBrCnaeToNace(raw: string | null | undefined): string | null {
  const code = normalizeBrCnae(raw);
  if (!code) return null;
  return BR_CNAE_TO_NACE[code] ?? null;
}

/** 归一澳洲 4 位 ANZSIC 2006 码（`3232` / `E3232` → `3232`）。 */
export function normalizeAuAnzsic(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const match = /^[A-Z]?(\d{4})$/u.exec(raw.trim().toUpperCase());
  return match ? match[1]! : null;
}

/** 澳洲 ANZSIC 2006 → NACE Rev.2（严格走已核对交叉表）。 */
export function mapAnzsicToNace(raw: string | null | undefined): string | null {
  const code = normalizeAuAnzsic(raw);
  if (!code) return null;
  return AU_ANZSIC_TO_NACE[code] ?? null;
}

/** 统一各国行业码 → NACE Rev.2 入口（供 frame-normalize 与清洗管线共用）。 */
export function mapNationalIndustryCodeToNace(
  scheme: string | null | undefined,
  raw: string | null | undefined,
): string | null {
  const key = scheme?.trim().toUpperCase() ?? '';
  if (key === 'UK-SIC-2007' || key === 'UK_SIC_2007') return mapUkSicToNace(raw);
  if (key === 'BR-CNAE-2.0' || key === 'BR_CNAE_2.0' || key === 'CNAE-2.0') {
    return mapBrCnaeToNace(raw);
  }
  if (key === 'AU-ANZSIC-2006' || key === 'ANZSIC-2006') return mapAnzsicToNace(raw);
  return canonicalNace(raw);
}

/** 各国派生行业码 → NACE 类目形态（`28.13Z`/`2813`/`28.1`/`28` → `28.13`/`28.13`/`28.1`/`28`）。 */
export function canonicalNace(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim().toUpperCase();
  const match = /^(\d{2})(?:\.(\d{1,2})|(\d{2}))?([A-Z])?$/u.exec(value);
  if (!match) return null;
  const division = match[1]!;
  const group = match[2] ?? match[3];
  return group ? `${division}.${group}` : division;
}

function normalizeAlias(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

interface AliasEntry {
  alias: string;
  node: IsicNode;
  nacePrefixes: string[];
}

const ALIAS_INDEX: readonly AliasEntry[] = (() => {
  const entries: AliasEntry[] = [];
  for (const node of ISIC_SEED as readonly IsicNode[]) {
    const prefixes = node.crosswalks?.nace ?? [];
    if (prefixes.length === 0) continue;
    const terms = new Set<string>(
      [node.en, node.zh, node.de ?? '', ...(node.aliases ?? [])]
        .filter((term) => term.trim().length > 0)
        .map(normalizeAlias),
    );
    for (const alias of terms) entries.push({ alias, node, nacePrefixes: [...prefixes] });
  }
  return entries;
})();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * False-friend English/Latin words that contain a ≥4-char industry alias as a
 * substring without being a compound of that industry (e.g. "pumpkin" ≠ "pump").
 */
const SUBSTRING_FALSE_FRIENDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pump: ['pumpkin', 'pumpkins'],
  chip: ['woodchip', 'woodchips', 'fish and chips', 'potato chip'],
  lead: ['leader', 'leaders', 'leadership', 'leading', 'mislead', 'plead'],
  glass: ['hourglass', 'sunglass', 'eyeglass'],
});

/**
 * 词面匹配：完全相等、词边界包含（拉丁文），或纯子串包含（CJK，及 ≥4 字符的拉丁别名
 * ——德语复合词 Kreiselpumpen 必须命中 pump，同时拦截 pumpkin/leader 等假友词误配）。
 */
function aliasMatches(term: string, alias: string): boolean {
  if (term === alias) return true;
  if (CJK.test(alias)) return term.includes(alias);
  const bounded = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(alias)}([^\\p{L}\\p{N}]|$)`, 'u');
  if (bounded.test(term)) return true;
  if (alias.length < 4 || !term.includes(alias)) return false;
  const blocked = SUBSTRING_FALSE_FRIENDS[alias];
  if (blocked && blocked.some((word) => term.includes(word))) return false;
  return true;
}

export interface IndustryNaceResolution {
  prefixes: string[];
  matchedTerms: string[];
  unmatchedTerms: string[];
}

/** 跨语种光伏/电气细分补充别名（不改 ISIC_SEED 节点归属，专供 registry 查询侧确定性 NACE 前缀映射）。 */
const EXTRA_INDUSTRY_NACE_ALIASES: ReadonlyArray<{ alias: string; nacePrefixes: readonly string[] }> =
  Object.freeze([
    { alias: '光伏安装', nacePrefixes: ['43.21'] },
    { alias: '太阳能安装', nacePrefixes: ['43.21'] },
    { alias: 'solar installation', nacePrefixes: ['43.21'] },
    { alias: 'solar installer', nacePrefixes: ['43.21'] },
    { alias: 'pv installation', nacePrefixes: ['43.21'] },
    { alias: 'instalação elétrica', nacePrefixes: ['43.21'] },
    { alias: 'instalacao eletrica', nacePrefixes: ['43.21'] },
    { alias: '电气设备批发', nacePrefixes: ['46.69'] },
    { alias: '光伏批发', nacePrefixes: ['46.69'] },
    { alias: '光伏分销', nacePrefixes: ['46.69'] },
    { alias: 'electrical wholesale', nacePrefixes: ['46.69'] },
    { alias: 'electrical equipment wholesale', nacePrefixes: ['46.69'] },
    { alias: 'solar wholesale', nacePrefixes: ['46.69'] },
    { alias: 'solar distributor', nacePrefixes: ['46.69'] },
    { alias: 'material elétrico', nacePrefixes: ['46.69'] },
    { alias: 'material eletrico', nacePrefixes: ['46.69'] },
    { alias: 'energia solar', nacePrefixes: ['27.9', '35.11'] },
    { alias: 'geração de energia', nacePrefixes: ['35.11'] },
    { alias: 'geracao de energia', nacePrefixes: ['35.11'] },
    { alias: '光伏发电', nacePrefixes: ['35.11'] },
    { alias: '太阳能发电', nacePrefixes: ['35.11'] },
    { alias: 'solar power generation', nacePrefixes: ['35.11'] },
  ]);

/** 行业自由词（一个或多个）→ NACE 前缀集合（去重排序）。 */
export function nacePrefixesForIndustryTerms(terms: readonly string[]): IndustryNaceResolution {
  const prefixes = new Set<string>();
  const matchedTerms: string[] = [];
  const unmatchedTerms: string[] = [];
  for (const raw of terms) {
    const term = normalizeAlias(raw);
    if (!term) continue;
    let matched = false;
    for (const entry of ALIAS_INDEX) {
      if (aliasMatches(term, entry.alias)) {
        matched = true;
        for (const prefix of entry.nacePrefixes) prefixes.add(prefix);
      }
    }
    for (const extra of EXTRA_INDUSTRY_NACE_ALIASES) {
      if (aliasMatches(term, extra.alias)) {
        matched = true;
        for (const prefix of extra.nacePrefixes) prefixes.add(prefix);
      }
    }
    (matched ? matchedTerms : unmatchedTerms).push(raw.trim());
  }
  return {
    prefixes: [...prefixes].sort(),
    matchedTerms,
    unmatchedTerms,
  };
}

export interface IsicNodeMatch {
  code: string;
  en: string;
  nacePrefixes: string[];
  /** 命中的输入词（原样，去重后保持首个出现顺序）。 */
  matchedTerms: string[];
  /** 命中的词表别名（内部受控词，单独暴露：自由文本证据只能存别名，不能存原句）。 */
  matchedAliases: string[];
}

/**
 * 行业自由词 → 命中的 ISIC 节点（含 matchedTerms/matchedAliases），供存量归一推断使用。
 * 同一节点的多个别名命中合并；返回按 matchedTerms 数量与码具体度排序的稳定列表。
 */
export function matchIsicNodesForTerms(terms: readonly string[]): IsicNodeMatch[] {
  const matches = new Map<string, IsicNodeMatch>();
  for (const raw of terms) {
    const term = normalizeAlias(raw);
    if (!term) continue;
    for (const entry of ALIAS_INDEX) {
      if (!aliasMatches(term, entry.alias)) continue;
      const current = matches.get(entry.node.code) ?? {
        code: entry.node.code,
        en: entry.node.en,
        nacePrefixes: [...entry.nacePrefixes],
        matchedTerms: [],
        matchedAliases: [],
      };
      const value = raw.trim();
      if (!current.matchedTerms.includes(value)) current.matchedTerms.push(value);
      if (!current.matchedAliases.includes(entry.alias)) current.matchedAliases.push(entry.alias);
      matches.set(entry.node.code, current);
    }
  }
  return [...matches.values()].sort(
    (a, b) =>
      b.matchedTerms.length - a.matchedTerms.length ||
      b.code.length - a.code.length ||
      a.code.localeCompare(b.code),
  );
}

/** taxonomy 归一注入的 ISIC 码 → NACE 前缀（ISIC_SEED 精确节点优先，补齐 4 位 ISIC Rev.4 细分表）。 */
export function nacePrefixesForIsicCodes(codes: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const raw of codes) {
    const code = raw.trim().toUpperCase();
    if (!code) continue;
    let matchedSeed = false;
    for (const node of ISIC_SEED as readonly IsicNode[]) {
      if (node.code.toUpperCase() === code) {
        matchedSeed = true;
        for (const prefix of node.crosswalks?.nace ?? []) prefixes.add(prefix);
      }
    }
    if (!matchedSeed) {
      for (const prefix of ISIC4_TO_NACE_SUPPLEMENT[code] ?? []) prefixes.add(prefix);
    }
  }
  return [...prefixes].sort();
}

/** 计划 filters 的行业入口（显式 nace_prefix 优先；其次自由词；最后 ISIC 码）。 */
export function resolveNacePrefixes(input: {
  nacePrefix?: unknown;
  industry?: unknown;
  industryCodes?: unknown;
}): string[] {
  const explicit = Array.isArray(input.nacePrefix)
    ? input.nacePrefix.filter((value): value is string => typeof value === 'string')
    : [];
  const normalizedExplicit = explicit
    .map((value) => canonicalNace(value) ?? value.trim())
    .filter((value) => value.length > 0);
  if (normalizedExplicit.length > 0) return [...new Set(normalizedExplicit)].sort();

  const industryTerms =
    typeof input.industry === 'string'
      ? [input.industry]
      : Array.isArray(input.industry)
        ? input.industry.filter((value): value is string => typeof value === 'string')
        : [];
  const fromTerms = nacePrefixesForIndustryTerms(industryTerms).prefixes;
  if (fromTerms.length > 0) return fromTerms;

  const codes = Array.isArray(input.industryCodes)
    ? input.industryCodes.filter((value): value is string => typeof value === 'string')
    : [];
  return nacePrefixesForIsicCodes(codes);
}
