import { cleanEmail } from '../../acquisition/clean';
import { EmailVerifyContext, LawfulBasis, LawfulBasisKind } from '../provider-contract';

/**
 * 邮箱验证的**合法性基础门**（GDPR Art.6 / Art.14，见 AGENTS.md 合规红线 + buyer-intelligence-v3.md §10.3）。
 *
 * 核心：对具体邮箱做 SMTP RCPT 存在性探测 = 处理该地址的可识别性 → 对**人名邮箱**（personalData）即处理个人数据。
 *  - 🟢 **职能邮箱**（info@ / sales@ …，`kind='role'`）非个人数据（Recital 14）→ 默认自动探测。
 *  - 🔴 **人名邮箱**（max.mustermann@ …，`kind='personal'`）→ 默认**不探测**；仅当
 *      ① 显式给出合法性基础 `lawfulBasis`（LIA / 同意 / 合同），或
 *      ② 显式开关 `allowPersonalWithoutBasis`（仍留痕）
 *    才放行。
 *  - 禁联名单（suppression）命中 → 一律不探测（对外动作第一道检查）。
 *
 * 本模块是**纯逻辑、不触网、不读环境**（env 解析在 {@link resolveEmailVerificationPolicy}），供验证器与服务共用、可单测。
 */

export const LAWFUL_BASIS_KINDS: readonly LawfulBasisKind[] = [
  'legitimate_interest',
  'consent',
  'contract',
  'legal_obligation',
];

export interface EmailVerificationPolicy {
  /** 无 lawfulBasis 时是否允许探测人名邮箱（默认 false）。生产应保持 false，靠逐次显式 basis 放行。 */
  allowPersonalWithoutBasis: boolean;
}

export interface EmailGateDecision {
  /** 是否允许对该地址做网络探测（MX/SMTP）。false ⇒ 验证器直接返回 BLOCKED，不触网。 */
  allowed: boolean;
  kind: 'role' | 'personal' | 'invalid';
  /** 该分级是否需要合法性基础（人名邮箱=true）。 */
  requiresLawfulBasis: boolean;
  /** 机器可读的裁决原因（写入 detail / field_evidence）。 */
  reason: string;
  /** 放行人名邮箱所依据的合法性基础（若有）——透传到 verdict 供留痕。 */
  lawfulBasis?: LawfulBasis;
}

/** lawfulBasis 是否有效（basis 必须是已知类型）。ref/note 可空但强烈建议填 LIA 引用。 */
export function isValidLawfulBasis(b?: LawfulBasis | null): b is LawfulBasis {
  return !!b && (LAWFUL_BASIS_KINDS as readonly string[]).includes(b.basis);
}

/**
 * 给要落库的合法性基础补齐审计的「谁/何时」（缺才补，已填则尊重）。用于任何**将被持久化**的 basis——
 * 无论操作者显式断言的还是开关合成的（`allowPersonalWithoutBasis` 合成的 basis 无 who/when），
 * 都必须带断言人 + 时间，审计才可回溯。纯函数（时间由调用方传入，保持可测/不读时钟）。
 */
export function stampLawfulBasis(basis: LawfulBasis, recordedBy: string, recordedAt: string): LawfulBasis {
  return {
    ...basis,
    recordedBy: basis.recordedBy ?? recordedBy,
    recordedAt: basis.recordedAt ?? recordedAt,
  };
}

/**
 * 从 env + 每次调用的显式开关解析策略。env `EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS=true` 为全局兜底开关，
 * ctx.allowPersonalWithoutBasis 优先（逐次覆盖）。**默认 false**（保守：人名邮箱需显式 basis）。
 */
export function resolveEmailVerificationPolicy(ctx?: EmailVerifyContext): EmailVerificationPolicy {
  const envDefault = /^(1|true|yes)$/i.test(process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS ?? '');
  return { allowPersonalWithoutBasis: ctx?.allowPersonalWithoutBasis ?? envDefault };
}

/**
 * 合规门裁决（纯函数）。分级优先用 ctx.kind，否则用 {@link cleanEmail} 本地部分白名单分级。
 * suppression 命中 > 无效语法 > 职能放行 > 人名（basis / 开关 / 拦截）。
 */
export function evaluateEmailGate(input: {
  email: string;
  kind?: 'role' | 'personal';
  lawfulBasis?: LawfulBasis;
  suppressed?: boolean;
  policy: EmailVerificationPolicy;
}): EmailGateDecision {
  const classified = cleanEmail(input.email);
  const kind = input.kind ?? classified?.kind ?? 'invalid';

  // 禁联名单（deny-list）**永远最先**：先于语法/分级判定。否则畸形但命中禁联的地址会走 invalid
  // 短路→放行，服务层再路由到忽略 ctx 的 sandbox/public_web，可能给禁联地址判非 BLOCKED（Codex P2）。
  if (input.suppressed) {
    return { allowed: false, kind, requiresLawfulBasis: kind === 'personal', reason: 'suppressed' };
  }

  // 无效语法：交给验证器判 INVALID（不探测）；这里不拦，但标 invalid 便于留痕。
  if (kind === 'invalid') {
    return { allowed: true, kind: 'invalid', requiresLawfulBasis: false, reason: 'invalid_syntax' };
  }

  if (kind === 'role') {
    return { allowed: true, kind, requiresLawfulBasis: false, reason: 'role_functional_no_personal_data' };
  }

  // kind === 'personal' —— 处理个人数据，需合法性基础
  if (isValidLawfulBasis(input.lawfulBasis)) {
    return {
      allowed: true,
      kind,
      requiresLawfulBasis: true,
      reason: `personal_with_lawful_basis:${input.lawfulBasis.basis}`,
      lawfulBasis: input.lawfulBasis,
    };
  }
  if (input.policy.allowPersonalWithoutBasis) {
    // 显式开关放行——合成一条 legitimate_interest 依据留痕（note 标明来自开关，供审计追溯）。
    return {
      allowed: true,
      kind,
      requiresLawfulBasis: true,
      reason: 'personal_policy_override',
      lawfulBasis: { basis: 'legitimate_interest', note: 'allowPersonalWithoutBasis switch (no per-record LIA)' },
    };
  }
  return { allowed: false, kind, requiresLawfulBasis: true, reason: 'personal_email_no_lawful_basis' };
}
