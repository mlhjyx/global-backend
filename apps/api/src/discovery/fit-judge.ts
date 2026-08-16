import { Prisma } from '@prisma/client';
import { ModelGateway } from '../model-gateway/model-gateway';
import {
  getTask,
  resolveDiscoveryFitMaxCostCents,
  resolveDiscoveryFitMaxPhysicalCalls,
  resolveDiscoveryFitMaxTokens,
} from '../ai-tasks/task-registry';
import { BudgetExceededError } from '../tools/budget';
import { companyMatchesSuppression } from './suppression-value';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../model-runtime/types';
import {
  loadOrganizationIdentitySnapshot,
  lockWorkspaceOrganizationIdentity,
  resolveOrganizationRoot,
  type OrganizationIdentityGroup,
} from './organization-identity-root';

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
  evidence?: FitFieldEvidence[];
}

export interface FitFieldEvidence {
  id: string;
  field: string;
  value: unknown;
  providerKey: string;
  allowedActions: unknown;
  fetchedAt: Date;
}

type FitGate = 'material' | 'role' | 'process' | 'business_model';

export interface GroundedFitEvidence {
  ref: string;
  field: string;
  value: unknown;
  provider: string;
  fetched_at: string;
  supports: FitGate[];
}

export interface FitJudgment {
  verdict: 'match' | 'weak' | 'mismatch';
  fitReasons: {
    material: string;
    role: string;
    process: string;
    business_model: string;
    reasons: string[];
    evidence_status?: 'grounded' | 'insufficient';
    evidence_refs?: string[];
    gate_evidence_refs?: Record<FitGate, string[]>;
  };
}

export class IdentityGroupLeadConflictError extends Error {
  readonly code = 'IDENTITY_GROUP_LEAD_CONFLICT';

  constructor(rootCompanyId: string, icpId: string) {
    super(`identity group ${rootCompanyId} already has multiple Leads for ICP ${icpId}`);
    this.name = 'IdentityGroupLeadConflictError';
  }
}

export interface IdentityGroupLead {
  id: string;
  canonicalCompanyId: string;
  fitVerdict: string | null;
}

/** One production query across all roots+aliases; findUnique fallback keeps lightweight in-memory harnesses honest. */
export async function findIdentityGroupLeadsForIcp(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  icpId: string,
  groups: readonly OrganizationIdentityGroup[],
): Promise<IdentityGroupLead[]> {
  const companyIds = [...new Set(groups.flatMap((group) => group.relatedCompanyIds))];
  if (!companyIds.length) return [];
  if (typeof tx.lead.findMany === 'function') {
    return tx.lead.findMany({
      where: { workspaceId, icpId, canonicalCompanyId: { in: companyIds } },
      select: { id: true, canonicalCompanyId: true, fitVerdict: true },
    });
  }
  if (typeof tx.lead.findUnique !== 'function') {
    throw new Error('identity-group Lead lookup is unavailable');
  }
  const rows = await Promise.all(
    companyIds.map((canonicalCompanyId) =>
      tx.lead.findUnique({
        where: {
          workspaceId_icpId_canonicalCompanyId: { workspaceId, icpId, canonicalCompanyId },
        },
        select: { id: true, canonicalCompanyId: true, fitVerdict: true },
      }),
    ),
  );
  return rows.filter((row): row is IdentityGroupLead => Boolean(row));
}

interface FitOutput {
  verdict: string;
  material_gate: string;
  role_gate: string;
  process_gate: string;
  business_model_gate: string;
  reasons: string[];
  evidence_refs: Record<FitGate, string[]>;
}

const FIT_GATES: readonly FitGate[] = ['material', 'role', 'process', 'business_model'];
const FIT_FIELD_SUFFIXES = [
  'industry',
  'industries',
  'product',
  'products',
  'structured_products',
  'material',
  'materials',
  'process',
  'processes',
  'capability',
  'capabilities',
  'manufacturing_process',
  'manufacturing_processes',
  'business_model',
  'company_type',
  'description',
  'summary',
] as const;

function hasMatchPermission(value: unknown): boolean {
  return Array.isArray(value) && value.includes('match');
}

function boundedEvidenceValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const bounded = value.slice(0, 1_000);
    return bounded.trim() ? bounded : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    const bounded = value
      .slice(0, 20)
      .map((item) => boundedEvidenceValue(item))
      .filter((item) => item !== undefined);
    return bounded.length ? bounded : undefined;
  }
  return undefined;
}

