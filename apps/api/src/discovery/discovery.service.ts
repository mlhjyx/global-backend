import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { DiscoveryProviderRegistry } from './provider.registry';
import { persistDiscoveredContacts } from './contact-persist';
import { EmailGuesser, GuessResult } from './email-guesser';
import { persistGuessedEmail } from './email-guess-persist';
import { buildGuessTargets } from './email-guess-targets';
import { EmailVerdict, EmailVerifyContext, LawfulBasis, ProviderContactRecord } from './provider-contract';
import { cleanEmail } from '../acquisition/clean';
import { evaluateEmailGate, resolveEmailVerificationPolicy, stampLawfulBasis } from './compliance/email-verification-gate';

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
   * 短事务①载入 → **事务外**网络发现（decision_maker 抓多页 + LLM，可达数分钟，绝不持 DB 事务跨这段）
   * → 短事务②持久化（与 verifyContactPoint 同一纪律）。
   */
  async discoverContacts(ctx: RequestContext, companyId: string) {
    const loaded = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
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
      const suppressedEmails = new Set(
        (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value.toLowerCase()),
      );
      return { company, adapters, suppressedEmails };
    });

    // 事务外 fan-out：遍历全部 enabled 的联系人 adapter（decision_maker/public_web/companies_house…）。
    // 🔴 单 adapter 失败/闸门拒绝不阻断其余（fail-safe）；各自保留自己的 adapterKey。
    const perAdapter: { key: string; contacts: ProviderContactRecord[]; costCents: number }[] = [];
    for (const adapter of loaded.adapters) {
      try {
        const result = await adapter.discoverContacts(
          {
            name: loaded.company.name,
            domain: loaded.company.domain ?? undefined,
            country: loaded.company.country ?? undefined,
          },
          // 收口②：真租户贯穿（LLM/抓取按 workspace 归属 trace/预算）
          { workspaceId: ctx.workspaceId, correlationId: companyId },
        );
        perAdapter.push({ key: adapter.key, contacts: result.contacts, costCents: result.costCents });
      } catch {
        // 单 adapter fail-safe：不阻断其余源
      }
    }

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      // 同一 tx 内顺序 persist：后一 adapter 的 resolve 看得到前一 adapter 刚插入的行 →
      // 同一人经 resolvePersonIdentity 合并（decision_maker 的 email + CH 的 officer_id 落同一条）。
      let skippedSuppressed = 0;
      for (const pa of perAdapter) {
        const res = await persistDiscoveredContacts(tx, {
          workspaceId: ctx.workspaceId,
          company: { id: loaded.company.id, dedupeKey: loaded.company.dedupeKey },
          adapterKey: pa.key,
          contacts: pa.contacts,
          suppressedEmails: loaded.suppressedEmails,
        });
        skippedSuppressed += res.skippedSuppressed;
        if (pa.costCents > 0) {
          await tx.usageLedger.create({
            data: {
              workspaceId: ctx.workspaceId,
              resourceType: 'provider_call',
              quantity: pa.contacts.length,
              costUsd: pa.costCents / 100,
              refType: 'canonical_company',
              refId: loaded.company.id,
              meta: { provider: pa.key, op: 'contact_discovery' },
            },
          });
        }
      }
      const contacts = await tx.canonicalContact.findMany({
        where: { companyId: loaded.company.id },
        include: { contactPoints: true },
      });
      return { contacts, skippedSuppressed };
    });
  }

  /**
   * 选项 B · P0.3：对某公司**缺邮箱的具名决策人**批量猜测邮箱并落库。
   * 复用 discoverContacts 纪律：短事务①载入（公司+联系人+已知样本+禁联）→ **事务外**网络
   * （EmailGuesser 逐人 SMTP 验证，可数分钟，绝不持 DB 事务）→ 短事务②落库（persistGuessedEmail）。
   *
   * 🔴 合规：猜出的都是人名邮箱，需 lawfulBasis 或显式开关（否则 guesser 返回 blocked、零探测）；
   *    RISKY 未证实猜测落库但 allowedActions 不含 outreach；suppression 命中不落。
   */
  async guessEmailsForCompany(
    ctx: RequestContext,
    companyId: string,
    opts?: { lawfulBasis?: LawfulBasis; allowPersonalWithoutBasis?: boolean; maxContacts?: number; maxProbe?: number },
  ) {
    const loaded = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({ where: { id: companyId } });
      if (!company) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      if (company.status === 'SUPPRESSED') {
        throw new ConflictException({ error: { code: 'SUPPRESSED', message: 'company suppressed; email guessing blocked' } });
      }
      if (!company.domain) {
        throw new ConflictException({ error: { code: 'NO_DOMAIN', message: 'company has no domain; cannot guess emails' } });
      }
      const adapters = await this.providers.routeEmailVerification(tx as never);
      if (!adapters.length) {
        throw new ConflictException({ error: { code: 'NO_PROVIDER', message: 'no email verification provider enabled' } });
      }
      const contacts = await tx.canonicalContact.findMany({ where: { companyId }, include: { contactPoints: true } });
      const suppressedEmails = new Set(
        (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value.toLowerCase()),
      );
      return { company, domain: company.domain, adapter: adapters[0], contacts, suppressedEmails };
    });

    const domain = loaded.domain;
    // 格式学习样本（同域非-RISKY，全公司合并）+ 缺邮箱决策人（有界，默认 25）——与 backlog 阶段⑤b 共用
    // 纯件 buildGuessTargets（复审 MEDIUM：消 service/backlog 逐字重复漂移 + 统一 per-company cap）。
    const { knownSamples, emailless: targets, emaillessTotal } = buildGuessTargets(
      loaded.contacts,
      domain,
      opts?.maxContacts,
    );

    // 事务外：逐人 SMTP 猜测（adapter 单例不绑 tx）
    const guesser = new EmailGuesser(loaded.adapter);
    const results: { contactId: string; fullName: string; result: GuessResult }[] = [];
    for (const c of targets) {
      const result = await guesser.guess(
        { fullName: c.fullName, domain, knownSamples },
        {
          workspaceId: ctx.workspaceId,
          lawfulBasis: opts?.lawfulBasis,
          allowPersonalWithoutBasis: opts?.allowPersonalWithoutBasis,
          actor: ctx.userId,
          maxProbe: opts?.maxProbe,
          suppressedEmails: loaded.suppressedEmails,
        },
      );
      results.push({ contactId: c.contactId, fullName: c.fullName, result });
    }

    // 短事务②：落库
    const now = new Date();
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const summary = {
        emaillessContacts: emaillessTotal,
        attempted: targets.length,
        persisted: 0,
        verified: 0,
        unverified: 0,
        blocked: 0,
        perContact: [] as { fullName: string; status: GuessResult['status']; email: string | null; pointStatus: string | null }[],
      };
      for (const r of results) {
        const out = await persistGuessedEmail(tx, {
          workspaceId: ctx.workspaceId,
          contactId: r.contactId,
          result: r.result,
          suppressedEmails: loaded.suppressedEmails,
          // 用门**实际采用**的（已 stamp）依据，而非调用方原始入参——开关合成的 override 依据也在此，
          // 否则 allowPersonalWithoutBasis 路径会 personal_data=true 却 lawful_basis=null（复审 HIGH）。
          lawfulBasis: r.result.lawfulBasis ?? opts?.lawfulBasis,
          now,
        });
        if (out.persisted) {
          summary.persisted += 1;
          if (out.status === 'VALID') summary.verified += 1;
          else summary.unverified += 1;
        }
        if (r.result.status === 'blocked') summary.blocked += 1;
        summary.perContact.push({
          fullName: r.fullName,
          status: r.result.status,
          email: out.email ?? null,
          pointStatus: out.status ?? null,
        });
      }
      return summary;
    });
  }

  /**
   * Waterfall 第 7 步：发送前邮箱验证（按需触发，状态回写 ContactPoint）。
   *
   * 🔴 合规门：探测**人名邮箱**=处理个人数据（GDPR）。职能邮箱默认自动验证；人名邮箱需显式
   * `lawfulBasis`（LIA/同意/合同）或开关 `allowPersonalWithoutBasis` 才探测，否则 BLOCKED（不触网）。
   * 禁联名单命中一律 BLOCKED。门在**服务层、先于选择/调用任何验证器**裁决（provider 无关，防 kill-switch
   * 落到忽略 ctx 的 public_web/sandbox 绕过）。每次验证写 field_evidence 留痕（含所依据的合法性基础）。
   */
  async verifyContactPoint(
    ctx: RequestContext,
    pointId: string,
    opts?: { lawfulBasis?: LawfulBasis; allowPersonalWithoutBasis?: boolean },
  ) {
    // 短事务①：载入 point + 分级 + 禁联命中 + 选定验证器。**不**在事务内做网络验证——邮箱验证可能经
    // ToolBroker 走 SMTP 出网（含限流等待 + 最长 8s 探测），持 DB 连接跨这段会拖垮连接池/触发事务超时。
    const loaded = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const point = await tx.contactPoint.findUnique({ where: { id: pointId } });
      if (!point) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'contact point not found' } });
      if (point.type !== 'email') {
        throw new ConflictException({ error: { code: 'INVALID_TYPE', message: 'only email points can be verified' } });
      }
      const domain = point.value.split('@')[1]?.toLowerCase();
      const suppressed = await tx.suppressionRecord.findFirst({
        where: {
          OR: [
            { type: 'email', value: point.value.toLowerCase() },
            ...(domain ? [{ type: 'domain', value: domain }] : []),
          ],
        },
      });
      const adapters = await this.providers.routeEmailVerification(tx as never);
      return {
        pointValue: point.value,
        contactId: point.contactId,
        kind: cleanEmail(point.value)?.kind,
        suppressed: !!suppressed,
        adapter: adapters[0] as (typeof adapters)[number] | undefined,
      };
    });

    // 🔴 合规门裁决（纯逻辑，先于任何网络/验证器调用）。
    const gate = evaluateEmailGate({
      email: loaded.pointValue,
      kind: loaded.kind,
      lawfulBasis: opts?.lawfulBasis,
      suppressed: loaded.suppressed,
      policy: resolveEmailVerificationPolicy({ allowPersonalWithoutBasis: opts?.allowPersonalWithoutBasis }),
    });
    const gateKind = gate.kind === 'invalid' ? undefined : gate.kind;
    // 将被落库的合法性基础统一补断言人/时间——覆盖操作者显式断言的**与开关合成的**（后者无 who/when），
    // 否则 override 路径的审计记录缺断言人（Codex #13 P2）。
    const recordedBasis = gate.lawfulBasis
      ? stampLawfulBasis(gate.lawfulBasis, ctx.userId, new Date().toISOString())
      : undefined;

    // 事务外：门放行才做网络验证（adapter 单例，不绑 tx，失败诚实降级为 verdict，不抛，§5 fail-safe）；
    // 门拦截则合成 BLOCKED，**不路由/不触任何验证器**（即便 smtp_self 被 kill-switch 关掉也不绕过）。
    let verdict: EmailVerdict;
    let providerKey: string;
    if (!gate.allowed) {
      verdict = { status: 'BLOCKED', detail: `lawful_basis_gate:${gate.reason}`, costCents: 0, kind: gateKind };
      providerKey = 'compliance_gate';
    } else {
      if (!loaded.adapter) {
        throw new ConflictException({ error: { code: 'NO_PROVIDER', message: 'no email verification provider enabled' } });
      }
      const verifyCtx: EmailVerifyContext = {
        workspaceId: ctx.workspaceId,
        kind: loaded.kind,
        lawfulBasis: recordedBasis,
        allowPersonalWithoutBasis: opts?.allowPersonalWithoutBasis,
        suppressed: loaded.suppressed,
      };
      verdict = await loaded.adapter.verifyEmail(loaded.pointValue, verifyCtx);
      providerKey = loaded.adapter.key;
    }

    // 短事务②：审计留痕（裁决 + 合法性基础）+ 回写状态。返回 point + verification 元数据供前端判断。
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await tx.fieldEvidence.create({
        data: {
          workspaceId: ctx.workspaceId,
          entityType: 'contact',
          entityId: loaded.contactId,
          field: 'email.verification',
          value: {
            status: verdict.status,
            detail: verdict.detail ?? null,
            kind: verdict.kind ?? gateKind ?? loaded.kind ?? null,
            lawfulBasis: verdict.lawfulBasis ?? recordedBasis ?? null,
            suppressed: loaded.suppressed,
          } as unknown as Prisma.InputJsonValue,
          providerKey,
          license: providerKey === 'sandbox' ? 'sandbox' : 'public',
          allowedActions: allowedActionsFor(verdict.status) as unknown as Prisma.InputJsonValue,
        },
      });
      const updated = await tx.contactPoint.update({
        where: { id: pointId },
        data: { status: verdict.status, verifiedAt: new Date() },
      });
      return {
        ...updated,
        verification: {
          status: verdict.status,
          detail: verdict.detail ?? null,
          kind: verdict.kind ?? gateKind ?? loaded.kind ?? null,
          providerKey,
          lawfulBasis: verdict.lawfulBasis ?? recordedBasis ?? null,
        },
      };
    });
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

/** 验证裁决 → field_evidence.allowed_actions（诚实：BLOCKED 不授予任何动作；仅 VALID 授 outreach）。 */
function allowedActionsFor(status: string): string[] {
  if (status === 'BLOCKED') return [];
  if (status === 'VALID') return ['display', 'match', 'outreach'];
  return ['display', 'match'];
}
