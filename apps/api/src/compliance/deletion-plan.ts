import { DeletionSubjectType, SuppressionEntry } from './deletion.types';
import { contactSuppressionKeys } from '../discovery/identity';
import { blindContactKey } from './pii-crypto';

/**
 * 冻结阶段禁联项构造（收口⑥ PR-B，纯）。删除前先写这些 suppression_record，删除后**保留**=
 * 法定最小禁联（Art.17 擦除 / Art.21 反对后不得再入库/再触达该主体）。全部小写、去重。
 */
export function buildSuppressionEntries(args: {
  subjectType: DeletionSubjectType;
  emails: string[];
  domain?: string | null;
  companyName?: string | null;
  // contact 主体：具名人 + 其所属公司的 dedupeKey → person-level 禁联键（Codex P1「Add a person-level
  // suppression」）。二者齐备才写；缺省保持旧行为（只邮箱），向后兼容。
  contactName?: string | null;
  companyKey?: string | null;
}): SuppressionEntry[] {
  const entries: SuppressionEntry[] = [];
  const seen = new Set<string>();
  const push = (type: SuppressionEntry['type'], raw: string): void => {
    const value = raw.trim().toLowerCase();
    if (!value) return;
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ type, value, reason: 'legal' });
  };
  for (const e of args.emails) push('email', e);
  // company 主体：额外冻结整域 + 公司名；contact 主体**只**冻结其本人邮箱（绝不误冻整公司）。
  if (args.subjectType === 'company') {
    if (args.domain) push('domain', args.domain);
    if (args.companyName) push('company_name', args.companyName);
  }
  // contact 主体：写 person-level 禁联键**集**——被擦除的具名人日后即便以**不同邮箱/无邮箱**（仅电话/LinkedIn）
  // **或跨源不同拼写**（变音丢弃/德语 ASCII/分解 Unicode/"Surname,Given" 语序）被重新发现，persistDiscoveredContacts
  // 也命中禁联而不重建（此前只按单一归一形 → 拼写变体即漏）。键 = blind(HMAC) 后的 `c:<companyKey>:<归一名变体>`
  //（{@link contactSuppressionKeys}，与创建闸/对账**同构**），🔴 盲化后落库=禁联表不存人名明文；push 去重多变体重叠。
  if (args.subjectType === 'contact' && args.contactName && args.companyKey) {
    for (const rawKey of contactSuppressionKeys(args.contactName, args.companyKey)) {
      push('contact_key', blindContactKey(rawKey));
    }
  }
  return entries;
}

/**
 * Art.17 contact 主体擦除的**有界对账选择器**（纯）——收口 PR #80 复审 CONFIRMED 的残留并发窗口。
 * 见 docs/implementation-records/deletion-art17-residual-window.md。
 *
 * 从候选联系人里挑出「重物化被擦除自然人」的行：候选的 person-key **变体集**与被擦除人的变体集**有交集**
 *（`contactSuppressionKeys(fullName, companyKey)` 盲化后，与创建闸/冻结**同构**——含变音丢弃/德语 ASCII/
 * 分解 Unicode/"Surname,Given" 语序变体，故被擦除人以任一拼写变体重物化都被捕获）**且** `createdAt >= since`。
 *
 * 🔴 `since`（= `deletion_request.createdAt`）过滤是与 PR #80 **驳回的无界 sweep** 的关键差异：
 * 只触碰 **DSR 受理后新建**的行；先于 DSR 就存在的**同名另一真人**（`createdAt < since`）绝不入选——
 * 杜绝数据丢失。窗口内被选的同名新行 = 创建闸在顺序情形下本就会拒建者，净数据态一致。
 *
 * @param erasedName 被擦除人的明文全名（读路径解密后）——内部经 {@link contactSuppressionKeys} 算变体集
 * @param companyKey 属主公司 dedupeKey（与冻结所用一致）
 * @param since 只有 createdAt >= 此刻的候选才入选（含边界）
 * @param candidates 属主公司下的候选（fullName 须为读路径解密后的明文）
 */
export function selectReconcileStragglerIds(args: {
  erasedName: string;
  companyKey: string;
  since: Date;
  candidates: { id: string; fullName: string; createdAt: Date }[];
}): string[] {
  const targets = new Set(
    contactSuppressionKeys(args.erasedName, args.companyKey).map((k) => blindContactKey(k).toLowerCase()),
  );
  if (targets.size === 0) return [];
  const sinceMs = args.since.getTime();
  return args.candidates
    .filter((c) => {
      if (c.createdAt.getTime() < sinceMs) return false;
      return contactSuppressionKeys(c.fullName, args.companyKey).some((k) =>
        targets.has(blindContactKey(k).toLowerCase()),
      );
    })
    .map((c) => c.id);
}
