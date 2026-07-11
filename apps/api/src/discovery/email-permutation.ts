/**
 * 邮箱模式排列生成器（选项 B · P0 核心补全器，纯逻辑不触网）。
 *
 * 痛点：官网这一途径能稳定拿决策人**姓名 + 职务**，但**本人可用邮箱**大多拿不到
 * （官网很少公示到个人）。本模块把「有名字 + 公司域名」变成一组**按先验排序的候选邮箱**，
 * 交给 {@link ./providers/email-verify.provider} 经 ToolBroker 逐个 SMTP 验证，命中 VALID 即其邮箱。
 *
 * 🔴 合规：只**生成候选并验证存在性**，绝不推断/编造后当既成事实——未经 SMTP 证实的候选一律标
 *    未验证；生成物是人名邮箱（personalData），下游必过 lawful-basis 门（GDPR Art.6/14）。
 *
 * 设计取舍（KISS）：覆盖德/欧 B2B 最常见的中小企业命名法，音译出德语标准变体（ö→oe）与
 *    去音标变体（ö→o）两套（不同公司两种都有），候选**有界**（默认上限）避免无谓 SMTP 扇出。
 */

// 人名解析（去称谓/贵族前缀/音译）已抽成共享纯件 `./person-name`（消 DRY，供 person-identity 复用）。
// 此处 re-export 保持既有下游（email-format-learning / email-guesser / spec）零改动、行为逐字不变。
import { parseName, transliterateVariants } from './person-name';
import type { ParsedName } from './person-name';

export { parseName, transliterateVariants };
export type { ParsedName };

/** 一条候选邮箱：地址 + 生成它的模式标签 + 该模式的经验先验（0-1，越高越可能是公司实际命名法）。 */
export interface EmailCandidate {
  email: string;
  /** 模式标签（如 `first.last` / `f.last`），用于留痕 + 格式学习反查。 */
  pattern: string;
  /** 该模式在 B2B 的经验先验概率（排序 + 置信度输入，非保证）。 */
  prior: number;
}

/** 模式定义：给定 first/last 部件片段，产出 local-part；prior=经验先验。 */
interface PatternDef {
  label: string;
  prior: number;
  /** first=名, fi=名首字母, last=姓(可能含前缀压平), li=姓首字母。返回 local-part（空则跳过）。 */
  build: (p: { first: string; fi: string; last: string; li: string }) => string;
}

// B2B 常见命名法，先验按经验排序（first.last / f.last 最普遍）。
const PATTERNS: PatternDef[] = [
  { label: 'first.last', prior: 0.9, build: (p) => (p.last ? `${p.first}.${p.last}` : '') },
  { label: 'f.last', prior: 0.85, build: (p) => (p.last ? `${p.fi}.${p.last}` : '') },
  { label: 'firstlast', prior: 0.6, build: (p) => (p.last ? `${p.first}${p.last}` : '') },
  { label: 'flast', prior: 0.55, build: (p) => (p.last ? `${p.fi}${p.last}` : '') },
  { label: 'first', prior: 0.5, build: (p) => p.first },
  { label: 'last', prior: 0.45, build: (p) => p.last },
  { label: 'first_last', prior: 0.4, build: (p) => (p.last ? `${p.first}_${p.last}` : '') },
  { label: 'last.first', prior: 0.32, build: (p) => (p.last ? `${p.last}.${p.first}` : '') },
  { label: 'lastf', prior: 0.28, build: (p) => (p.last ? `${p.last}${p.fi}` : '') },
  { label: 'first.l', prior: 0.22, build: (p) => (p.last ? `${p.first}.${p.li}` : '') },
];

const DEFAULT_MAX_CANDIDATES = 12;

export interface GenerateOptions {
  /** 候选上限（默认 12），控制 SMTP 扇出。 */
  maxCandidates?: number;
}

/**
 * 生成候选邮箱（按先验降序、去重、有界）。
 * @param fullName 决策人全名（可含称谓/贵族前缀）
 * @param domain   公司邮箱域名（如 `zehnder-pumpen.de`，不含 @）
 */
export function generateEmailCandidates(
  fullName: string,
  domain: string,
  opts: GenerateOptions = {},
): EmailCandidate[] {
  const dom = domain.trim().toLowerCase().replace(/^@/, '').replace(/^www\./, '');
  const parsed = parseName(fullName);
  if (!parsed || !dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return [];

  const firstVariants = transliterateVariants(parsed.given);
  // 姓变体：压平整段（含前缀）与仅 core 段两套，都音译
  const lastSources = parsed.surname
    ? Array.from(new Set([parsed.surname.replace(/\s+/g, ''), parsed.surnameCore]))
    : [];
  const lastVariants = lastSources.flatMap(transliterateVariants);
  if (firstVariants.length === 0) return [];

  const seen = new Set<string>();
  const out: EmailCandidate[] = [];
  for (const def of PATTERNS) {
    for (const first of firstVariants) {
      const fi = first.charAt(0);
      const lasts = lastVariants.length ? lastVariants : [''];
      for (const last of lasts) {
        const li = last.charAt(0);
        const local = def.build({ first, fi, last, li }).replace(/^[._]+|[._]+$/g, '');
        if (!local || local.length < 2) continue;
        const email = `${local}@${dom}`;
        if (seen.has(email)) continue;
        seen.add(email);
        out.push({ email, pattern: def.label, prior: def.prior });
      }
    }
  }
  // 已按 PATTERNS 先验序生成；同模式多变体保持插入序。稳定截断。
  return out
    .sort((a, b) => b.prior - a.prior)
    .slice(0, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
}

/** 导出模式标签集（供格式学习模块反查，DRY）。 */
export const KNOWN_PATTERNS: readonly { label: string; prior: number }[] = PATTERNS.map(
  ({ label, prior }) => ({ label, prior }),
);

/** 给定姓名部件与模式标签，重建 local-part（格式学习复用同一套定义）。 */
export function buildLocalPart(
  label: string,
  parts: { first: string; fi: string; last: string; li: string },
): string | null {
  const def = PATTERNS.find((p) => p.label === label);
  if (!def) return null;
  const local = def.build(parts).replace(/^[._]+|[._]+$/g, '');
  return local && local.length >= 2 ? local : null;
}