function supportsForField(field: string, value: unknown): FitGate[] {
  const normalized = field.toLowerCase();
  const suffix = normalized.split('.').at(-1) ?? normalized;
  const supports = new Set<FitGate>();
  if (['material', 'materials', 'product', 'products', 'structured_products', 'description', 'summary'].includes(suffix)) {
    supports.add('material');
  }
  if (
    ['industry', 'industries', 'product', 'products', 'structured_products', 'business_model', 'company_type', 'description', 'summary'].includes(
      suffix,
    )
  ) {
    supports.add('role');
  }
  if (['process', 'processes', 'capability', 'capabilities', 'manufacturing_process', 'manufacturing_processes'].includes(suffix)) {
    supports.add('process');
  }
  if (['business_model', 'company_type', 'description', 'summary'].includes(suffix)) {
    supports.add('business_model');
  }
  if (
    (suffix === 'industry' || suffix === 'industries') &&
    /\b(?:metal|steel|aluminium|aluminum|plastic|polymer|wood|timber|glass|ceramic|textile|fabric|powder)\b/iu.test(
      JSON.stringify(value),
    )
  ) {
    supports.add('material');
  }
  return [...supports];
}

function nestedFitFacts(value: unknown): { path: string; value: unknown }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const found: { path: string; value: unknown }[] = [];
  const visit = (node: unknown, path: string[], depth: number) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 3) return;
    for (const [key, child] of Object.entries(node)) {
      const next = [...path, key];
      if (FIT_FIELD_SUFFIXES.includes(key.toLowerCase() as (typeof FIT_FIELD_SUFFIXES)[number])) {
        const bounded = boundedEvidenceValue(child);
        if (bounded !== undefined) found.push({ path: next.join('.'), value: bounded });
      } else {
        visit(child, next, depth + 1);
      }
    }
  };
  visit(value, [], 0);
  return found;
}

export function collectGroundedFitEvidence(rows: readonly FitFieldEvidence[]): GroundedFitEvidence[] {
  const packet: GroundedFitEvidence[] = [];
  for (const row of rows) {
    if (!hasMatchPermission(row.allowedActions)) continue;
    const suffix = row.field.toLowerCase().split('.').at(-1) ?? row.field.toLowerCase();
    const facts = FIT_FIELD_SUFFIXES.includes(suffix as (typeof FIT_FIELD_SUFFIXES)[number])
      ? [{ path: row.field, value: boundedEvidenceValue(row.value) }]
      : row.field === 'attributes'
        ? nestedFitFacts(row.value).map((fact) => ({ path: `attributes.${fact.path}`, value: fact.value }))
        : [];
    for (const fact of facts) {
      if (fact.value === undefined) continue;
      const supports = supportsForField(fact.path, fact.value);
      if (!supports.length) continue;
      packet.push({
        ref: `field-evidence:${row.id}:${fact.path}`,
        field: fact.path,
        value: fact.value,
        provider: row.providerKey,
        fetched_at: row.fetchedAt.toISOString(),
        supports,
      });
      if (packet.length >= 24) return packet;
    }
  }
  return packet.sort((left, right) => left.ref.localeCompare(right.ref));
}

export function validateGroundedFitOutput(out: FitOutput, evidence: readonly GroundedFitEvidence[]): void {
  const byRef = new Map(evidence.map((item) => [item.ref, item]));
  for (const gate of FIT_GATES) {
    const refs = out.evidence_refs?.[gate];
    if (!Array.isArray(refs)) throw new Error(`${gate} evidence refs are required`);
    for (const ref of refs) {
      const item = byRef.get(ref);
      if (!item || !item.supports.includes(gate)) throw new Error(`${gate} evidence ref is not authorized`);
    }
    const gateText = out[`${gate}_gate` as keyof FitOutput];
    if (typeof gateText === 'string' && /^pass\b/iu.test(gateText) && refs.length === 0) {
      throw new Error(`${gate} pass requires evidence`);
    }
  }
  if (out.verdict === 'match') {
    for (const gate of FIT_GATES) {
      const gateText = out[`${gate}_gate` as keyof FitOutput];
      if (typeof gateText !== 'string' || !/^pass\b/iu.test(gateText) || out.evidence_refs[gate].length === 0) {
        throw new Error(`match requires grounded ${gate} evidence`);
      }
    }
  }
}

