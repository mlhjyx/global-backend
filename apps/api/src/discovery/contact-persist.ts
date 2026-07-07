import { Prisma } from '@prisma/client';
import { contactIdentity } from './identity';
import { ProviderContactRecord } from './provider-contract';

/**
 * 联系人发现结果的共享持久化（被 DiscoveryService.discoverContacts 与
 * discoverContactsBacklog 复用——写入语义必须一致，故抽出）：
 *  - Suppression 前置（PRD 12.6 最小化：被禁邮箱直接不入库）；
 *  - canonical_contact 按 (workspace, dedupeKey) upsert（后到只补缺）；
 *  - contact_point 按 (contact, type, value) 幂等；逐点 field_evidence 留痕；
 *  - 🔴 具名人（personalData=true）额外写 person.profile 证据（买家角色/来源页/
 *    personal_data 标记），allowedActions 不含 outreach——触达前必须过合规门。
 */
export async function persistDiscoveredContacts(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    company: { id: string; dedupeKey: string };
    adapterKey: string;
    contacts: ProviderContactRecord[];
    suppressedEmails: Set<string>;
  },
): Promise<{ created: number; skippedSuppressed: number }> {
  let created = 0;
  let skippedSuppressed = 0;
  for (const c of args.contacts) {
    const email = c.email?.toLowerCase();
    if (email && args.suppressedEmails.has(email)) {
      skippedSuppressed += 1;
      continue;
    }
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
    const points: { type: string; value?: string }[] = [
      { type: 'email', value: email },
      { type: 'phone', value: c.phone },
      { type: 'linkedin', value: c.linkedin },
    ];
    for (const p of points) {
      if (!p.value) continue;
      await tx.contactPoint.upsert({
        where: { contactId_type_value: { contactId: contact.id, type: p.type, value: p.value } },
        update: {},
        create: { workspaceId: args.workspaceId, contactId: contact.id, type: p.type, value: p.value },
      });
      await tx.fieldEvidence.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'contact',
          entityId: contact.id,
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
          entityId: contact.id,
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
    created += 1;
  }
  return { created, skippedSuppressed };
}
