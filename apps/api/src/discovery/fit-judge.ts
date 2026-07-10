import { Prisma } from '@prisma/client';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { BudgetExceededError } from '../tools/budget';

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

/**
 * 资格门判定 → **Lead(workspace × icp × company)** 落库（CandidateAssessment）。两条判定路径共享
 * （qualifyFitForRun 增量 + qualifyFitBacklog 存量），语义与写法必须一致，故抽出。
 *  - fit 挂 Lead 而非 canonical：同 workspace 多 ICP 各自独立判、互不覆盖（本次重构的根因修复）。
 *  - 只写 fit 判定；scores/status 由评分阶段负责，此处不覆盖（幂等：重判只刷 verdict + version）。
 *  - 首判即建行：status 用 schema 默认（DISCOVERED），尚无 scores；queue 按 verdict 映射初始值
 *    （mismatch→rejected，其余→needs_review）——否则评分跑完前的窗口里，明确不匹配的公司会挂在
 *    人工待审队列误导使用者。评分阶段会按六维总分重算覆盖 queue。
 */
export async function upsertLeadFit(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  icpId: string,
  canonicalCompanyId: string,
  judgment: FitJudgment,
): Promise<void> {
  await tx.lead.upsert({
    where: { workspaceId_icpId_canonicalCompanyId: { workspaceId, icpId, canonicalCompanyId } },
    update: {
      fitVerdict: judgment.verdict,
      fitReasons: judgment.fitReasons as unknown as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
    create: {
      workspaceId,
      icpId,
      canonicalCompanyId,
      fitVerdict: judgment.verdict,
      fitReasons: judgment.fitReasons as unknown as Prisma.InputJsonValue,
      queue: judgment.verdict === 'mismatch' ? 'rejected' : 'needs_review',
    },
  });
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
  opts?: { runId?: string },
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
      // runId=预算归账键（run 内 fit 判定消耗计入该 run 的账；sweep 无 runId 则按 workspace 归账）
      { workspaceId, runId: opts?.runId },
    );
    // 🔴 stub 兜底绝不写真实判定：dev 里网关瞬时失败会 fallback 到 stub（罐头 null 输出），
    // 归一化后变成 weak 假判定污染 canonical（实测抓到 2 家：fit_reasons 全 null）。宁可不判、
    // 下个 sweep 真模型重试。
    if (result.provider === 'stub') return null;
    out = result.data;
  } catch (err) {
    // 预算截断必须显性上抛（复审 HIGH）：与单家模型故障不同，预算耗尽意味着**本批余下全部**
    // 都会失败——吞掉会造成「静默漏判 + run 假 DONE」。调用方捕获后中断循环并计入 stats。
    if (err instanceof BudgetExceededError) throw err;
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
