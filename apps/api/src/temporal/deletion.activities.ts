import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { blindContactKey, decryptPii } from '../compliance/pii-crypto';
import { buildSuppressionEntries, selectReconcileStragglerIds } from '../compliance/deletion-plan';
import { contactIdentity } from '../discovery/identity';
import {
  DELETION_RULE_VERSION,
  buildDeletionCompletedPayload,
  classifyDeletionCompleted,
  countsFromLocated,
} from '../compliance/deletion-snapshot';
import {
  DeletionWorkflowInput,
  ErasureCounts,
  LocatedErasureTargets,
  SuppressionEntry,
} from '../compliance/deletion.types';

/**
 * 收口⑥ PR-B 删除编排（GDPR Art.17）的 Temporal 活动。deletionWorkflow 四步：
 *   ① freezeSubject —— 定位擦除面（pre-deletion 快照）+ 写 suppression_record（对外动作第一道闸）+ 状态 FROZEN。
 *   ② eraseSubject  —— 硬删 canonical_contact（级联 contact_point）+ 显式删 field_evidence(contact) +
 *      company 主体标 SUPPRESSED；受影响 ACTIVE ICP 各发 QualifyRequested（事务性 outbox → 重评分）；状态 ERASING。
 *   ③ completeDeletion —— 写 deletion_receipt（append-only）+ DeletionCompleted 事件（同 tx）+ 状态 COMPLETED。
 *   ④ failDeletion —— 任一步异常 → 状态 FAILED（best-effort，不覆盖 COMPLETED）。
 *
 * 🔴 内容最小化：跨活动/进 Temporal 历史的 `located` 只含 uuid+计数；禁联项（含邮箱明文）仅在 ① 内部
 * 计算并落库，永不返回。source_signal 是平台共享零-PII 绿库，租户 DSR 不撤（signalsRevoked 恒 0）。
 * 幂等：每步用 CAS（updateMany where status=<expected>）守，Temporal 重试不产生重复副作用；擦除计数取自
 * ② 擦除时刻的真实擦除面并落 stats，故重试（行已删、二次统计为 0）也不失真。所有租户读写经 withWorkspace（RLS，app_user）。
 */
