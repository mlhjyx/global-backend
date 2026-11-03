/**
 * 个人数据访问/物化审计（2026-11-04 决策 Q25：取消租户声明的补偿控制）。
 *
 * 每次访问或物化个人数据写一行审计：谁（actorId/actorKind）、何时（createdAt）、
 * 哪家公司（companyId）、哪些字段类（fieldClasses）、什么用途（purpose）。
 * 保留 180 天，由 `expire_personal_data_access_audit_v1` 在 raw-retention sweep 中清理。
 *
 * 🔴 内容最小化：只记主体计数与字段类别，绝不存字段值、人名或邮箱明文；
 *    写路径必须传 tx（与物化同事务）或 withWorkspace 作用域内的客户端，RLS 才成立。
 */
import type { Prisma } from '@prisma/client';

export const PERSONAL_DATA_ACCESS_RETENTION_DAYS = 180;

export const PERSONAL_DATA_FIELD_CLASSES = [
  'person_name',
  'job_title',
  'email',
  'phone',
  'linkedin',
  'contact_path',
] as const;
export type PersonalDataFieldClass = (typeof PERSONAL_DATA_FIELD_CLASSES)[number];

export type PersonalDataAccessActorKind = 'user' | 'system' | 'platform';

export type PersonalDataAccessPurpose =
  | 'contact_discovery'
  | 'email_guess'
  | 'email_verification'
  | 'run_contact_materialization'
  | 'run_email_guess';

export interface PersonalDataAccessAuditInput {
  workspaceId: string;
  /** 断言访问的人/进程：用户 id，或 `discovery-run:<runId>` 之类的系统主体。 */
  actorId: string;
  actorKind: PersonalDataAccessActorKind;
  purpose: PersonalDataAccessPurpose;
  companyId?: string | null;
  fieldClasses: readonly PersonalDataFieldClass[];
  /** 涉及的自然人/联系方式条数（只记数量，不记值）。 */
  subjectCount: number;
  lawfulBasisRef?: string | null;
  /** 归因键：runId / attemptId / 请求 id。 */
  correlationId?: string | null;
}

/** 与 Prisma 事务客户端结构一致（store 只用 create）；测试可用 `as never` 传假体。 */
export type PersonalDataAccessAuditClient = Pick<
  Prisma.TransactionClient,
  'personalDataAccessAudit'
>;

/** 引擎输入不可信：压成单行、去控制字符、按列宽截断；空串返回 null。 */
function boundedText(value: string | null | undefined, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  const flattened = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  const cleaned = flattened.replace(/\s+/gu, ' ').trim().slice(0, maximum);
  return cleaned.length > 0 ? cleaned : null;
}

/** 从落库的联系人行推导字段类（只读字段类型，不读值）。 */
export function fieldClassesForContacts(
  contacts: ReadonlyArray<{
    title?: string | null;
    contactPoints?: ReadonlyArray<{ type: string }>;
  }>,
): PersonalDataFieldClass[] {
  const present = new Set<PersonalDataFieldClass>(['person_name']);
  for (const contact of contacts) {
    if (contact.title) present.add('job_title');
    for (const point of contact.contactPoints ?? []) {
      if (point.type === 'email') present.add('email');
      else if (point.type === 'phone') present.add('phone');
      else if (point.type === 'linkedin') present.add('linkedin');
    }
  }
  return PERSONAL_DATA_FIELD_CLASSES.filter((fieldClass) => present.has(fieldClass));
}

/**
 * 写一行访问审计。调用方负责事务边界：HTTP 路径用 `prisma.withWorkspace`，
 * run 物化路径直接传持久化事务，保证「物化了却无审计」不出现。
 */
export async function recordPersonalDataAccess(
  client: PersonalDataAccessAuditClient,
  input: PersonalDataAccessAuditInput,
): Promise<void> {
  const fieldClasses = [...new Set(input.fieldClasses)].slice(0, 16);
  await client.personalDataAccessAudit.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: boundedText(input.actorId, 200) ?? 'unknown',
      actorKind: input.actorKind,
      purpose: input.purpose,
      companyId: input.companyId ?? null,
      fieldClasses: fieldClasses.length > 0 ? fieldClasses : ['person_name'],
      subjectCount: Math.max(0, Math.min(Math.trunc(input.subjectCount), 1_000_000)),
      lawfulBasisRef: boundedText(input.lawfulBasisRef, 512),
      correlationId: boundedText(input.correlationId, 200),
    },
  });
}
