import { DeletionSubjectType, SuppressionEntry } from './deletion.types';

/**
 * 冻结阶段禁联项构造（收口⑥ PR-B，纯）。删除前先写这些 suppression_record，删除后**保留**=
 * 法定最小禁联（Art.17 擦除 / Art.21 反对后不得再入库/再触达该主体）。全部小写、去重。
 */
export function buildSuppressionEntries(args: {
  subjectType: DeletionSubjectType;
  emails: string[];
  domain?: string | null;
  companyName?: string | null;
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
  return entries;
}
