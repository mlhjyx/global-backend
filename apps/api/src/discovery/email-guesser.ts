/**
 * 决策人邮箱猜测编排器（选项 B · P0，把纯排列/格式学习接到真实 SMTP 验证）。
 *
 * 管线：格式学习（若有同公司已知具名邮箱，命中率更高）优先 → 邮箱模式排列兜底
 *   → **合规门一次判**（人名邮箱需 lawful-basis，复用 {@link ./compliance/email-verification-gate}）
 *   → 逐候选（按先验降序、有界）经注入的验证器 SMTP RCPT 验证（验证器内部走 ToolBroker）
 *   → 命中 VALID 即停；域级事实（catch-all/反枚举/不可达/无 MX）**一次即短路**（无谓再探）。
 *
 * 🔴 诚实（沿用 smtp_self 的上限）：catch-all / Gmail-M365 反枚举 / 端口 25 封 → 无法逐地址证实
 *   → 返回**未验证的最优猜测**并明确标注，绝不谎报 VALID。合规红线：所有候选=人名邮箱（personalData），
 *   无 lawful-basis 且未开开关 → BLOCKED，一个都不探测。
 */
import { EmailVerdict, EmailVerificationAdapter, EmailVerifyContext, LawfulBasis } from './provider-contract';
import {
  evaluateEmailGate,
  resolveEmailVerificationPolicy,
  stampLawfulBasis,
} from './compliance/email-verification-gate';
import { EmailCandidate, generateEmailCandidates } from './email-permutation';
import { KnownEmailSample, applyLearnedPattern, inferEmailPattern } from './email-format-learning';

export interface GuessInput {
  fullName: string;
  domain: string;
  /** 同公司已知 (姓名,邮箱) 样本 → 学格式（可选，有则优先且更准）。 */
  knownSamples?: KnownEmailSample[];
}

export interface GuessContext {
  workspaceId?: string;
  runId?: string;
  /** 人名邮箱的合法性基础（LIA/同意/合同）；缺失且未开开关 → BLOCKED。 */
  lawfulBasis?: LawfulBasis;
  /** 显式开关：无 basis 也允许探测（默认 false）。 */
  allowPersonalWithoutBasis?: boolean;
  /** 断言人（写入 basis 审计），默认 'system'。 */
  actor?: string;
  /** 断言时间 ISO（保持纯/可测，由调用方传入；缺省用当前时间）。 */
  nowIso?: string;
  /** 禁联名单（命中的候选直接跳过，不探测）。 */
  suppressedEmails?: Set<string>;
  /** 最多探测几个候选（默认 8），控 SMTP 扇出与耗时。 */
  maxProbe?: number;
}

export type GuessStatus =
  | 'verified' // 某候选 SMTP 证实存在（非 catch-all）
  | 'unverified' // 有最优猜测但无法证实（catch-all/反枚举/不可达）
  | 'exhausted' // 探测的候选均被明确拒收（域可探测但这些地址不存在）
  | 'undeliverable_domain' // 域无 MX/Null-MX → 根本不收邮件
  | 'blocked' // 合规门拦截（人名邮箱无 lawful-basis）
  | 'no_candidates'; // 姓名/域无法生成候选

export interface EmailGuess {
  email: string;
  pattern: string;
  prior: number;
  verdict: EmailVerdict;
  /** 综合置信度（SMTP 证实 > 学到格式 > 高先验盲猜；未证实明显偏低）。 */
  confidence: number;
}

export interface GuessResult {
  status: GuessStatus;
  /** 最优结果（verified/unverified 有值；其余为空）。 */
  best?: EmailGuess;
  /** 域级事实（若命中），用于留痕与解释。 */
  domainFact?: 'catch_all' | 'anti_enumeration' | 'unreachable' | 'no_mx' | 'egress_blocked' | 'suppressed';
  /** 实际探测的候选数（合规/预算成本可见）。 */
  triedCount: number;
  /** 生成的候选（透明化，便于审计/调参；不代表都探测了）。 */
  candidates: EmailCandidate[];
  reason: string;
}

