import { ConflictException } from '@nestjs/common';
import { KnownEmailSample } from './email-format-learning';
import {
  MAX_CONTACT_DISCOVERY_ADAPTERS,
  MAX_CONTACTS_PER_DISCOVERY_ADAPTER,
  MAX_EMAIL_GUESS_CONTACTS,
  MAX_EMAIL_PROBE_CANDIDATES,
} from './execution-envelope';

export {
  MAX_CONTACT_DISCOVERY_ADAPTERS,
  MAX_CONTACTS_PER_DISCOVERY_ADAPTER,
  MAX_EMAIL_PROBE_CANDIDATES,
  MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
} from './execution-envelope';

/**
 * 从某公司联系人派生「邮箱猜测目标」的共享纯件（选项 B · P0.4 复审 MEDIUM）：
 * 手动路径 {@link DiscoveryService.guessEmailsForCompany} 与存量阶段⑤b `guessEmailsBacklog`
 * **逐字重复**了「同域非-RISKY 格式样本 + 缺邮箱决策人过滤 + 有界截断」逻辑（漂移风险）→ 抽此单一事实源。
 */

/** 单个联系人的最小画像（用于派生猜测目标）：具名 + 其 contact_points。 */
export interface GuessTargetContact {
  id: string;
  fullName: string;
  contactPoints: { type: string; value: string; status: string }[];
}

/** 从某公司联系人派生的猜测目标。 */
export interface GuessTargets {
  /** 同域已知**非-RISKY** 邮箱样本（格式学习，全公司合并，不截断）。 */
  knownSamples: KnownEmailSample[];
  /** 缺 email 决策人（补全对象），已按 maxContacts **有界截断**（SMTP 扇出护栏）。 */
  emailless: { contactId: string; fullName: string }[];
  /** 缺邮箱决策人**总数**（截断前）——供 summary 报告「共 N 位、探测前 M 位」，与 emailless.length 区分。 */
  emaillessTotal: number;
}

/** 每公司最多补全的缺邮箱决策人数（SMTP 扇出护栏；手动路径与 backlog 阶段⑤b 共用）。 */
export const DEFAULT_MAX_GUESS_CONTACTS = MAX_EMAIL_GUESS_CONTACTS;

class ExecutionBudgetEnvelopeExceededException extends ConflictException {
  readonly code = 'EXECUTION_BUDGET_ENVELOPE_EXCEEDED';

  constructor() {
    super({
      error: {
        code: 'EXECUTION_BUDGET_ENVELOPE_EXCEEDED',
        message: 'technical execution budget envelope exceeded',
      },
    });
  }
}

function executionBudgetEnvelopeExceeded(): never {
  throw new ExecutionBudgetEnvelopeExceededException();
}

function assertRequestedBound(value: number | undefined, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > maximum) executionBudgetEnvelopeExceeded();
}

/** 核心服务边界的联系人 adapter fan-out 闸门；必须在任何 adapter 外联前调用。 */
export function assertContactDiscoveryAdapterFanout(adapterCount: number): void {
  if (!Number.isInteger(adapterCount) || adapterCount < 0 || adapterCount > MAX_CONTACT_DISCOVERY_ADAPTERS) {
    executionBudgetEnvelopeExceeded();
  }
}

/** adapter 响应进入联系人持久化前的记录数闸门。 */
export function assertContactDiscoveryResultBound(contactCount: number): void {
  if (!Number.isInteger(contactCount) || contactCount < 0 || contactCount > MAX_CONTACTS_PER_DISCOVERY_ADAPTER) {
    executionBudgetEnvelopeExceeded();
  }
}

/** 供 service 旁路与纯 target 派生共同复用的每公司猜测联系人上界。 */
export function assertEmailGuessContactBound(maxContacts: number | undefined): void {
  assertRequestedBound(maxContacts, DEFAULT_MAX_GUESS_CONTACTS);
}

/** 供 service 旁路与 EmailGuesser 共同复用的每联系人 SMTP probe 上界。 */
export function assertEmailProbeBound(maxProbe: number | undefined): void {
  assertRequestedBound(maxProbe, MAX_EMAIL_PROBE_CANDIDATES);
}

/**
 * 从某公司联系人派生「格式学习样本（同域非-RISKY）+ 缺 email 决策人（有界）」。纯函数、可测。
 * 🔴 RISKY 排除是合规/质量约束（不拿本器自己未证实的猜测污染后续候选命名法）；
 *    cap 是 SMTP 扇出护栏——防单公司几十位缺邮箱决策人 × maxProbe 让单活动超 startToCloseTimeout、
 *    收尾水位 stamp 不执行 → 水位恒 null → 每 sweep 重锤同批 MX（30d 防锤水位失效）。
 */
export function buildGuessTargets(
  contacts: GuessTargetContact[],
  domain: string,
  maxContacts: number = DEFAULT_MAX_GUESS_CONTACTS,
): GuessTargets {
  assertEmailGuessContactBound(maxContacts);
  const dom = domain.toLowerCase();
  const knownSamples: KnownEmailSample[] = contacts.flatMap((c) =>
    c.contactPoints
      .filter((p) => p.type === 'email' && p.status !== 'RISKY' && p.value.split('@')[1]?.toLowerCase() === dom)
      .map((p) => ({ fullName: c.fullName, email: p.value })),
  );
  const emaillessAll = contacts
    .filter((c) => !c.contactPoints.some((p) => p.type === 'email'))
    .map((c) => ({ contactId: c.id, fullName: c.fullName }));
  return { knownSamples, emailless: emaillessAll.slice(0, maxContacts), emaillessTotal: emaillessAll.length };
}
