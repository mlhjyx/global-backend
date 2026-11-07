import type { Prisma } from '@prisma/client';

/**
 * P5 引导 Claim 草稿（设计 docs/superpowers/plans/2026-11-08-p5-user-loop.md §4）。
 *
 * 新用户/新空间的注册引导档案只有 CompanyProfile + Offering；ICP 生成要求至少一条
 * APPROVED Claim（icp.service.ts NO_APPROVED_CLAIMS），于是无官网/理解失败的空间被卡死。
 * 这里把档案里的卖家自填事实确定性映射为 NEEDS_REVIEW 草稿，走既有审批模型：
 * 人工批准后才进入下游（ICP/寻源），不是自动事实。
 *
 * 约束：
 * - 不调用模型、不出网、零预算；可在建档事务内同批执行；
 * - 草稿不带 originKey/factKey —— 带任一键的 Claim 审批会要求 Site bridge
 *   （claim.service.ts CLAIM_BRIDGE_REQUIRED），草稿必须保持空；
 * - 幂等：按归一化 statement 对公司下未撤销（非 REVOKED）的既有 Claim 去重；
 *   REVOKED 不复活（用户明确拒绝过）。
 */

export interface ClaimDraftSpec {
  readonly type: string;
  readonly statement: string;
}

export interface ProfileClaimDraftInput {
  readonly industry?: string | null;
  readonly targetMarkets?: readonly string[] | null;
  readonly offeringNames?: readonly string[] | null;
}

export function normalizeClaimDraftStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 档案字段 → 草稿规格（纯函数，顺序稳定：产品 → 行业 → 目标市场）。 */
export function buildProfileClaimDraftSpecs(input: ProfileClaimDraftInput): ClaimDraftSpec[] {
  const specs: ClaimDraftSpec[] = [];
  const seen = new Set<string>();
  const push = (type: string, statement: string): void => {
    const key = normalizeClaimDraftStatement(statement);
    if (!key || seen.has(key)) return;
    seen.add(key);
    specs.push({ type, statement });
  };

  for (const raw of input.offeringNames ?? []) {
    const name = raw.trim();
    if (!name) continue;
    push('capability', `主营产品/服务：${name}`);
  }
  const industry = input.industry?.trim();
  if (industry) push('company_fact', `所属行业：${industry}`);
  const markets = (input.targetMarkets ?? []).map((market) => market.trim()).filter(Boolean);
  if (markets.length > 0) push('market', `目标出口市场：${markets.join('、')}`);

  return specs;
}

export interface SynthesizeDraftsResult {
  created: number;
  skipped: number;
  createdClaimIds: string[];
}

/**
 * 在调用方事务内补齐草稿。调用方负责对 company 行加锁（端点路径 FOR UPDATE；
 * 建档路径本身是单事务新行），这里只做去重与写入。
 */
export async function synthesizeProfileClaimDrafts(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    companyId: string;
    specs: readonly ClaimDraftSpec[];
  },
): Promise<SynthesizeDraftsResult> {
  if (args.specs.length === 0) {
    return { created: 0, skipped: 0, createdClaimIds: [] };
  }

  const existing = await tx.claim.findMany({
    where: { companyId: args.companyId, status: { not: 'REVOKED' } },
    select: { statement: true },
  });
  const seen = new Set(existing.map((row) => normalizeClaimDraftStatement(row.statement)));
  const pending: ClaimDraftSpec[] = [];
  for (const spec of args.specs) {
    const key = normalizeClaimDraftStatement(spec.statement);
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(spec);
  }
  const skipped = args.specs.length - pending.length;
  if (pending.length === 0) {
    return { created: 0, skipped, createdClaimIds: [] };
  }

  const ingestKey = `claim-drafts:${args.companyId}`;
  let source = await tx.knowledgeSource.findFirst({
    where: { companyId: args.companyId, ingestKey },
    select: { id: true },
  });
  if (!source) {
    source = await tx.knowledgeSource.create({
      data: {
        workspaceId: args.workspaceId,
        companyId: args.companyId,
        type: 'onboarding',
        uri: `onboarding:${args.companyId}`,
        status: 'PARSED',
        ingestKey,
      },
      select: { id: true },
    });
  }

  const createdClaimIds: string[] = [];
  for (const spec of pending) {
    const claim = await tx.claim.create({
      data: {
        workspaceId: args.workspaceId,
        companyId: args.companyId,
        sourceId: source.id,
        type: spec.type,
        statement: spec.statement,
        status: 'NEEDS_REVIEW',
        confidence: 1,
      },
      select: { id: true },
    });
    await tx.evidence.create({
      data: {
        workspaceId: args.workspaceId,
        claimId: claim.id,
        snippet: '注册引导填写',
        confidence: 1,
        fetchedAt: new Date(),
      },
    });
    createdClaimIds.push(claim.id);
  }

  return { created: createdClaimIds.length, skipped, createdClaimIds };
}