/** 从验证器 verdict.detail 归类**域级**事实（命中即对全部候选成立 → 短路）。 */
function domainFactOf(v: EmailVerdict): GuessResult['domainFact'] | null {
  const d = v.detail ?? '';
  if (v.status === 'INVALID' && /no_mx|null_mx|dns_lookup_failed/.test(d)) return 'no_mx';
  if (/anti_enumeration/.test(d)) return 'anti_enumeration';
  if (/catch_all_domain/.test(d)) return 'catch_all';
  // mail_from_rejected：MX 拒了我们的信封发件人 → 本次会话对**所有**候选恒成立（同发件人），
  //   一次即短路，不为每个候选重复无效探测（真数据实测反抓：osna-pumpen.de 曾探 6 次全同结果）。
  if (/smtp_unreachable|smtp_gate_unavailable|smtp_probe_failed|mail_from_rejected/.test(d)) return 'unreachable';
  if (/mx_egress_blocked/.test(d)) return 'egress_blocked';
  if (/source_policy/.test(d)) return 'suppressed';
  return null;
}

const DOMAIN_FACT_REASON: Record<NonNullable<GuessResult['domainFact']>, string> = {
  catch_all: 'catch_all_domain_unconfirmable',
  anti_enumeration: 'anti_enumeration_provider_unconfirmable',
  unreachable: 'smtp_unreachable_unconfirmable',
  no_mx: 'domain_has_no_mail_exchanger',
  egress_blocked: 'mx_egress_blocked',
  suppressed: 'source_policy_denied',
};

/** 未验证猜测的置信度 = 先验 × 0.4（明显低于 SMTP 证实的 0.9+），保留两位小数。 */
function unverifiedConfidence(prior: number): number {
  return Math.round(prior * 0.4 * 100) / 100;
}

/** 格式学习样本上界（一致样本少量即够，防病态大输入）。 */
const MAX_LEARN_SAMPLES = 50;

/**
 * 邮箱猜测编排器。注入 SMTP 验证器（生产=SelfHostedEmailVerifier；测试=假实现）。
 * 不自行触网——所有 SMTP 出网都经注入验证器（其内部走 ToolBroker 唯一闸门）。
 */
export class EmailGuesser {
  constructor(private readonly verifier: EmailVerificationAdapter) {}

