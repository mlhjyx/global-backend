/**
 * P1（contacts 工程）· contact_point 四态纯函数面。
 *
 * 四态（VALID / INVALID / CATCH_ALL_RISKY / UNKNOWN）是**证据组合的裁决**，不是验证器
 * 的返回码：判定矩阵与状态机见《GainOS 深化计划 v3.0》第 2 章 §2.3.2.1 / §2.3.2.2。
 *
 * `contact_point.status` 保留为 legacy 投影（UNVERIFIED/VALID/RISKY/INVALID），读侧逐步
 * 迁移。写入侧的现实契约（本波）：验证路径按 {@link projectLegacyStatus} 投影写；
 * 猜测管线保留其既有 `RISKY`/`UNVERIFIED` 保守语义（弱证据重新观测会把行降级——这是该
 * 管线的既有产品行为，不改写）；BLOCKED 是「本次尝试的合规处置」，不是四态之一——它只进
 * 事件账（verdict=blocked），不改 verification_state，但旧列仍写 BLOCKED 供既有读侧保守。
 *
 * 本模块不读环境、不触网、不碰数据库：迁移回填 CASE、三处写入路径与再验证编排共用同一
 * 套映射，纯函数单测覆盖全部转换分支。
 */

/** 四态词表（与迁移 20261109120000 的 CHECK 约束逐字一致）。 */
export const EMAIL_VERIFICATION_STATES = ['VALID', 'INVALID', 'CATCH_ALL_RISKY', 'UNKNOWN'] as const;
export type EmailVerificationState = (typeof EMAIL_VERIFICATION_STATES)[number];

/** catch-all 子类词表（true_catch_all / unprobeable_provider 是两种不同风险来源）。 */
export const CATCH_ALL_CLASSES = [
  'true_catch_all',
  'unprobeable_provider',
  'inconclusive',
  'not_catch_all',
  'unknown',
] as const;
export type CatchAllClass = (typeof CATCH_ALL_CLASSES)[number];

/** contact_point.status 的 legacy 词表。 */
export type LegacyPointStatus = 'VALID' | 'RISKY' | 'INVALID' | 'UNVERIFIED';

/** 验证器裁决（现有 EmailVerdict.status 的词表）。 */
export type EmailVerdictStatus = 'VALID' | 'RISKY' | 'INVALID' | 'BLOCKED';

/** 事件账 verdict 词表（contact_point_verification_event.cpve_verdict_check）。 */
export type VerificationEventVerdict = 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'blocked' | 'error';

/** 四态 → legacy status（写入器每次落状态时同步维护旧列，读侧暂不改）。 */
export function projectLegacyStatus(state: EmailVerificationState): LegacyPointStatus {
  switch (state) {
    case 'VALID':
      return 'VALID';
    case 'INVALID':
      return 'INVALID';
    case 'CATCH_ALL_RISKY':
      return 'RISKY';
    case 'UNKNOWN':
      return 'UNVERIFIED';
    default:
      // 运行时兜底：DB CHECK 之外的脏值按「未验证」处理，绝不返回 undefined。
      return 'UNVERIFIED';
  }
}

/**
 * 迁移回填口径：legacy status + catch_all → 四态。
 *
 * - RISKY **只有** catch_all='catch_all' 才进 CATCH_ALL_RISKY；其余 RISKY（未验证/不可达/
 *   反枚举）一律 UNKNOWN——把 RISKY 读成「劣质」是错误的，它更常见的读法是「未验证」。
 * - 未知值回退 UNKNOWN：回填不得因脏值中断。
 * - 迁移 SQL 的 CASE 与本函数逐分支一致（静态契约由 migration spec 钉住）。
 */
