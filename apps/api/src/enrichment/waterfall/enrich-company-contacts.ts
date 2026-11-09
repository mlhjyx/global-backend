import type { Prisma, PrismaClient } from '@prisma/client';
import type { LawfulBasis } from '../../discovery/provider-contract';
import {
  ENRICH_COMPANY_CONCURRENCY,
  ENRICH_SOFT_DEADLINE_MS,
  MAX_ENRICH_CONTACTS_PER_REQUEST,
  MAX_ENRICH_FINDER_CALLS_PER_COMPANY,
  MAX_ENRICH_VERIFICATION_CALLS_PER_ADDRESS,
} from '../../discovery/execution-envelope';
import { checkProviderGates } from '../provider-gates';
import type { EmailEnrichmentAdapter } from '../finders/email-enrichment-provider';
import { resolveConfiguredVerificationProviders } from '../verification/provider-pool';
import type { EmailVerificationProvider } from '../verification/email-verification-provider';
import { CapBudget, CompositeBudget, DEFAULT_PER_CONTACT_CAP_MICROUSD, type EnrichmentBudget } from './enrichment-budget';
import { enrichContactEmail, type EnrichContactResult } from './enrich-contact-email';
import type { CircuitBreakerStore } from './circuit-breaker';

/**
 * P1-10：公司级富集编排（HTTP 端点与 run activity 共用的核心）。
 *
 * 形状上限（计划 §2.3.4.7，全部来自 discovery/execution-envelope.ts 的平台契约，不是客户配额）：
 *  - 每公司 finder 调用 ≤10 次（跨该公司全部联系人共享；用尽即停）；
 *  - 每次请求最多处理 10 个联系人（缺 email 的具名联系人）；
 *  - 每地址验证调用 ≤6 次（透传给单联系人瀑布）；
 *  - 软截止 10 分钟（HTTP 与 run activity 都传 deadline；到期不再开新联系人）；
 *  - A 档公司（本 ICP 或任一 ICP 的 lead.totalScore ≥80）才追加 Apollo/PDL 尾池。
 *
 * 预算：调用方传预算端口（HTTP = Grant cap；run = run/per-company cap）；每个联系人再叠加
 * 单联系人上限（$0.15）——两者取最紧。未传时默认单请求 $1.50（10 × $0.15）以杜绝无界花费。
 *
 * 合规：联系人/公司抑制由 enrichContactEmail 的前置门拦截；本模块只做路由与预算。
 */

export const A_TIER_SCORE_THRESHOLD = 80;

export interface EnrichCompanyContactsInput {
  workspaceId: string;
  companyId: string;
  /** 限定联系人（HTTP body.contactIds）；缺省 = 该公司全部缺 email 的具名联系人。 */
  contactIds?: string[];
  /** 验证阶段的合法性依据（HTTP body.lawfulBasis；run 用配置值）。 */
  lawfulBasis?: LawfulBasis;
  runId?: string;
  /** 预算账户键（HTTP = Grant scope 的 accountKey 口径；run = run accountKey）。 */
  accountKey: string;
  maxContacts?: number;
  /** 每联系人 finder 尝试上限（≤3，透传瀑布）。 */
  maxProvidersPerContact?: number;
  /** 每地址验证调用上限（≤6，透传瀑布）。 */
  maxVerificationCalls?: number;
  /** 每公司 finder 调用上限（缺省 10）。 */
  maxFinderCallsPerCompany?: number;
  /** 软截止（epoch ms）；缺省 now + 10 分钟。 */
  deadlineAtMs?: number;
}