function groundedOutputSchema(base: Record<string, unknown>, evidence: readonly GroundedFitEvidence[]): Record<string, unknown> {
  const properties = { ...((base.properties as Record<string, unknown> | undefined) ?? {}) };
  properties.evidence_refs = {
    type: 'object',
    required: [...FIT_GATES],
    additionalProperties: false,
    properties: Object.fromEntries(
      FIT_GATES.map((gate) => {
        const refs = evidence.filter((item) => item.supports.includes(gate)).map((item) => item.ref);
        return [gate, { type: 'array', uniqueItems: true, maxItems: 8, items: { type: 'string', enum: refs } }];
      }),
    ),
  };
  return {
    ...base,
    additionalProperties: false,
    required: [...new Set([...(Array.isArray(base.required) ? base.required : []), 'evidence_refs'])],
    properties,
  };
}

function insufficientEvidenceJudgment(evidence: readonly GroundedFitEvidence[] = []): FitJudgment {
  const gateEvidenceRefs = Object.fromEntries(
    FIT_GATES.map((gate) => [gate, evidence.filter((item) => item.supports.includes(gate)).map((item) => item.ref)]),
  ) as Record<FitGate, string[]>;
  const missingGates = FIT_GATES.filter((gate) => gateEvidenceRefs[gate].length === 0);
  const availableRefs = [...new Set(Object.values(gateEvidenceRefs).flat())];
  const gateMessage = (gate: FitGate): string =>
    gateEvidenceRefs[gate].length
      ? 'unclear：已有部分来源证据，但不足以确认通过'
      : 'unclear：没有可用于匹配的来源证据';
  return {
    verdict: 'weak',
    fitReasons: {
      material: gateMessage('material'),
      role: gateMessage('role'),
      process: gateMessage('process'),
      business_model: gateMessage('business_model'),
      reasons: [
        evidence.length === 0
          ? '只有企业身份信息，缺少行业、产品、材质、工艺或商业模式证据；已停止模型判断并转人工复核。'
          : `来源证据尚未覆盖全部资格门（缺少：${missingGates.join('、')}）；已停止模型判断并转人工复核。`,
      ],
      evidence_status: 'insufficient',
      evidence_refs: availableRefs,
      gate_evidence_refs: gateEvidenceRefs,
    },
  };
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
  expectedIdentityFingerprint: string,
): Promise<boolean> {
  // The model call happens outside this transaction. Hold the workspace identity
  // lock while re-validating the exact graph snapshot used for that call and
  // while writing the Lead, so merge/split cannot move the target underneath us.
  await lockWorkspaceSuppressionPolicy(tx, workspaceId);
  await lockWorkspaceOrganizationIdentity(tx, workspaceId);
  const snapshot = await loadOrganizationIdentitySnapshot(tx, workspaceId, canonicalCompanyId);
  if (snapshot.fingerprint !== expectedIdentityFingerprint) return false;
  const identityCompanies = await tx.canonicalCompany.findMany({
    where: { id: { in: snapshot.relatedCompanyIds } },
    select: { id: true, name: true, domain: true, status: true },
  });
  const suppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name'] } },
    select: { type: true, value: true },
  });
  if (
    identityCompanies.length !== snapshot.relatedCompanyIds.length ||
    identityCompanies.some((company) => company.status === 'SUPPRESSED' || companyMatchesSuppression(suppressions, company))
  ) {
    return false;
  }
  const openConflicts = await tx.organizationIdentityConflictParty.count({
    where: {
      workspaceId,
      companyId: { in: snapshot.relatedCompanyIds },
      conflict: { status: { in: ['OPEN', 'RESOLVING'] } },
    },
  });
  if (openConflicts > 0) return false;
  let identity = await resolveOrganizationRoot(tx, workspaceId, snapshot.rootCompanyId);
  if (typeof tx.$executeRaw === 'function') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':identity-lead:' + icpId + ':' + identity.rootCompanyId}, 0))`;
  }
  // Re-read after the lock so a mapping committed while we were waiting cannot
  // make us create a Lead against a stale identity group.
  identity = await resolveOrganizationRoot(tx, workspaceId, identity.rootCompanyId);
  const existing = await findIdentityGroupLeadsForIcp(tx, workspaceId, icpId, [identity]);
  if (existing.length > 1) {
    throw new IdentityGroupLeadConflictError(identity.rootCompanyId, icpId);
  }
  const data = {
    fitVerdict: judgment.verdict,
    fitReasons: judgment.fitReasons as unknown as Prisma.InputJsonValue,
    version: { increment: 1 },
  };
  if (existing[0]) {
    await tx.lead.update({
      where: { id: existing[0].id },
      data,
    });
    return true;
  }
  await tx.lead.upsert({
    where: { workspaceId_icpId_canonicalCompanyId: { workspaceId, icpId, canonicalCompanyId: identity.rootCompanyId,
      },
    },
    update: data,
    create: {
      workspaceId,
      icpId,
      canonicalCompanyId: identity.rootCompanyId,
      fitVerdict: judgment.verdict,
      fitReasons: judgment.fitReasons as unknown as Prisma.InputJsonValue,
      queue: judgment.verdict === 'mismatch' ? 'rejected' : 'needs_review',
    },
  });
  return true;
}

/** 事务内加载 ICP 摘要（供判定 prompt）。ICP 不存在时返回空对象（与既有行为一致）。 */
export async function loadIcpBrief(tx: Prisma.TransactionClient, icpId: string,
): Promise<IcpBrief | Record<string, never>> {
  const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, include: { company: true },
  });
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
  opts?: { runId?: string; runtimeTelemetry?: RuntimeTelemetry;
    authorizeExternalAction?: () => Promise<boolean>;
  },
): Promise<FitJudgment | null> {
  const contract = getTask('discovery.qualify_fit')!;
  const maxTokens = resolveDiscoveryFitMaxTokens();
  const maxCostCents = resolveDiscoveryFitMaxCostCents();
  const maxPhysicalCalls = resolveDiscoveryFitMaxPhysicalCalls();
  const evidence = collectGroundedFitEvidence(company.evidence ?? []);
  if (!evidence.length || FIT_GATES.some((gate) => !evidence.some((item) => item.supports.includes(gate)))) {
    return insufficientEvidenceJudgment(evidence);
  }
  let out: FitOutput;
  try {
    const result = await executeStructuredTaskWithRuntime<FitOutput>(
      gateway,
      {
        task: contract.id,
        prompt: `卖方 ICP：\n${JSON.stringify(icpBrief, null, 2)}\n\n候选公司身份（只用于定位，不是行业证据）：\n${JSON.stringify(
          { name: company.name, domain: company.domain, country: company.country,
          },
          null,
          2,
        )}\n\n允许使用的来源证据：\n${JSON.stringify(evidence, null, 2)}\n\n判断该候选是否为卖方的真实目标客户。每个门只引用 evidence_refs 中列出的证据；不得使用模型记忆、公司名称联想或输入外知识。证据不足必须判 weak/unclear。理由保持简洁。`,
        system: `${contract.description}\n证据纪律：只能依据请求中的来源证据；每个 pass 必须引用支持该门的 evidence ref；四门未全部有证据不得判 match。`,
        model: contract.model,
        schema: groundedOutputSchema(contract.outputSchema, evidence),
        validateOutput: (data) => validateGroundedFitOutput(data as FitOutput, evidence),
        repairTaskOutput: true,
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(maxCostCents === undefined ? {} : { maxCostCents }),
        ...(maxPhysicalCalls === undefined ? {} : { maxPhysicalCalls }),
      },
      // runId=预算归账键（run 内 fit 判定消耗计入该 run 的账；sweep 无 runId 则按 workspace 归账）
      {
        workspaceId,
        runId: opts?.runId,
        authorizeExternalAction: opts?.authorizeExternalAction,
      },
      { telemetry: opts?.runtimeTelemetry },
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
  const verdict = (
    ['match', 'weak', 'mismatch'].includes(out.verdict) ? out.verdict : 'weak'
  ) as FitJudgment['verdict'];
  const evidenceRefs = [...new Set(FIT_GATES.flatMap((gate) => out.evidence_refs[gate]))];
  return {
    verdict,
    fitReasons: {
      material: out.material_gate,
      role: out.role_gate,
      process: out.process_gate,
      business_model: out.business_model_gate,
      reasons: out.reasons,
      evidence_status: 'grounded',
      evidence_refs: evidenceRefs,
      gate_evidence_refs: out.evidence_refs,
    },
  };
}
