import { Prisma } from '@prisma/client';
import { contactIdentity, declinedContactIdentity } from './identity';
import { resolvePersonIdentity, PersonResolveHit } from './person-identity';
import { ProviderContactRecord } from './provider-contract';
import { encryptPii, blindContactKey } from '../compliance/pii-crypto';
import { cleanEmail } from '../acquisition/clean';

/** field_evidence 的 email 值分级：职能邮箱 amber（ePrivacy），人名邮箱 red（GDPR Art.4）。 */
function emailDataClass(email: string): 'amber' | 'red' {
  return cleanEmail(email)?.kind === 'role' ? 'amber' : 'red';
}

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
 *    contactIdentity 键**盲化后**（blindContactKey，不可逆 HMAC，去 PII 明文）新建；
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

  // 🔒 Codex P1「Prevent inserts after the company contact re-read」的写入侧硬底：在**本写入事务内**对公司行
  // 取 FOR SHARE 锁并复读 status（与删除擦除活动的 FOR UPDATE 互斥）。载入闸门在长网络 fan-out 后可能已失效
  //（发现载入时 ACTIVE、擦除随后标 SUPPRESSED）——此处是提交前最后一道确定性闸：公司已 SUPPRESSED 则整批不入库。
  const locked = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM canonical_company WHERE id = ${args.company.id}::uuid FOR SHARE`;
  if (locked[0]?.status === 'SUPPRESSED') {
    return { created: 0, merged: 0, skippedSuppressed: args.contacts.length };
  }

  // Codex P1「Add a person-level suppression」的消费侧：被 Art.17 擦除的具名人 person-level 禁联键（email-独立），
  // 命中则跳过重建——即便该人换了邮箱/无邮箱再被发现（此前只按 email 禁联 → 换邮箱即漏）。值为盲化 HMAC，本表不存人名明文。
  const suppressedContactKeys = new Set(
    (await tx.suppressionRecord.findMany({ where: { type: 'contact_key' } })).map((s) => s.value.toLowerCase()),
  );

  for (const c of args.contacts) {
    const email = c.email?.toLowerCase();
    if (email && args.suppressedEmails.has(email)) {
      skippedSuppressed += 1;
      continue;
    }
    // person-level 禁联复检（公司域内、email-独立键，与冻结所写同源）：换邮箱/无邮箱再现也拦下。
    const personKey = blindContactKey(contactIdentity({ fullName: c.fullName }, args.company.dedupeKey)).toLowerCase();
    if (suppressedContactKeys.has(personKey)) {
      skippedSuppressed += 1;
      continue;
    }
    // 解析前置：本公司是否已有同一人（同 companyId 内分层匹配）？
    // externalIds（待办 3：CH officer id…）→ Tier 0 精确并（同一董事跨源/跨时间稳定命中）。
    const { hit, ambiguous } = await resolvePersonIdentity(tx, {
      workspaceId: args.workspaceId,
      companyId: args.company.id,
      companyKey: args.company.dedupeKey,
      fullName: c.fullName,
      email,
      externalIds: c.externalIds,
    });
    const contactId = hit
      ? await mergeIntoContact(tx, args, c, hit)
      : await createContact(tx, args, c, email, ambiguous);

    // 身份源须声明署名义务许可（CH=OGL-UK-3.0…），缺省回退现有语义（licensed/sandbox）。
    const evidenceLicense = c.license ?? (args.adapterKey === 'sandbox' ? 'sandbox' : 'licensed');
    const points: { type: string; value?: string }[] = [
      { type: 'email', value: email },
      { type: 'phone', value: c.phone },
      { type: 'linkedin', value: c.linkedin },
      // external_id 点（value=`${scheme}:${value}`，与 person-identity Tier 0 查法一致，小写比对）——
      // 写上后，下次同源/跨源同人经 Tier 0 精确并（不再靠人名模糊）。
      ...(c.externalIds ?? []).map((e) => ({ type: 'external_id', value: `${e.scheme}:${e.value}` })),
    ];
    for (const p of points) {
      if (!p.value) continue;
      await tx.contactPoint.upsert({
        where: { contactId_type_value: { contactId, type: p.type, value: p.value } },
        update: {},
        create: { workspaceId: args.workspaceId, contactId, type: p.type, value: p.value },
      });
      // 收口⑥：field_evidence 是同一 PII 的第二副本——PII 值加密落库（确定性，与 contact_point 密文一致），
      // 并落 dataClass 分级（email 按职能/人名分 amber/red，phone/linkedin red）。
      const isPii = p.type === 'email' || p.type === 'phone' || p.type === 'linkedin';
      const dataClass = isPii ? (p.type === 'email' ? emailDataClass(p.value) : 'red') : 'green';
      await tx.fieldEvidence.create({
        data: {
          workspaceId: args.workspaceId,
          entityType: 'contact',
          entityId: contactId,
          field: p.type,
          value: (isPii ? encryptPii(p.value) : p.value) as unknown as Prisma.InputJsonValue,
          providerKey: args.adapterKey,
          license: evidenceLicense,
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
          dataClass,
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
          // 身份源署名许可须落到 person.profile（归一名合并源如 inpi_rne=Licence-Ouverte-2.0 /
          // epo_ops=CC-BY-4.0 不发联系点，person.profile 是新建行的唯一证据——此前硬编码 public 会丢署名）；
          // 无源 license（如 decision_maker）回退 'public'，保留既有语义。
          license: c.license ?? 'public',
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
          dataClass: 'red', // 具名人侧写=个人数据（GDPR Art.4）
        },
      });
    }
    if (hit) merged += 1;
    else created += 1;
  }
  return { created, merged, skippedSuppressed };
}

/**
 * 新建路径（resolve 未命中）：按 contactIdentity 键 upsert。
 * 收口⑥ PR #60 补丁：原文键（`e:<email>` / `c:<companyKey>:<人名>`）含 PII，**盲化**为不可逆 HMAC
 * `bi:v1:<hex>` 后落库——写 where 与 create 同经 blindContactKey，唯一键/幂等在盲值上仍成立，
 * 而 email/人名不再明文泄进 `dedupe_key`（存量经 backfill-pii-encryption.mts 一次性回填）。
 *
 * 🔴 **待办 2 create 层收尾（#54-D/#54-E / #62-2/#62-3）**：resolve 已返 null（未命中合并）。若不尊重其
 * 拒并，`contactIdentity` 明文键控 upsert 会把新记录并回键相同的旧行，令拒并形同虚设。故用
 * {@link declinedContactIdentity} 的**不碰撞确定性拒并键**（`dx:` 命名空间，externalId 优先否则按名，绝不用
 * RISKY 邮箱）新建独立行的条件有二，二者取或：
 *  - **`ambiguous`**（resolve 判同名歧义）：与 DB 当前占位**无关**——即便明文键此刻恰空也走拒并键，杜绝
 *    「首跑落明文键、二次跑该行反成碰撞→翻 dx 键生第三行」的非幂等（#54-D 硬化）；
 *  - **明文键与既有**不同**联系人碰撞**：涵盖 RISKY/catch-all 同址（#54-E）与同名不同 externalId（HIGH-1）——
 *    碰撞行是外部既存、永久占位，故据此判定亦幂等。
 * 拒并键确定性 → **同源再跑落回同一行**（幂等）；`dx:` 与明文 `e:`/`c:` 互斥 → 绝不并回既有非-declined 行。
 *
 * 🔴 拒并键的判别符还须保留**可信 email**：同名不同人各带不同 VALID 邮箱、因他人同名而歧义时，若只按人名
 * (`dx:c:<name>`) 会把两人塌成一行（净新误并）。故当来件 email **未被既有行占用**（明文键 `e:<email>` 无碰撞
 * = 非 catch-all/RISKY 共享地址）时，把它作为判别符传入 {@link declinedContactIdentity}（→`dx:e:<email>`）；
 * 已占用（碰撞=catch-all/RISKY 别人在用）则不传、退回人名——**杜绝不同人撞同址塌键**（#54-E 与本回归两全）。
 */
async function createContact(
  tx: Prisma.TransactionClient,
  args: PersistDiscoveredContactsArgs,
  c: ProviderContactRecord,
  email: string | undefined,
  ambiguous: boolean,
): Promise<string> {
  const plainKey = blindContactKey(contactIdentity({ fullName: c.fullName, email }, args.company.dedupeKey));
  // 探测明文键是否已被既有**不同**联系人占用。用途有二：① 非歧义时决定是否走拒并键；
  // ② 决定 email 能否作拒并判别符（占用 = catch-all/RISKY 共享 → 不可信，退回人名）。
  const plainCollides =
    (await tx.canonicalContact.findUnique({
      where: { workspaceId_dedupeKey: { workspaceId: args.workspaceId, dedupeKey: plainKey } },
      select: { id: true },
    })) != null;
  const usableEmail = email && !plainCollides ? email : undefined; // 未占用的 email 才可信作判别符
  const dedupeKey =
    ambiguous || plainCollides
      ? blindContactKey(
          declinedContactIdentity({ fullName: c.fullName, email: usableEmail, externalIds: c.externalIds }, args.company.dedupeKey),
        )
      : plainKey;
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
      license: c.license ?? (args.adapterKey === 'sandbox' ? 'sandbox' : 'licensed'),
      allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
    },
  });
  return contactId;
}
