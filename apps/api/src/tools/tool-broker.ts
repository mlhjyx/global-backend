import { ExecutionBroker, SourcePolicyDenyReason, Tool, ToolContext, ToolResult } from './tool-contract';
import { ToolRegistry } from './tool-registry';
import { BudgetLedger, BudgetExceededError, budgetLedger } from './budget';
import { RateLimiter, rateLimiter } from './rate-limiter';
import { getTask } from '../ai-tasks/task-registry';

/**
 * ToolBroker（PRD 9.2 Tool Registry + Policy 层）——**唯一工具执行入口**，
 * 所有确定性闸门收敛于此（工具内部不自证）。顺序（评审确定）：
 *   allowedTools 白名单 → source_policy/robots/license 合规 → 预算 reserve
 *   → 限流 → 幂等执行 → 预算 settle → Trace 审计。
 *
 * 这是「无超级 Agent」的执行面保证：LLM/Task 永远只能调它在契约里声明的工具，
 * 且每次调用的权限/预算/合规/审计由确定性代码兜底。
 */

export class ToolPolicyDenied extends Error {
  constructor(
    public readonly toolId: string,
    public readonly reason: string,
  ) {
    super(`tool ${toolId} denied: ${reason}`);
    this.name = 'ToolPolicyDenied';
  }
}

export interface BrokerDeps {
  registry: ToolRegistry;
  budget?: BudgetLedger;
  limiter?: RateLimiter;
  /** 查某域名的 source_policy（返回 null=未登记；{suspended, allowedPurpose,...}）。 */
  sourcePolicyReader?: (domain: string) => Promise<{ suspended: boolean; allowedPurpose?: string[] } | null>;
  /** 记一条工具调用 Trace（成本/延迟/合规决策）。fire-and-forget。 */
  traceRecorder?: (t: ToolTrace) => void;
  /** now() 注入，便于测试。 */
  now?: () => number;
}

export interface ToolTrace {
  workspaceId: string;
  toolId: string;
  toolVersion: string;
  taskContractId?: string;
  status: 'OK' | 'DENIED' | 'ERROR';
  reason?: string;
  costCents: number;
  latencyMs: number;
  idempotencyKey?: string;
  degraded?: boolean;
}

