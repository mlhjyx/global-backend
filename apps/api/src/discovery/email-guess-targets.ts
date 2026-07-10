import { KnownEmailSample } from './email-format-learning';

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
export const DEFAULT_MAX_GUESS_CONTACTS = 25;

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
