import { Prisma } from '@prisma/client';
import { contactIdentity } from './identity';
import { resolvePersonIdentity, PersonResolveHit } from './person-identity';
import { ProviderContactRecord } from './provider-contract';

export interface PersistDiscoveredContactsArgs {
  workspaceId: string;
  company: { id: string; dedupeKey: string };
  adapterKey: string;
  contacts: ProviderContactRecord[];
  suppressedEmails: Set<string>;
}

/**
 * 联系人发现结果的共享持久化（被 DiscoveryService.discoverContacts 与
 * discoverContactsBacklog 复用——写入语义必须一致，故抽出）：
 *  - Suppression 前置（PRD 12.6 最小化：被禁邮箱直接不入库）；
 *  - **解析前置**（选项 B 待办 2）：resolvePersonIdentity 先问「本公司是否已有同一人」——
 *    命中 → 并入现有联系人（不新建，补空不覆盖 + 写 identity.merge 证据）；未中 → 按
 *    contactIdentity 键（键形不变，零迁移）新建；
 *  - contact_point 按 (contact, type, value) 幂等；逐点 field_evidence 留痕；
 *  - 🔴 具名人（personalData=true）额外写 person.profile 证据（买家角色/来源页/
 *    personal_data 标记），allowedActions 不含 outreach——触达前必须过合规门。
 *
 * 事务纪律：全程在 tx 内、无网络。批内 contact 顺序处理，同一 tx 内 resolve 能看到前面刚插入的行
 * （天然去重批内重复）。
 */
export async function persistDiscoveredContacts(
  tx: Prisma.TransactionClient,
  args: PersistDiscoveredContactsArgs,
): Promise<{ created: number; merged: number; skippedSuppressed: number }> {
  let created = 0;
  let merged = 0;
  let skippedSuppressed = 0;
  for (const c of args.contacts) {
    const email = c.email?.toLowerCase();
    if (email && args.suppressedEmails.has(email)) {
      skippedSuppressed += 1;
      continue;
    }
    // 解析前置：本公司是否已有同一人（同 companyId 内分层匹配）？
    const hit = await resolvePersonIdentity(tx, {
      workspaceId: args.workspaceId,
      companyId: args.company.id,
      companyKey: args.company.dedupeKey,
      fullName: c.fullName,
      email,
    });
    const contactId = hit
      ? await mergeIntoContact(tx, args, c, hit)
      : await createContact(tx, args, c, email);

    const points: { type: string; value?: string }[] = [
      { type: 'email', value: email },
      { type: 'phone', value: c.phone },
      { type: 'linkedin', value: c.linkedin },
    ];
    for (const p of points) {
      if (!p.value) continue;
      await tx.contactPoint.upsert({
        where: { contactId_type_value: { contactId, type: p.type, value: p.value } },
        update: {},
        create: { workspaceId: args.workspaceId, contactId, type: p.type, value: p.value },
      });
      await tx.fieldEvidence.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'contact',
          entityId: contactId,
          field: p.type,
          value: p.value as unknown as Prisma.InputJsonValue,
          providerKey: args.adapterKey,
          license: args.adapterKey === 'sandbox' ? 'sandbox' : 'licensed',
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
        },
      });
    }
    // 🔴 具名人侧写留痕（GDPR：个人数据默认隔离，触达前过 lawful-basis 门）
    if (c.personalData) {
      await tx.fieldEvidence.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'contact',
          entityId: contactId,
          field: 'person.profile',
          value: {
            personal_data: true,
            buying_role: c.buyingRole ?? null,
            is_target_role: c.isTargetRole ?? null,
            source_page: c.sourcePage ?? null,
          } as unknown as Prisma.InputJsonValue,
          providerKey: args.adapterKey,
          license: 'public',
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
        },
      });
    }
    if (hit) merged += 1;
    else created += 1;
  }
  return { created, merged, skippedSuppressed };
}

/** 新建路径（resolve 未命中）：按 contactIdentity 键 upsert（键形不变，零迁移）。 */
async function createContact(
  tx: Prisma.TransactionClient,
  args: PersistDiscoveredContactsArgs,
  c: ProviderContactRecord,
  email: string | undefined,
): Promise<string> {
  const dedupeKey = contactIdentity({ fullName: c.fullName, email }, args.company.dedupeKey);
  const contact = await tx.canonicalContact.upsert({
    where: { workspaceId_dedupeKey: { workspaceId: args.workspaceId, dedupeKey } },
    update: {
      ...(c.title ? { title: c.title } : {}),
      ...(c.seniority ? { seniority: c.seniority } : {}),
      ...(c.department ? { department: c.department } : {}),
    },
    create: {
      workspaceId: args.workspaceId,
      companyId: args.company.id,
      fullName: c.fullName,
      title: c.title ?? null,
      seniority: c.seniority ?? null,
      department: c.department ?? null,
      dedupeKey,
    },
  });
  return contact.id;
}

/**
 * 并入路径（resolve 命中）：不新建，把新信息挂到既有联系人。
 * title/seniority/department **有则补空、绝不覆盖已有非空**（immutable 更新语义）；
 * 写一条 identity.merge 证据（可审计、可回溯误并，照 identity_link.match_rule 先例，零迁移）。
 */
async function mergeIntoContact(
  tx: Prisma.TransactionClient,
  args: PersistDiscoveredContactsArgs,
  c: ProviderContactRecord,
  hit: PersonResolveHit,
): Promise<string> {
  const contactId = hit.contactId;
  const existing = await tx.canonicalContact.findUnique({
    where: { id: contactId },
    select: { title: true, seniority: true, department: true },
  });
  const patch: Prisma.CanonicalContactUpdateInput = {};
  if (c.title && !existing?.title) patch.title = c.title;
  if (c.seniority && !existing?.seniority) patch.seniority = c.seniority;
  if (c.department && !existing?.department) patch.department = c.department;
  if (Object.keys(patch).length > 0) {
    await tx.canonicalContact.update({ where: { id: contactId }, data: patch });
  }
  await tx.fieldEvidence.create({
    data: {
      workspaceId: args.workspaceId,
      entityType: 'contact',
      entityId: contactId,
      field: 'identity.merge',
      value: {
        match_rule: hit.matchRule,
        matched_from: args.adapterKey,
        ...(hit.score != null ? { score: hit.score } : {}),
      } as unknown as Prisma.InputJsonValue,
      providerKey: args.adapterKey,
      license: args.adapterKey === 'sandbox' ? 'sandbox' : 'licensed',
      allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
    },
  });
  return contactId;
}
