/**
 * 域名解析编排（ch03 §3.12，批次 3b 骨架）。
 *
 * 输入 = 一个 workspace 下的有界公司清单（≤50，必须带注册身份）。workflow 只做确定性编排：
 * 逐公司 resolve → verify → persist；所有 IO（候选检索、页面抓取、落库）在活动侧。
 *
 * 灰度默认关：worker 侧 `DOMAIN_RESOLUTION_WORKFLOW_ENABLED` 未开时活动一律抛
 * DOMAIN_RESOLUTION_DISABLED；启动本 workflow 属于灰度动作，不在任何 schedule 注册。
 *
 * v0 边界（报告与 changelog 同步声明）：
 *  - 候选只有 source_field（源自带 website）一条路，search/ct/cc/wikidata 适配器未接线；
 *  - 法务页抓取适配器未接线（pages 为空 → 全部 NO_LEGAL_PAGE·REJECTED，零出网）；
 *  - 不回写 canonical_company.domain（回写路径随执行面下一班接线）。
 */
import { proxyActivities } from '@temporalio/workflow';
import type {
  DomainResolutionActivities,
  DomainResolutionCompanyInput,
  PersistDomainResolutionInput,
} from './domain-resolution.activities';

const { resolveRegistryDomainCandidates, verifyRegistryDomainCandidates, persistDomainResolution } =
  proxyActivities<DomainResolutionActivities>({
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 2 },
  });

export const DOMAIN_RESOLUTION_MAX_COMPANIES = 50;

export interface DomainResolutionWorkflowInput {
  workspaceId: string;
  companies: DomainResolutionCompanyInput[];
  /** VERIFIED 行进入抽样复核的概率（0..1，默认 0）。 */
  auditSampleRate?: number;
}

export interface DomainResolutionWorkflowResult {
  workspaceId: string;
  companies: number;
  candidates: number;
  verified: number;
  ambiguous: number;
  rejected: number;
  notFound: number;
  selected: Array<{ companyId: string; domain: string }>;
  reviewTasksOpened: number;
  /** 未产出候选的公司（NO_PROVIDERS/NO_HITS 或输入去重后跳过）。 */
  notFoundCompanies: string[];
}

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function domainResolutionWorkflow(
  input: DomainResolutionWorkflowInput,
): Promise<DomainResolutionWorkflowResult> {
  if (!WORKSPACE_ID.test(input.workspaceId)) {
    throw new Error(`workspaceId 不是 UUID：${input.workspaceId}`);
  }
  if (!Array.isArray(input.companies) || input.companies.length === 0) {
    throw new Error('companies 不能为空');
  }
  if (input.companies.length > DOMAIN_RESOLUTION_MAX_COMPANIES) {
    throw new Error(`companies 超过上限 ${DOMAIN_RESOLUTION_MAX_COMPANIES}`);
  }
  const companyIds = new Set(input.companies.map((company) => company.companyId));
  if (companyIds.size !== input.companies.length) {
    throw new Error('companies 存在重复 companyId');
  }
  if (
    input.auditSampleRate !== undefined &&
    (!Number.isFinite(input.auditSampleRate) || input.auditSampleRate < 0 || input.auditSampleRate > 1)
  ) {
    throw new Error(`auditSampleRate 越界：${input.auditSampleRate}`);
  }

  // 按 companyId 排序：输入顺序不影响活动命令序列（确定性重放）。
  const companies = [...input.companies].sort((a, b) => a.companyId.localeCompare(b.companyId));
  const result: DomainResolutionWorkflowResult = {
    workspaceId: input.workspaceId,
    companies: companies.length,
    candidates: 0,
    verified: 0,
    ambiguous: 0,
    rejected: 0,
    notFound: 0,
    selected: [],
    reviewTasksOpened: 0,
    notFoundCompanies: [],
  };

  for (const company of companies) {
    const resolved = await resolveRegistryDomainCandidates(company);
    if (resolved.status === 'NOT_FOUND' || resolved.candidates.length === 0) {
      result.notFound += 1;
      result.notFoundCompanies.push(company.companyId);
      continue;
    }
    result.candidates += resolved.candidates.length;

    const verified = await verifyRegistryDomainCandidates({
      company,
      candidates: resolved.candidates,
    });
    for (const item of verified.results) {
      if (item.verdict === 'VERIFIED') result.verified += 1;
      else if (item.verdict === 'AMBIGUOUS') result.ambiguous += 1;
      else result.rejected += 1;
    }

    const persistInput: PersistDomainResolutionInput = {
      workspaceId: input.workspaceId,
      companyId: company.companyId,
      candidates: resolved.candidates,
      verification: {
        results: verified.results,
        selectedDomain: verified.selectedDomain,
        nameCollision: verified.nameCollision,
      },
      auditSampleRate: input.auditSampleRate,
    };
    const persisted = await persistDomainResolution(persistInput);
    result.reviewTasksOpened += persisted.reviewTasksOpened;
    if (persisted.selectedDomain) {
      result.selected.push({ companyId: company.companyId, domain: persisted.selectedDomain });
    }
  }

  return result;
}
