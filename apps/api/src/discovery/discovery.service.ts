import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { DiscoveryProviderRegistry } from './provider.registry';
import { contactIdentity } from './identity';

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: DiscoveryProviderRegistry,
  ) {}

  /** 触发执行：READY 计划 → DiscoveryRun + outbox 事件（relay 启动 Temporal workflow）。 */
  async executePlan(ctx: RequestContext, planId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const plan = await tx.discoveryQueryPlan.findUnique({ where: { id: planId } });
      if (!plan) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'query plan not found' } });
      if (plan.status !== 'READY') {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `plan is ${plan.status}; confirm it (READY) before executing` },
        });
      }
      const run = await tx.discoveryRun.create({
        data: { workspaceId: ctx.workspaceId, planId, icpId: plan.icpId },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'DiscoveryRunRequested',
          aggregateType: 'DiscoveryRun',
          aggregateId: run.id,
          payload: { planId, icpId: plan.icpId },
        },
      });
      return run;
    });
  }

  async getRun(ctx: RequestContext, runId: string) {
    const run = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.discoveryRun.findUnique({ where: { id: runId } }),
    );
    if (!run) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'run not found' } });
    return run;
  }

  listCanonicalCompanies(
    ctx: RequestContext,
    opts: { status?: string; limit: number; cursor?: string },
  ) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.canonicalCompany.findMany({
        where: opts.status ? { status: opts.status } : {},
        take: opts.limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { contacts: { include: { contactPoints: true } } },
      });
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      return { data, nextCursor: hasMore ? data[data.length - 1].id : null, hasMore };
    });
  }

  async getCanonicalCompany(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({
        where: { id },
        include: { contacts: { include: { contactPoints: true } } },
      });
      if (!company) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      const evidence = await tx.fieldEvidence.findMany({
        where: { entityType: 'company', entityId: id },
        orderBy: { fetchedAt: 'desc' },
      });
      return { company, evidence };
    });
  }

  /**
   * Waterfall 第 5 步（PRD 7.4.8）：仅对已选中的高价值企业按需发现联系人。
   * Suppression 在写入前检查（PRD 12.6 最小化：被禁邮箱直接不入库）。
   */
  async discoverContacts(ctx: RequestContext, companyId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({ where: { id: companyId } });
      if (!company) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      if (company.status === 'SUPPRESSED') {
        throw new ConflictException({
          error: { code: 'SUPPRESSED', message: 'company is suppressed; contact discovery blocked' },
        });
      }
      const adapters = await this.providers.routeContactDiscovery(tx as never);
      if (!adapters.length) {
        throw new ConflictException({ error: { code: 'NO_PROVIDER', message: 'no contact discovery provider enabled' } });
      }
      const adapter = adapters[0];
      const result = await adapter.discoverContacts({
        name: company.name,
        domain: company.domain ?? undefined,
        country: company.country ?? undefined,
      });
      const suppressedEmails = new Set(
        (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value.toLowerCase()),
      );

      let created = 0;
      let skippedSuppressed = 0;
      for (const c of result.contacts) {
        const email = c.email?.toLowerCase();
        if (email && suppressedEmails.has(email)) {
          skippedSuppressed += 1;
          continue;
        }
        const dedupeKey = contactIdentity({ fullName: c.fullName, email }, company.dedupeKey);
        const contact = await tx.canonicalContact.upsert({
          where: { workspaceId_dedupeKey: { workspaceId: ctx.workspaceId, dedupeKey } },
          update: {
            ...(c.title ? { title: c.title } : {}),
            ...(c.seniority ? { seniority: c.seniority } : {}),
            ...(c.department ? { department: c.department } : {}),
          },
          create: {
            workspaceId: ctx.workspaceId,
            companyId: company.id,
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
            create: { workspaceId: ctx.workspaceId, contactId: contact.id, type: p.type, value: p.value },
          });
          await tx.fieldEvidence.create({
            data: {
              workspaceId: ctx.workspaceId,
              entityType: 'contact',
              entityId: contact.id,
              field: p.type,
              value: p.value as unknown as Prisma.InputJsonValue,
              providerKey: adapter.key,
              license: adapter.key === 'sandbox' ? 'sandbox' : 'licensed',
              allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
            },
          });
        }
        created += 1;
      }
      if (result.costCents > 0) {
        await tx.usageLedger.create({
          data: {
            workspaceId: ctx.workspaceId,
            resourceType: 'provider_call',
            quantity: result.contacts.length,
            costUsd: result.costCents / 100,
            refType: 'canonical_company',
            refId: company.id,
            meta: { provider: adapter.key, op: 'contact_discovery' },
          },
        });
      }
      const contacts = await tx.canonicalContact.findMany({
        where: { companyId: company.id },
        include: { contactPoints: true },
      });
      return { contacts, skippedSuppressed };
    });
  }

  /** Waterfall 第 7 步：发送前邮箱验证（此处按需触发，状态回写 ContactPoint）。 */
  async verifyContactPoint(ctx: RequestContext, pointId: string) {
    // 短事务：载入 point + 选定验证器。**不**在事务内做网络验证——邮箱验证可能经 ToolBroker
    // 走 SMTP 出网（含限流等待 + 最长 8s 探测），持 DB 连接跨这段会拖垮连接池/触发事务超时。
    const { pointValue, adapter } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const point = await tx.contactPoint.findUnique({ where: { id: pointId } });
      if (!point) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'contact point not found' } });
      if (point.type !== 'email') {
        throw new ConflictException({ error: { code: 'INVALID_TYPE', message: 'only email points can be verified' } });
      }
      const adapters = await this.providers.routeEmailVerification(tx as never);
      if (!adapters.length) {
        throw new ConflictException({ error: { code: 'NO_PROVIDER', message: 'no email verification provider enabled' } });
      }
      return { pointValue: point.value, adapter: adapters[0] };
    });
    // 事务外：网络验证（adapter 是单例，不绑 tx）。失败会诚实降级为 verdict，不抛（§5 fail-safe）。
    const verdict = await adapter.verifyEmail(pointValue, { workspaceId: ctx.workspaceId });
    // 短事务：回写状态。
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.contactPoint.update({ where: { id: pointId }, data: { status: verdict.status, verifiedAt: new Date() } }),
    );
  }

  // ── Suppression 治理 ──────────────────────────────────────────────────────

  async addSuppression(ctx: RequestContext, entry: { type: string; value: string; reason?: string }) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rec = await tx.suppressionRecord.upsert({
        where: {
          workspaceId_type_value: {
            workspaceId: ctx.workspaceId,
            type: entry.type,
            value: entry.value.toLowerCase(),
          },
        },
        update: { reason: entry.reason ?? null },
        create: {
          workspaceId: ctx.workspaceId,
          type: entry.type,
          value: entry.value.toLowerCase(),
          reason: entry.reason ?? null,
        },
      });
      // 立刻生效：命中的 canonical 公司标记 SUPPRESSED
      if (entry.type === 'domain') {
        await tx.canonicalCompany.updateMany({
          where: { domain: entry.value.toLowerCase() },
          data: { status: 'SUPPRESSED' },
        });
      }
      return rec;
    });
  }

  listSuppressions(ctx: RequestContext) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.suppressionRecord.findMany({ orderBy: { createdAt: 'desc' } }),
    );
  }

  async removeSuppression(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rec = await tx.suppressionRecord.findUnique({ where: { id } });
      if (!rec) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'suppression not found' } });
      await tx.suppressionRecord.delete({ where: { id } });
      return { deleted: true };
    });
  }

  listProviders(ctx: RequestContext) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) => tx.dataProvider.findMany({ orderBy: { key: 'asc' } }));
  }
}