export interface EnrichCompanyContactsDeps {
  prisma: {
    withWorkspace<T>(workspaceId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  };
  /** 平台表读（data_provider/source_policy 门）用的 owner 连接。 */
  ownerPrisma: PrismaClient;
  /** 主池 finder（Hunter → Findymail → Prospeo；调用方已按凭据过滤）。 */
  finders: EmailEnrichmentAdapter[];
  /** A 档才追加的尾池（Apollo → PDL）。 */
  tailFinders?: EmailEnrichmentAdapter[];
  /** 验证器（调用方已按凭据 + data_provider/source_policy 门过滤；缺省自动解析并逐家过门）。 */
  verifiers?: EmailVerificationProvider[];
  circuits?: CircuitBreakerStore;
  /** 本请求/本轮预算端口；缺省 = CapBudget(maxContacts × $0.15)。 */
  budget?: EnrichmentBudget;
  clock?: () => Date;
  actorId?: string;
}

export type EnrichCompanyContactsStatus =
  | EnrichContactResult['status']
  | 'skipped_deadline'
  | 'skipped_company_cap';

export interface EnrichCompanyContactsResult {
  companyId: string;
  tier: 'A' | 'B';
  /** company 无域（无法富集）时非空。 */
  skipped?: 'no_domain' | 'no_contacts';
  attempted: number;
  costMicrousd: number;
  deadlineHit: boolean;
  results: Array<{ contactId: string; status: EnrichCompanyContactsStatus }>;
}

/** 逐家解析已配置的验证器并过 data_provider + source_policy 门（未过门的不进瀑布）。 */
export async function gateConfiguredVerificationProviders(
  ownerPrisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmailVerificationProvider[]> {
  const configured = resolveConfiguredVerificationProviders(env);
  const gated: EmailVerificationProvider[] = [];
  for (const provider of configured) {
    const gate = await checkProviderGates(ownerPrisma, provider);
    if (gate.ok) gated.push(provider);
  }
  return gated;
}

async function companyTier(
  deps: EnrichCompanyContactsDeps,
  input: EnrichCompanyContactsInput,
): Promise<'A' | 'B'> {
  // A 档 = 该公司在任一 ICP 的 lead 总分 ≥80（评分见 §2.3.2.8；run 内通常就是本轮 ICP）。
  const topLead = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
    tx.lead.findFirst({
      where: {
        canonicalCompanyId: input.companyId,
        totalScore: { gte: A_TIER_SCORE_THRESHOLD },
      },
      select: { id: true },
    }),
  );
  return topLead ? 'A' : 'B';
}

export async function enrichCompanyContacts(
  deps: EnrichCompanyContactsDeps,
  input: EnrichCompanyContactsInput,
): Promise<EnrichCompanyContactsResult> {
  const now = deps.clock ?? (() => new Date());
  const maxContacts = Math.max(
    1,
    Math.min(input.maxContacts ?? MAX_ENRICH_CONTACTS_PER_REQUEST, MAX_ENRICH_CONTACTS_PER_REQUEST),
  );
  const finderCallCap = Math.max(
    1,
    input.maxFinderCallsPerCompany ?? MAX_ENRICH_FINDER_CALLS_PER_COMPANY,
  );
  const deadlineAtMs = input.deadlineAtMs ?? now().getTime() + ENRICH_SOFT_DEADLINE_MS;
  const tier = deps.tailFinders && deps.tailFinders.length > 0 ? await companyTier(deps, input) : 'B';
  const finders = tier === 'A' ? [...deps.finders, ...(deps.tailFinders ?? [])] : deps.finders;
  const verifiers = deps.verifiers ?? (await gateConfiguredVerificationProviders(deps.ownerPrisma));
  const budget =
    deps.budget ?? new CapBudget(maxContacts * DEFAULT_PER_CONTACT_CAP_MICROUSD);

  const loaded = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
    const company = await tx.canonicalCompany.findUnique({
      where: { id: input.companyId },
      select: { id: true, name: true, domain: true },
    });
    if (!company?.domain) return { company: null, contacts: [] as Array<{ id: string; fullName: string }> };
    const contacts = await tx.canonicalContact.findMany({
      where: {
        companyId: input.companyId,
        ...(input.contactIds ? { id: { in: input.contactIds } } : {}),
        // 只补「完全缺 email 点」的联系人；已有 email 点（任何状态）留给再验证队列。
        contactPoints: { none: { type: 'email' } },
      },
      select: { id: true, fullName: true },
      orderBy: { createdAt: 'asc' },
      take: maxContacts,
    });
    return { company, contacts };
  });
  const domain = loaded.company?.domain ?? null;
  if (!loaded.company || !domain) {
    return { companyId: input.companyId, tier, skipped: 'no_domain', attempted: 0, costMicrousd: 0, deadlineHit: false, results: [] };
  }
  if (loaded.contacts.length === 0) {
    return { companyId: input.companyId, tier, skipped: 'no_contacts', attempted: 0, costMicrousd: 0, deadlineHit: false, results: [] };
  }
  const companyName = loaded.company.name;

  const results: EnrichCompanyContactsResult['results'] = [];
  let remainingFinderCalls = finderCallCap;
  let costMicrousd = 0;
  let attempted = 0;
  let deadlineHit = false;

  for (const contact of loaded.contacts) {
    if (now().getTime() >= deadlineAtMs) {
      deadlineHit = true;
      results.push({ contactId: contact.id, status: 'skipped_deadline' });
      continue;
    }
    if (remainingFinderCalls <= 0) {
      results.push({ contactId: contact.id, status: 'skipped_company_cap' });
      continue;
    }
    const perContactBudget = new CompositeBudget([
      budget,
      new CapBudget(DEFAULT_PER_CONTACT_CAP_MICROUSD),
    ]);
    const result = await enrichContactEmail(
      {
        prisma: deps.prisma,
        finders,
        verifiers,
        gate: (finder) => checkProviderGates(deps.ownerPrisma, finder),
        ...(deps.circuits ? { circuits: deps.circuits } : {}),
        budget: perContactBudget,
        clock: now,
        actorId: deps.actorId ?? 'enrich-company-contacts',
        maxFinderAttempts: input.maxProvidersPerContact,
        maxVerificationCalls: input.maxVerificationCalls,
      },
      {
        workspaceId: input.workspaceId,
        contactId: contact.id,
        fullName: contact.fullName,
        domain,
        companyName,
        ...(input.runId ? { runId: input.runId } : {}),
        accountKey: input.accountKey,
        ...(input.lawfulBasis ? { lawfulBasis: input.lawfulBasis.basis } : {}),
      },
    );
    attempted += 1;
    costMicrousd += 'costMicrousd' in result ? result.costMicrousd : 0;
    if (result.status !== 'skipped_compliance' && result.status !== 'no_finders') {
      remainingFinderCalls -= 'finderAttempts' in result ? result.finderAttempts : 0;
    }
    results.push({ contactId: contact.id, status: result.status });
  }

  return {
    companyId: input.companyId,
    tier,
    attempted,
    costMicrousd,
    deadlineHit,
    results,
  };
}