export function legacyStatusToState(
  status: string | null | undefined,
  catchAll: string | null | undefined,
): EmailVerificationState {
  switch (status) {
    case 'VALID':
      return 'VALID';
    case 'INVALID':
      return 'INVALID';
    case 'RISKY':
      return catchAll === 'catch_all' ? 'CATCH_ALL_RISKY' : 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}

/**
 * 验证器裁决 → 四态。BLOCKED（合规门拦截）返回 null：状态不变，只记事件。
 *
 * RISKY 的细分（与 email-verify.provider.ts 的 detail 文案逐字对齐）：
 *  - 反枚举 provider（M365/GWS/…）→ CATCH_ALL_RISKY·unprobeable_provider
 *  - 真 catch-all 域 → CATCH_ALL_RISKY·true_catch_all
 *  - RCPT 接受但 catch-all 未证伪 → CATCH_ALL_RISKY·inconclusive
 *  - 不可达 / MAIL FROM 被拒 / source_policy 拒绝 / 结果不决 → UNKNOWN（进重验队列）
 */
export function stateFromEmailVerdict(
  status: EmailVerdictStatus,
  detail: string | null | undefined,
): EmailVerificationState | null {
  switch (status) {
    case 'VALID':
      return 'VALID';
    case 'INVALID':
      return 'INVALID';
    case 'BLOCKED':
      return null;
    case 'RISKY': {
      const catchAllClass = catchAllClassFromEmailVerdictDetail(detail);
      return catchAllClass === 'unprobeable_provider' ||
        catchAllClass === 'true_catch_all' ||
        catchAllClass === 'inconclusive'
        ? 'CATCH_ALL_RISKY'
        : 'UNKNOWN';
    }
    default:
      return 'UNKNOWN';
  }
}

/** 四态 catch-all 子类 → A4 的 catch_all 三态/unknown（写回 legacy 列）。 */
export function legacyCatchAllFromClass(
  catchAllClass: CatchAllClass | null | undefined,
): 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown' {
  switch (catchAllClass) {
    case 'true_catch_all':
      return 'catch_all';
    case 'not_catch_all':
      return 'not_catch_all';
    case 'inconclusive':
      return 'inconclusive';
    default:
      return 'unknown';
  }
}

/** 验证器 detail → catch-all 子类（非 RISKY 相关 detail 返回 null）。 */
export function catchAllClassFromEmailVerdictDetail(
  detail: string | null | undefined,
): CatchAllClass | null {
  if (!detail) return null;
  if (detail.startsWith('provider_anti_enumeration:')) return 'unprobeable_provider';
  if (detail === 'catch_all_domain') return 'true_catch_all';
  if (detail === 'catch_all_unproven') return 'inconclusive';
  if (detail.startsWith('smtp_accepted')) return 'not_catch_all';
  return null;
}

/**
 * verdict.detail → 验证方式：只有产生 RCPT/域级结论的 detail 才算 smtp_rcpt；反枚举短路/
 * 不可达/MAIL FROM 被拒等**未触网**的结论记 pattern_guess（与 email.guess 证据同一口径）。
 */
export function verificationMethodFromVerdictDetail(
  detail: string | null | undefined,
): 'smtp_rcpt' | 'pattern_guess' {
  if (!detail) return 'pattern_guess';
  return /^(smtp_accepted|catch_all_domain|catch_all_unproven|inconclusive)/u.test(detail)
    ? 'smtp_rcpt'
    : 'pattern_guess';
}

/**
 * verdict.detail → A4 legacy catch_all 三态（写回旧列）。注意与
 * {@link catchAllClassFromEmailVerdictDetail}（四态子类）的口径差异：RCPT 结果不决
 * （`inconclusive:*`）在旧列记 `inconclusive`，在四态子类则不构成 catch-all 证据（null → UNKNOWN）。
 */
export function catchAllFromVerdictDetail(
  detail: string | null | undefined,
): 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown' {
  if (!detail) return 'unknown';
  if (detail === 'catch_all_domain') return 'catch_all';
  if (detail.startsWith('smtp_accepted')) return 'not_catch_all';
  if (detail === 'catch_all_unproven' || detail.startsWith('inconclusive')) return 'inconclusive';
  return 'unknown';
}

/** 验证器裁决 → 事件账 verdict（BLOCKED 也记账：合规拦截同样是验证事实）。 */
export function eventVerdictFromEmailVerdict(
  status: EmailVerdictStatus,
  detail: string | null | undefined,
): VerificationEventVerdict {
  switch (status) {
    case 'VALID':
      return 'valid';
    case 'INVALID':
      return 'invalid';
    case 'BLOCKED':
      return 'blocked';
    case 'RISKY':
      return stateFromEmailVerdict('RISKY', detail) === 'CATCH_ALL_RISKY' ? 'catch_all' : 'unknown';
    default:
      return 'unknown';
  }
}