  async guess(input: GuessInput, ctx: GuessContext = {}): Promise<GuessResult> {
    const candidates = this.buildCandidates(input);
    if (candidates.length === 0) {
      return { status: 'no_candidates', triedCount: 0, candidates, reason: 'name_or_domain_unusable' };
    }

    // 🔴 合规门：所有候选=同域人名邮箱，门决策一致 → 判一次。拦截则一个都不探测。
    const gate = evaluateEmailGate({
      email: candidates[0].email,
      kind: 'personal',
      lawfulBasis: ctx.lawfulBasis,
      suppressed: false, // 逐候选 suppression 在探测循环里查（域级 suppression 由验证器 source_policy 门兜）
      policy: resolveEmailVerificationPolicy({ allowPersonalWithoutBasis: ctx.allowPersonalWithoutBasis }),
    });
    if (!gate.allowed) {
      return {
        status: 'blocked',
        triedCount: 0,
        candidates,
        reason: `lawful_basis_gate:${gate.reason}`,
      };
    }
    const recordedBasis = gate.lawfulBasis
      ? stampLawfulBasis(gate.lawfulBasis, ctx.actor ?? 'system', ctx.nowIso ?? new Date().toISOString())
      : undefined;
    const verifyCtx: EmailVerifyContext = {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      kind: 'personal',
      lawfulBasis: recordedBasis,
      allowPersonalWithoutBasis: ctx.allowPersonalWithoutBasis,
    };

    const maxProbe = ctx.maxProbe ?? 8;
    const suppressed = ctx.suppressedEmails ?? new Set<string>();
    let tried = 0;
    // 最优「未被证伪」候选：第一个非 INVALID 的探测（候选按先验降序 → 即最高先验的可信猜测）。
    // 🔴 关键：**排除已被 SMTP 明确拒收(INVALID)的地址**，绝不把证实不存在的邮箱当最优猜测；
    //    且 email 与 verdict 取自**同一次**探测（不像旧版把 c1 的 verdict 拼到 c0 的 email 上）。
    let bestPlausible: EmailGuess | null = null;

    for (const cand of candidates) {
      if (tried >= maxProbe) break;
      if (suppressed.has(cand.email.toLowerCase())) continue;
      tried += 1;
      const verdict = await this.verifier.verifyEmail(cand.email, verifyCtx);

      if (verdict.status === 'VALID') {
        const learned = cand.pattern.startsWith('learned:');
        return {
          status: 'verified',
          best: { ...cand, verdict, confidence: learned ? 0.95 : 0.9 },
          triedCount: tried,
          candidates,
          reason: `smtp_verified:${cand.pattern}`,
        };
      }

      // 记录最优可信猜测：非 INVALID 即未被证伪（含 RISKY 域级事实/inconclusive）。
      if (verdict.status !== 'INVALID' && !bestPlausible) {
        bestPlausible = { ...cand, verdict, confidence: unverifiedConfidence(cand.prior) };
      }

      // 域级事实（catch-all/反枚举/不可达/无 MX/SSRF/policy）→ 全候选同命 → 一次即短路。
      const fact = domainFactOf(verdict);
      if (fact) return this.domainFactResult(fact, bestPlausible, tried, candidates);

      // 其余（INVALID mailbox_rejected 证伪 / RISKY inconclusive）→ 试下一个更优候选。
    }

    if (bestPlausible) {
      return { status: 'unverified', best: bestPlausible, triedCount: tried, candidates, reason: 'no_valid_best_effort_risky' };
    }
    if (tried === 0) {
      // 候选全在禁联名单 → 一次都没探 → 别谎称「已逐个探测后拒收」。
      return { status: 'exhausted', domainFact: 'suppressed', triedCount: 0, candidates, reason: 'all_candidates_suppressed' };
    }
    return { status: 'exhausted', triedCount: tried, candidates, reason: 'all_probed_candidates_rejected' };
  }

  /** 域级事实收尾（抽出以缩短 guess）：no_mx=不可投递无猜测；被闸门挡=无信号无猜测；其余给最优可信猜测。 */
  private domainFactResult(
    fact: NonNullable<GuessResult['domainFact']>,
    bestPlausible: EmailGuess | null,
    tried: number,
    candidates: EmailCandidate[],
  ): GuessResult {
    const reason = DOMAIN_FACT_REASON[fact];
    if (fact === 'no_mx') {
      return { status: 'undeliverable_domain', domainFact: fact, triedCount: tried, candidates, reason };
    }
    // egress_blocked / source_policy：被 SSRF 护栏或用途门挡下 → 无任何投递信号 → 诚实不给猜测。
    if (fact === 'egress_blocked' || fact === 'suppressed') {
      return { status: 'unverified', domainFact: fact, triedCount: tried, candidates, reason };
    }
    // catch_all / anti_enumeration / unreachable：域收信但无法逐地址证实 → 给最优可信猜测（排除已证伪者）。
    return { status: 'unverified', domainFact: fact, best: bestPlausible ?? undefined, triedCount: tried, candidates, reason };
  }

  /** 生成候选：有已知样本先学格式（高置信在前），再拼盲排列兜底，去重保序。 */
  private buildCandidates(input: GuessInput): EmailCandidate[] {
    const out: EmailCandidate[] = [];
    const seen = new Set<string>();
    if (input.knownSamples?.length) {
      // 上界防御：格式学习只需少量一致样本，截断防病态大输入拖慢（每样本 O(变体×模式)）。
      const learned = inferEmailPattern(input.knownSamples.slice(0, MAX_LEARN_SAMPLES));
      if (learned) {
        for (const c of applyLearnedPattern(learned, input.fullName, input.domain)) {
          if (!seen.has(c.email)) { seen.add(c.email); out.push(c); }
        }
      }
    }
    for (const c of generateEmailCandidates(input.fullName, input.domain)) {
      if (!seen.has(c.email)) { seen.add(c.email); out.push(c); }
    }
    return out;
  }
}