/**
 * run 侧并发批处理（≤25 家公司、并发 2、整批共享一个软截止）。
 * 单家失败只记该家的错误，不影响其余；返回逐家结果供 activity 汇总。
 */
export async function enrichCompaniesBatch(
  deps: EnrichCompanyContactsDeps,
  companies: Array<{ companyId: string; lawfulBasis?: LawfulBasis }>,
  input: Omit<EnrichCompanyContactsInput, 'companyId' | 'lawfulBasis' | 'contactIds'>,
  concurrency: number = ENRICH_COMPANY_CONCURRENCY,
): Promise<Array<{ companyId: string; ok: boolean; result?: EnrichCompanyContactsResult; error?: string }>> {
  const queue = [...companies];
  const out: Array<{ companyId: string; ok: boolean; result?: EnrichCompanyContactsResult; error?: string }> = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const next = queue.shift();
      if (!next) return;
      try {
        const result = await enrichCompanyContacts(deps, {
          ...input,
          companyId: next.companyId,
          ...(next.lawfulBasis ? { lawfulBasis: next.lawfulBasis } : {}),
        });
        out.push({ companyId: next.companyId, ok: true, result });
      } catch (error) {
        out.push({
          companyId: next.companyId,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown_error',
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length) }, () => worker()));
  return out;
}