/** 从 input 里尽力提取一个域名（供 source_policy 闸门做合规检查；required 工具优先用 policyDomain）。 */
function extractDomain(input: unknown): string | null {
  const v = input as { url?: string; domain?: string };
  const raw = v?.url ?? v?.domain;
  if (!raw) return null;
  try {
    const u = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export class ToolBroker implements ExecutionBroker {
  private readonly registry: ToolRegistry;
  private readonly budget: BudgetLedger;
  private readonly limiter: RateLimiter;
  private readonly deps: BrokerDeps;

  constructor(deps: BrokerDeps) {
    this.deps = deps;
    this.registry = deps.registry;
    this.budget = deps.budget ?? budgetLedger;
    this.limiter = deps.limiter ?? rateLimiter;
    for (const t of this.registry.all()) this.limiter.configure(t.id, t.rateLimit.rps, t.rateLimit.concurrency);
  }

  /**
   * 查某域名的 source_policy（无 reader 或未登记 → null）。checkSourcePolicy 与调用方按需取用。
   */
  async sourcePolicy(domain: string): Promise<{ suspended: boolean; allowedPurpose?: string[] } | null> {
    if (!this.deps.sourcePolicyReader) return null;
    return this.deps.sourcePolicyReader(domain);
  }

  /**
   * source_policy 判定（**SUSPENDED + 用途门 + 未登记 fail-closed**），**不执行工具**。
   * invoke 的合规门与调用方「昂贵前置（DNS/网络）前主动跳过」共用同一判定（单点真相）。
   * 收口②语义分层（见 SourcePolicyMode）：
   *  - required：无 reader → policy_unavailable；未登记 → unregistered（一律拒，fail-closed）。
   *  - advisory：无 reader / 未登记 → 放行（robots/SSRF/DAT-011 兜底）；**登记即强制**。
   *  - none：不查。
   * 用途门：传了 purpose（本次调用用途）→ 域策略必须允许**该用途**（且工具须声明它）；
   * 缺省 → 工具声明集任一交集（多用途工具的既有语义，避免只登记单用途的域被误拒）。
   */
  async checkSourcePolicy(
    toolId: string,
    domain: string,
    purpose?: string | string[],
  ): Promise<{ allowed: boolean; reason?: SourcePolicyDenyReason }> {
    const tool = this.registry.get(toolId);
    const mode = tool?.compliance.sourcePolicy ?? 'none';
    if (mode === 'none') return { allowed: true };
    // 调用用途（可多值）先与工具声明集求交——工具不得被用于未声明的用途；交集为调用的有效用途集
    let effective = tool?.compliance.allowedPurpose ?? [];
    if (purpose) {
      const callPurposes = Array.isArray(purpose) ? purpose : [purpose];
      effective = callPurposes.filter((p) => effective.includes(p));
      if (!effective.length) return { allowed: false, reason: 'purpose_not_allowed' };
    }
    if (!this.deps.sourcePolicyReader) {
      return mode === 'required' ? { allowed: false, reason: 'policy_unavailable' } : { allowed: true };
    }
    const policy = await this.sourcePolicy(domain);
    if (!policy) {
      return mode === 'required' ? { allowed: false, reason: 'unregistered' } : { allowed: true };
    }
    if (policy.suspended) return { allowed: false, reason: 'suspended' };
    if (policy.allowedPurpose && !policy.allowedPurpose.some((p) => effective.includes(p))) {
      return { allowed: false, reason: 'purpose_not_allowed' };
    }
    return { allowed: true };
  }

  /** 唯一执行入口。所有闸门在此强制。 */
  async invoke<I, O>(toolId: string, input: I, ctx: ToolContext): Promise<ToolResult<O>> {
    const now = this.deps.now ?? Date.now;
    const started = now();
    const tool = this.registry.get(toolId) as Tool<I, O> | undefined;
    if (!tool) throw new ToolPolicyDenied(toolId, 'not registered');

    // 1) allowedTools 白名单（有界工具的代码强制，PRD 9.11）
    if (ctx.taskContractId) {
      const task = getTask(ctx.taskContractId);
      const allowed = task?.allowedTools ?? [];
      if (!allowed.includes(toolId)) {
        this.trace(ctx, tool, 'DENIED', 'not in task allowedTools', 0, now() - started);
        throw new ToolPolicyDenied(toolId, `not in allowedTools of ${ctx.taskContractId}`);
      }
    }

    // 2) 合规门：source_policy（未登记 fail-closed / SUSPENDED / 用途）——与早跳过共用
    //    checkSourcePolicy（单点判定）。治理域优先取工具声明的 policyDomain（API 类固定域），
    //    缺省从 input 提取；required 工具提不出域 = 拒（不再静默跳过合规门）。
    const mode = tool.compliance.sourcePolicy;
    if (mode !== 'none') {
      const domain = tool.compliance.policyDomain ?? extractDomain(input);
      if (!domain) {
        if (mode === 'required') {
          this.trace(ctx, tool, 'DENIED', 'no governable domain for required source_policy', 0, now() - started);
          throw new ToolPolicyDenied(toolId, 'no governable domain (required source_policy)');
        }
        // advisory：无域可查 → 交给 robots/SSRF/DAT-011 兜底
      } else {
        const chk = await this.checkSourcePolicy(toolId, domain, ctx.purpose);
        if (!chk.allowed) {
          const detail =
            chk.reason === 'suspended'
              ? `source_policy SUSPENDED: ${domain}`
              : chk.reason === 'purpose_not_allowed'
                ? `purpose not allowed for ${domain}`
                : `source_policy ${chk.reason}: ${domain}`;
          this.trace(ctx, tool, 'DENIED', detail, 0, now() - started);
          throw new ToolPolicyDenied(
            toolId,
            chk.reason === 'suspended' ? `domain ${domain} is SUSPENDED` : detail,
          );
        }
      }
    }
    // 注：robots 由抓取类工具内部 isAllowedByRobots 强制（已实现），此处不重复。

    // 3) 预算 reserve（reserve-then-settle）。超限也要留 DENIED trace（审计可见）。
    const runId = ctx.runId ?? ctx.workspaceId;
    let reservation: { runId: string; estCents: number };
    try {
      reservation = this.budget.reserve(runId, tool.cost.estimatedCents);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        this.trace(ctx, tool, 'DENIED', `budget exceeded: ${err.message.slice(0, 150)}`, 0, now() - started);
      }
      throw err;
    }

    // 4) 限流（令牌桶 + 每域延迟）
    const release = await this.limiter.acquire(toolId, now());
    const domain = extractDomain(input);
    if (domain && tool.rateLimit.perDomainCrawlDelayMs) {
      await this.limiter.respectDomainDelay(domain, tool.rateLimit.perDomainCrawlDelayMs, now());
    }

    // 5) 执行 + 6) settle + 7) trace
    try {
      const result = await tool.execute(input, ctx);
      this.budget.settle(reservation, result.costCents);
      this.trace(ctx, tool, 'OK', undefined, result.costCents, now() - started, tool.idempotencyKey(input), result.degraded);
      return result;
    } catch (err) {
      this.budget.settle(reservation, 0); // 失败不计费（对齐 PRD 7.4.8 失败不计费）
      this.trace(ctx, tool, 'ERROR', String(err).slice(0, 200), 0, now() - started);
      throw err;
    } finally {
      release();
    }
  }

  private trace(
    ctx: ToolContext,
    tool: Tool,
    status: ToolTrace['status'],
    reason: string | undefined,
    costCents: number,
    latencyMs: number,
    idempotencyKey?: string,
    degraded?: boolean,
  ): void {
    this.deps.traceRecorder?.({
      workspaceId: ctx.workspaceId,
      toolId: tool.id,
      toolVersion: tool.version,
      taskContractId: ctx.taskContractId,
      status,
      reason,
      costCents,
      latencyMs,
      idempotencyKey,
      degraded,
    });
  }
}