/** 四态基础置信分（0–100；排序与灰度分层的输入，不是可发性的判据）。 */
export function confidenceForState(state: EmailVerificationState): number {
  switch (state) {
    case 'VALID':
      return 95;
    case 'CATCH_ALL_RISKY':
      return 55;
    case 'UNKNOWN':
      return 20;
    case 'INVALID':
      return 0;
    default:
      return 20;
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 下一次重验时间：
 *  - UNKNOWN：72h 内重试（研究支持 1–2 次有界重试）；
 *  - VALID / CATCH_ALL_RISKY：90 天 TTL（邮箱年衰减 ~22.5%，90 天刷新）；
 *  - INVALID：终态，不再排期。
 */
export function nextReverifyAtForState(state: EmailVerificationState, now: Date): Date | null {
  switch (state) {
    case 'UNKNOWN':
      return new Date(now.getTime() + 3 * DAY_MS);
    case 'VALID':
    case 'CATCH_ALL_RISKY':
      return new Date(now.getTime() + 90 * DAY_MS);
    case 'INVALID':
      return null;
    default:
      return new Date(now.getTime() + 3 * DAY_MS);
  }
}

export interface VerificationStateSnapshot {
  state: EmailVerificationState;
  validSince: Date | null;
  /** 现有排期（blocked 事件不改它）。 */
  nextReverifyAt?: Date | null;
}

export interface VerificationTransitionEvent {
  verdict: VerificationEventVerdict;
  /** catch_all 事件建议的子类（缺省 unknown）。 */
  catchAllClass?: CatchAllClass | null;
  /** 人工推翻 INVALID（带证据），仅 operator 事件可置 true。 */
  operatorOverride?: boolean;
}

export interface VerificationTransition {
  state: EmailVerificationState;
  previousState: EmailVerificationState;
  validSince: Date | null;
  /** undefined = 维持现值的子类（调用方决定是否覆盖列）。 */
  catchAllClass: CatchAllClass | null | undefined;
  /** 最近一次验证尝试时间（verified_at 语义沿用现状）。 */
  verifiedAt: Date;
  nextReverifyAt: Date | null;
  confidence: number;
  /** 四态或 valid_since 是否发生变化（verified_at 的刷新不算变化）。 */
  changed: boolean;
}

/**
 * 状态机（2.3.2.2 转换表的唯一实现）。硬规则：
 *  - BLOCKED 不改状态（合规处置只进事件账）；
 *  - INVALID 粘性：验证器事件不得推翻，只有 operatorOverride 可以；
 *  - VALID 复验 unknown/error 不降级发送资格（重验失败才降）；
 *  - 进入 VALID 记 valid_since，离开清空；VALID→VALID 保留原 valid_since。
 */
export function transitionVerificationState(
  current: VerificationStateSnapshot,
  event: VerificationTransitionEvent,
  now: Date,
): VerificationTransition {
  const unchanged = (extra?: Partial<VerificationTransition>): VerificationTransition => ({
    state: current.state,
    previousState: current.state,
    validSince: current.validSince,
    catchAllClass: undefined,
    verifiedAt: now,
    nextReverifyAt: current.nextReverifyAt ?? null,
    confidence: confidenceForState(current.state),
    changed: false,
    ...extra,
  });

  if (event.verdict === 'blocked') return unchanged();

  if (current.state === 'INVALID' && !(event.verdict === 'valid' && event.operatorOverride)) {
    return unchanged({ nextReverifyAt: null });
  }

  switch (event.verdict) {
    case 'valid': {
      const validSince = current.state === 'VALID' ? current.validSince : now;
      const changed =
        current.state !== 'VALID' || current.validSince?.getTime() !== validSince?.getTime();
      return {
        state: 'VALID',
        previousState: current.state,
        validSince,
        catchAllClass: undefined,
        verifiedAt: now,
        nextReverifyAt: nextReverifyAtForState('VALID', now),
        confidence: confidenceForState('VALID'),
        changed,
      };
    }
    case 'invalid':
      return {
        state: 'INVALID',
        previousState: current.state,
        validSince: null,
        catchAllClass: undefined,
        verifiedAt: now,
        nextReverifyAt: null,
        confidence: confidenceForState('INVALID'),
        changed: current.state !== 'INVALID',
      };
    case 'catch_all': {
      const changed = current.state !== 'CATCH_ALL_RISKY';
      return {
        state: 'CATCH_ALL_RISKY',
        previousState: current.state,
        validSince: null,
        catchAllClass: event.catchAllClass ?? 'unknown',
        verifiedAt: now,
        nextReverifyAt: nextReverifyAtForState('CATCH_ALL_RISKY', now),
        confidence: confidenceForState('CATCH_ALL_RISKY'),
        changed,
      };
    }
    case 'unknown':
    case 'error':
      // VALID 不因一次重验失败（超时/限流）失去发送资格，但也不把排期推到 90 天后——
      // 重验本身失败说明「这次没验成」，72h 后重试（与 UNKNOWN 队列同节奏）。
      return unchanged({ nextReverifyAt: new Date(now.getTime() + 72 * HOUR_MS) });
    default:
      // 运行时兜底：未知事件不改变状态（与 unknown/error 同处置）。
      return unchanged({ nextReverifyAt: new Date(now.getTime() + 72 * HOUR_MS) });
  }
}

/** 一次转换 → contact_point 的写库列（含 legacy status 投影；验证写入方共用）。 */
export function verifiedAtStateColumns(
  transition: VerificationTransition,
): {
  verificationState: EmailVerificationState;
  status: LegacyPointStatus;
  validSince: Date | null;
  verifiedAt: Date;
  nextReverifyAt: Date | null;
  confidence: number;
} {
  return {
    verificationState: transition.state,
    status: projectLegacyStatus(transition.state),
    validSince: transition.validSince,
    verifiedAt: transition.verifiedAt,
    nextReverifyAt: transition.nextReverifyAt,
    confidence: transition.confidence,
  };
}

/** 邮箱地址 → 规范化域（小写、去尾点）；无 @ 或无有效域 → null。域盲索引的输入。 */
export function emailDomainOfAddress(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.+$/u, '');
  return domain.includes('.') ? domain : null;
}

/** 联系人观察的来源分类（替代 2026-11 前的一刀切 `provider`；映射表见计划 §2.3.2.5）。 */
export type ContactObservationSourceType =
  | 'impressum'
  | 'contact_page'
  | 'homepage'
  | 'directory'
  | 'social'
  | 'pattern_guess'
  | 'operator'
  | 'provider';

const IMPRESSUM_PATH = /\/(impressum|imprint|impressum-und-datenschutz|mentions-legales|legal-notice|aviso-legal)(\/|$)/iu;
const CONTACT_PAGE_PATH = /\/(team|people|kontakt|contact|contact-us|about-us\/team|leadership|management|ueber-uns|a-propos)(\/|$)/iu;

export function sourceTypeForContactObservation(input: {
  adapterKey: string;
  sourcePage?: string | null;
}): ContactObservationSourceType {
  const { adapterKey, sourcePage } = input;
  switch (adapterKey) {
    case 'social_presence':
      return 'social';
    case 'companies_house':
    case 'inpi_rne':
    case 'google_patents':
      return 'directory';
    case 'email_guess':
      return 'pattern_guess';
    case 'operator':
      return 'operator';
    case 'decision_maker':
    case 'public_web':
    case 'directory': {
      if (!sourcePage) return 'homepage';
      let pathname: string;
      try {
        pathname = new URL(sourcePage).pathname;
        // pathname 保留百分号编码（/über-uns → /%C3%BCber-uns）；解码后再匹配词表。
        pathname = decodeURIComponent(pathname);
      } catch {
        return 'homepage';
      }
      if (IMPRESSUM_PATH.test(pathname)) return 'impressum';
      if (CONTACT_PAGE_PATH.test(pathname)) return 'contact_page';
      return 'homepage';
    }
    default:
      return 'provider';
  }
}
