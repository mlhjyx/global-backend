import { Prisma } from '@prisma/client';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';

/**
 * ICP 资格门（四门判别：材质/角色/工艺/商业模式）的共享核心 ——
 * 被两条路径复用：qualifyFitForRun（本 run 增量）与 qualifyFitBacklog（存量对账，
 * 解锁投影进来的、从不属于任何 run 的公司）。判定语义必须一致，故抽出。
 */

export interface IcpBrief {
  seller: string;
  seller_summary: string | null;
  icp_name?: string;
  company_attributes?: unknown;
  exclusions?: unknown;
  target_markets?: unknown;
}

export interface FitJudgeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  attributes: unknown;
}

export interface FitJudgment {
  verdict: 'match' | 'weak' | 'mismatch';
  fitReasons: {
    material: string;
    role: string;
    process: string;
    business_model: string;
    reasons: string[];
  };
}

interface FitOutput {
  verdict: string;
  material_gate: string;
  role_gate: string;
  process_gate: string;
  business_model_gate: string;
  reasons: string[];
}

/** 事务内加载 ICP 摘要（供判定 prompt）。ICP 不存在时返回空对象（与既有行为一致）。 */
export async function loadIcpBrief(tx: Prisma.TransactionClient, icpId: string): Promise<IcpBrief | Record<string, never>> {
  const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, include: { company: true } });
  if (!icp) return {};
  return {
    seller: icp.company?.name ?? 'unknown',
    seller_summary: icp.company?.summary ?? null,
    icp_name: icp.name,
    company_attributes: icp.companyAttributes,
    exclusions: icp.exclusions,
    target_markets: icp.targetMarkets,
  };
}

/**
 * 对一家公司跑四门判别（网络调用，事务外执行）。失败返回 null（单家失败不影响其余，§5 fail-safe）。
 * 非法 verdict 归一为 weak（与既有行为一致——宁进人工复核，不误杀/误放）。
 */
export async function judgeFitCompany(
  gateway: ModelGateway,
  workspaceId: string,
  icpBrief: IcpBrief | Record<string, never>,
  company: FitJudgeCompany,
): Promise<FitJudgment | null> {
  const contract = getTask('discovery.qualify_fit')!;
  const products = (company.attributes as { products?: string[] } | null)?.products ?? [];
  let out: FitOutput;
  try {
    const result = await gateway.generateStructured<FitOutput>(
      {
        task: contract.id,
        prompt: `卖方 ICP：\n${JSON.stringify(icpBrief, null, 2)}\n\n候选公司：\n${JSON.stringify(
          { name: company.name, domain: company.domain, country: company.country, industry: company.industry, products },
          null,
          2,
        )}\n\n判断该候选是否为卖方的真实目标客户，输出中文理由。`,
        system: contract.description,
        model: contract.model,
        schema: contract.outputSchema,
      },
      { workspaceId },
    );
    // 🔴 stub 兜底绝不写真实判定：dev 里网关瞬时失败会 fallback 到 stub（罐头 null 输出），
    // 归一化后变成 weak 假判定污染 canonical（实测抓到 2 家：fit_reasons 全 null）。宁可不判、
    // 下个 sweep 真模型重试。
    if (result.provider === 'stub') return null;
    out = result.data;
  } catch {
    return null;
  }
  const verdict = (['match', 'weak', 'mismatch'].includes(out.verdict) ? out.verdict : 'weak') as FitJudgment['verdict'];
  return {
    verdict,
    fitReasons: {
      material: out.material_gate,
      role: out.role_gate,
      process: out.process_gate,
      business_model: out.business_model_gate,
      reasons: out.reasons,
    },
  };
}