export function createDeletionActivities(deps: { prisma: PrismaService }) {
  const { prisma } = deps;

  return {
    async freezeSubject(input: DeletionWorkflowInput): Promise<LocatedErasureTargets> {
      const { located, suppressionEntries } = await locate(prisma, input);
      await prisma.withWorkspace(input.workspaceId, async (tx) => {
        await upsertSuppressionEntries(tx, input.workspaceId, suppressionEntries);
        // company 主体：**冻结即标 SUPPRESSED**（不等到 eraseSubject）——联系人发现/存量 sweep 以 company.status
        // ==='SUPPRESSED' 为载入闸门，尽早置位可拦下 freeze 之后才发起的发现，收窄「漏网新联系人」窗口。
        if (located.companyIdsToSuppress.length) {
          await tx.canonicalCompany.updateMany({
            where: { id: { in: located.companyIdsToSuppress } },
            data: { status: 'SUPPRESSED' },
          });
        }
        // RECEIVED → FROZEN（幂等 CAS：非 RECEIVED 则匹配 0 行，绝不倒退）
        await tx.deletionRequest.updateMany({
          where: { id: input.deletionRequestId, status: 'RECEIVED' },
          data: { status: 'FROZEN' },
        });
      });
      return located;
    },

    async eraseSubject(args: {
      input: DeletionWorkflowInput;
      located: LocatedErasureTargets;
    }): Promise<ErasureCounts> {
      const { input, located } = args;
      return prisma.withWorkspace(input.workspaceId, async (tx) => {
        // 幂等 CAS：FROZEN → ERASING。已擦除过（≠FROZEN）→ 取**擦除时刻持久化的真实 stats** 返回，跳过全部
        // 删除/发事件副作用（Temporal 重试不重复擦除）。stats 未持久化则回退快照计数（合法的空/0）。
        const moved = await tx.deletionRequest.updateMany({
          where: { id: input.deletionRequestId, status: 'FROZEN' },
          data: { status: 'ERASING' },
        });
        if (moved.count === 0) {
          const req = await tx.deletionRequest.findUnique({
            where: { id: input.deletionRequestId },
            select: { stats: true },
          });
          return (req?.stats as ErasureCounts | null) ?? countsFromLocated(located);
        }

        // 🔒 Codex P1「Prevent inserts after the company contact re-read」：company 主体擦除前对公司行取
        // **FOR UPDATE** 排他锁（与并发 contact INSERT 的 FK FOR KEY SHARE 互斥）。先起的发现事务被本锁挡住 →
        // 本事务提交（公司已 SUPPRESSED）后其 persistDiscoveredContacts 的 FOR SHARE 状态复检命中 SUPPRESSED 而
        // 整批跳过；已提交的漏网联系人则被下面的重查捕获。二者合拢=完成删除后不再有新 PII 落到本公司。
        if (located.companyIdsToSuppress.length) {
          await tx.$queryRaw`SELECT id FROM canonical_company WHERE id IN (${Prisma.join(
            located.companyIdsToSuppress.map((id) => Prisma.sql`${id}::uuid`),
          )}) FOR UPDATE`;
        }

        // 待硬删的联系人集（连同当前 contactPoints 一并重查，供真实计数 + 冻结后新增邮箱补写禁联）：
        //  · company 主体：擦除时刻**全量重查**（捕获冻结后并发发现的漏网联系人，保证 Art.17 完整）；
        //  · contact 主体：不封停公司（不标 SUPPRESSED），但同样对属主公司取**瞬时 FOR UPDATE 排空并发插入**
        //    后，按 person-key + createdAt **有界对账**把「冻结提交 contact_key 前抢跑新建的重物化同人行」纳入
        //    擦除集——收口 PR #80 复审 CONFIRMED 的残留并发窗口（见 deletion-art17-residual-window.md）。
        const reconciledContactIds = located.companyIdsToSuppress.length
          ? null
          : located.contactIds.length
            ? await reconcileContactSubjectEraseIds(tx, input, located)
            : null;
        const eraseTargetWhere: Prisma.CanonicalContactWhereInput | null = located.companyIdsToSuppress.length
          ? { companyId: { in: located.companyIdsToSuppress } }
          : reconciledContactIds && reconciledContactIds.length
            ? { id: { in: reconciledContactIds } }
            : null;
        const eraseContacts = eraseTargetWhere
          ? await tx.canonicalContact.findMany({
              where: eraseTargetWhere,
              select: { id: true, contactPoints: { select: { type: true, value: true } } },
            })
          : [];
        const eraseContactIds = eraseContacts.map((c) => c.id);

        // Codex P1「Suppress emails added after the freeze step」：从**擦除时刻**联系人的当前邮箱补写
        // suppression（冻结后才挂上、快照未见的邮箱），级联删前先固化禁联——防发现/猜测路径日后重建或再触达。
        // upsert 幂等，与冻结所写取并集。
        const lateEmails = eraseContacts.flatMap((c) =>
          c.contactPoints.filter((p) => p.type === 'email').map((p) => decryptPii(p.value)),
        );
        if (lateEmails.length) {
          await upsertSuppressionEntries(
            tx,
            input.workspaceId,
            buildSuppressionEntries({ subjectType: 'contact', emails: lateEmails }),
          );
        }

        // 真实擦除计数（Codex P1「Recompute counts from the final erase set」）：contactPoints 删前点数；
        // field_evidence / canonical_contact 取 deleteMany 返回 count——回执/事件/stats 忠实反映实际擦除面
        //（此前用冻结快照计数，漏报冻结后新增的行）。
        let contactPointsErased = 0;
        let fieldEvidenceErased = 0;
        if (eraseContactIds.length) {
          contactPointsErased = eraseContacts.reduce((n, c) => n + c.contactPoints.length, 0);
          // field_evidence 无 FK 级联 → 显式按 contact 实体删（含 person.profile red 行 + 邮箱/电话加密副本）
          const fe = await tx.fieldEvidence.deleteMany({
            where: { entityType: 'contact', entityId: { in: eraseContactIds } },
          });
          fieldEvidenceErased = fe.count;
          // canonical_contact 硬删 → DB 级联删 contact_point（onDelete: Cascade）
          await tx.canonicalContact.deleteMany({ where: { id: { in: eraseContactIds } } });
        }

        // company 主体：整公司标 SUPPRESSED（幂等——freeze 已置；此处兜底。保留绿区公司事实，company 非自然人不硬删）
        if (located.companyIdsToSuppress.length) {
          await tx.canonicalCompany.updateMany({
            where: { id: { in: located.companyIdsToSuppress } },
            data: { status: 'SUPPRESSED' },
          });
        }

        // 重评分：受影响 ACTIVE ICP 各发一条 QualifyRequested（事务性 outbox；relay dispatch → qualifyWorkflow →
        // scoreCandidates 重算 Reachability 等维——联系人没了分数得跟着变）。workflowId=qualify-<icp> 合并去重。
        for (const icpId of located.affectedIcpIds) {
          await tx.outboxEvent.create({
            data: {
              workspaceId: input.workspaceId,
              eventType: 'QualifyRequested',
              aggregateType: 'ICP',
              aggregateId: icpId,
              payload: {} as Prisma.InputJsonValue,
            },
          });
        }

        const counts: ErasureCounts = {
          contactsErased: eraseContactIds.length,
          contactPointsErased,
          fieldEvidenceErased,
          signalsRevoked: located.signalsToRevoke,
          companiesSuppressed: located.companyIdsToSuppress.length,
          leadsRescoreRequested: located.affectedIcpIds.length,
        };
        // 同 tx 持久化真实计数（stats），供 completeDeletion 忠实取用——即便 complete 后续失败、人工重跑时
        // located 重算为空，也不伪造 0。CAS where=ERASING（本 tx 内已置）。
        await tx.deletionRequest.updateMany({
          where: { id: input.deletionRequestId, status: 'ERASING' },
          data: { stats: counts as unknown as Prisma.InputJsonValue },
        });
        return counts;
      });
    },

    async completeDeletion(args: {
      input: DeletionWorkflowInput;
      located: LocatedErasureTargets;
    }): Promise<ErasureCounts> {
      const { input, located } = args;
      const erasedAt = new Date().toISOString();
      return prisma.withWorkspace(input.workspaceId, async (tx) => {
        const req = await tx.deletionRequest.findUnique({
          where: { id: input.deletionRequestId },
          select: { status: true, stats: true },
        });
        if (!req) throw new Error(`deletion_request ${input.deletionRequestId} not found`);

        // 🔴 真实计数优先取擦除阶段持久化的 stats（防 complete 后失败、人工重跑时 located 重算为空 → 伪造 0 回执）；
        // stats 未持久化 = 擦除尚未发生，回退 located（此时应为合法的空/0）。
        const persisted = (req.stats as ErasureCounts | null) ?? null;
        const counts = persisted ?? countsFromLocated(located);

        if (req.status === 'COMPLETED') return counts; // 幂等：回执与事件已写过

        const existing = await tx.deletionReceipt.findUnique({
          where: { deletionRequestId: input.deletionRequestId },
        });
        if (existing) {
          // 回执已写但状态未收尾（complete 在 create 之后崩）→ 只补状态（CAS，绝不覆盖 COMPLETED），不重复发事件
          await tx.deletionRequest.updateMany({
            where: { id: input.deletionRequestId, status: { notIn: ['COMPLETED'] } },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          return counts;
        }

        // 🔴 拒绝为「擦除从未发生」的请求伪造回执/事件：仅当擦除已发生（状态 ERASING，或 stats 已持久化）才收尾。
        const eraseHappened = req.status === 'ERASING' || persisted !== null;
        if (!eraseHappened) {
          throw new Error(
            `completeDeletion: erase not performed (status=${req.status}) — refuse to fabricate receipt`,
          );
        }

        // 回执（append-only）——🔴 只计数 + subjectId 引用，绝不嵌人名/邮箱
        await tx.deletionReceipt.create({
          data: {
            workspaceId: input.workspaceId,
            deletionRequestId: input.deletionRequestId,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            contactsErased: counts.contactsErased,
            contactPointsErased: counts.contactPointsErased,
            fieldEvidenceErased: counts.fieldEvidenceErased,
            signalsRevoked: counts.signalsRevoked,
            companiesSuppressed: counts.companiesSuppressed,
            leadsRescoreRequested: counts.leadsRescoreRequested,
            ruleVersion: DELETION_RULE_VERSION,
          },
        });

        // DeletionCompleted（事务性 outbox：状态变更 ⇔ 事件存在，同 tx 原子）
        const payload = buildDeletionCompletedPayload({
          deletionRequestId: input.deletionRequestId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          counts,
          erasedAt,
        });
        await tx.outboxEvent.create({
          data: {
            workspaceId: input.workspaceId,
            eventType: 'DeletionCompleted',
            aggregateType: 'DeletionRequest',
            aggregateId: input.deletionRequestId,
            privacyClassification: classifyDeletionCompleted(counts),
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });

        // CAS：仅从 ERASING/FAILED 收尾为 COMPLETED（FAILED-with-stats = 擦除已发生的合法收尾；绝不无条件直更）
        await tx.deletionRequest.updateMany({
          where: { id: input.deletionRequestId, status: { in: ['ERASING', 'FAILED'] } },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        return counts;
      });
    },

    async failDeletion(args: {
      workspaceId: string;
      deletionRequestId: string;
      error: string;
    }): Promise<void> {
      await prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.deletionRequest.updateMany({
          where: { id: args.deletionRequestId, status: { notIn: ['COMPLETED', 'FAILED'] } },
          data: { status: 'FAILED', error: args.error.slice(0, 500) },
        }),
      );
    },
  };
}

export type DeletionActivities = ReturnType<typeof createDeletionActivities>;

/** suppression_record 幂等 upsert（冻结与擦除两阶段共用）：已存在则保留更早的禁联时间/原因，不覆盖。 */
async function upsertSuppressionEntries(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  entries: SuppressionEntry[],
): Promise<void> {
  for (const s of entries) {
    await tx.suppressionRecord.upsert({
      where: { workspaceId_type_value: { workspaceId, type: s.type, value: s.value } },
      update: {}, // 已存在则保留（更早的禁联时间/原因不覆盖）
      create: { workspaceId, type: s.type, value: s.value, reason: s.reason },
    });
  }
}

/**
 * Art.17 contact 主体擦除集的**排空 + 有界对账**（收口 PR #80 复审 CONFIRMED 残留并发窗口，
 * 见 docs/implementation-records/deletion-art17-residual-window.md）。仅 contact 主体调用（此时
 * located.contactIds=[冻结快照单一 id]、companyIdsToSuppress 为空）。返回 = 原始件 ∪ 重物化同人漏网件。
 *
 * 1) 读原始件（首次真擦除时尚在；已删=幂等重跑）拿 fullName + 属主公司；已删则回退快照 id（deleteMany 命中 0）。
 * 2) 对属主公司取**瞬时 FOR UPDATE**（不标 SUPPRESSED，不封停公司发现）——与并发插入 persist 的 FK
 *    FOR KEY SHARE / 显式 FOR SHARE 互斥，建立 happens-before：本锁到手即所有竞态 persist 已提交、其
 *    「冻结提交 contact_key 前抢跑新建」的重物化行已可见。
 * 3) 候选 = 同公司、DSR 受理（deletion_request.createdAt）后新建、非原始件；按 person-key（与创建闸同构）
 *    有界对账挑出重物化同人行。🔴 createdAt 过滤只触碰 DSR 受理后新建的行，先存的同名另一真人绝不入选。
 */
async function reconcileContactSubjectEraseIds(
  tx: Prisma.TransactionClient,
  input: DeletionWorkflowInput,
  located: LocatedErasureTargets,
): Promise<string[]> {
  const originalId = located.contactIds[0];
  const original = await tx.canonicalContact.findUnique({
    where: { id: originalId },
    select: { id: true, fullName: true, companyId: true, company: { select: { dedupeKey: true } } },
  });
  // 原始件已不在：Temporal 重跑的幂等由前面 moved.count===0 早返回守（不会走到这里）；此分支守的是
  // **并发跨主体删除**（如同公司的 company 主体擦除先删到该行）——回退快照 id（后续 deleteMany 命中 0，安全）。
  if (!original) return located.contactIds;

  // 排空锚点：属主公司行 FOR UPDATE（仅锁不改状态；$queryRaw 不经读路径解密，无需 PII）
  await tx.$queryRaw`SELECT id FROM canonical_company WHERE id = ${original.companyId}::uuid FOR UPDATE`;

  const req = await tx.deletionRequest.findUnique({
    where: { id: input.deletionRequestId },
    select: { createdAt: true },
  });
  if (!req) return [originalId];

  const companyKey = original.company.dedupeKey;
  const erasedPersonKey = blindContactKey(contactIdentity({ fullName: original.fullName }, companyKey)).toLowerCase();
  // 候选走扩展 client → fullName 读路径解密为明文（供 person-key 计算）
  const candidates = await tx.canonicalContact.findMany({
    where: { companyId: original.companyId, id: { not: originalId }, createdAt: { gte: req.createdAt } },
    select: { id: true, fullName: true, createdAt: true },
  });
  const stragglers = selectReconcileStragglerIds({ erasedPersonKey, companyKey, since: req.createdAt, candidates });
  return [originalId, ...stragglers];
}

/** 受影响的 ACTIVE ICP（对该公司持有 Lead 的 ICP）——重评分目标；非 ACTIVE 的 ICP 排除（scoreCandidates 要求 ACTIVE）。 */
async function affectedActiveIcpIds(tx: Prisma.TransactionClient, companyId: string): Promise<string[]> {
  const leads = await tx.lead.findMany({
    where: { canonicalCompanyId: companyId },
    select: { icpId: true },
    distinct: ['icpId'],
  });
  const icpIds = leads.map((l) => l.icpId);
  if (!icpIds.length) return [];
  const active = await tx.icpDefinition.findMany({
    where: { id: { in: icpIds }, status: 'ACTIVE' },
    select: { id: true },
  });
  return active.map((i) => i.id);
}

/**
 * 定位主体擦除面（withWorkspace RLS 事务）：返回 **PII-free** located（uuid+计数，进 workflow 历史）+
 * **内部用** suppressionEntries（含邮箱明文，仅冻结步用，永不外泄）。主体已不存在 → 空快照（幂等）。
 */
async function locate(
  prisma: PrismaService,
  input: DeletionWorkflowInput,
): Promise<{ located: LocatedErasureTargets; suppressionEntries: SuppressionEntry[] }> {
  return prisma.withWorkspace(input.workspaceId, async (tx) => {
    const base: LocatedErasureTargets = {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      contactIds: [],
      contactPointsCount: 0,
      fieldEvidenceCount: 0,
      companyIdsToSuppress: [],
      signalsToRevoke: 0,
      affectedIcpIds: [],
    };

    if (input.subjectType === 'contact') {
      const contact = await tx.canonicalContact.findUnique({
        where: { id: input.subjectId },
        include: { contactPoints: true, company: { select: { dedupeKey: true } } },
      });
      if (!contact) return { located: base, suppressionEntries: [] };
      // contactPoints.value 经 PII 扩展在读路径解密；decryptPii 对已明文值幂等（防嵌套解密漏层）。
      const emails = contact.contactPoints
        .filter((p) => p.type === 'email')
        .map((p) => decryptPii(p.value));
      const fieldEvidenceCount = await tx.fieldEvidence.count({
        where: { entityType: 'contact', entityId: input.subjectId },
      });
      const affectedIcpIds = await affectedActiveIcpIds(tx, contact.companyId);
      return {
        located: {
          ...base,
          contactIds: [contact.id],
          contactPointsCount: contact.contactPoints.length,
          fieldEvidenceCount,
          affectedIcpIds,
        },
        // contactName + companyKey → 写 person-level 禁联键（Codex P1「Add a person-level suppression」）：
        // 擦除后该具名人即便换邮箱/无邮箱再被发现，也命中禁联而不重建。fullName 经 PII 扩展读路径解密为明文。
        suppressionEntries: buildSuppressionEntries({
          subjectType: 'contact',
          emails,
          contactName: contact.fullName,
          companyKey: contact.company.dedupeKey,
        }),
      };
    }

    const company = await tx.canonicalCompany.findUnique({
      where: { id: input.subjectId },
      include: { contacts: { include: { contactPoints: true } } },
    });
    if (!company) return { located: base, suppressionEntries: [] };
    const contactIds = company.contacts.map((c) => c.id);
    const contactPointsCount = company.contacts.reduce((n, c) => n + c.contactPoints.length, 0);
    const emails = company.contacts.flatMap((c) =>
      c.contactPoints.filter((p) => p.type === 'email').map((p) => decryptPii(p.value)),
    );
    const fieldEvidenceCount = contactIds.length
      ? await tx.fieldEvidence.count({ where: { entityType: 'contact', entityId: { in: contactIds } } })
      : 0;
    const affectedIcpIds = await affectedActiveIcpIds(tx, company.id);
    return {
      located: {
        ...base,
        contactIds,
        contactPointsCount,
        fieldEvidenceCount,
        companyIdsToSuppress: [company.id],
        affectedIcpIds,
      },
      suppressionEntries: buildSuppressionEntries({
        subjectType: 'company',
        emails,
        domain: company.domain,
        companyName: company.name,
      }),
    };
  });
}
