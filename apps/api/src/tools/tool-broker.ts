import { Tool, ToolContext, ToolResult } from './tool-contract';
import { ToolRegistry } from './tool-registry';
import { BudgetLedger, budgetLedger } from './budget';
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

/** 从 input 里尽力提取一个域名（供 requiresSourcePolicy 工具做合规检查）。 */
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

export class ToolBroker {
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
   * 查某域名的 source_policy（无 reader 或未登记 → null）。invoke 内部合规门用之；
   * 亦供调用方在**昂贵前置步骤前**（如邮箱验证的 MX 解析/SMTP 出网）主动跳过 SUSPENDED 域名。
   */
  async sourcePolicy(domain: string): Promise<{ suspended: boolean; allowedPurpose?: string[] } | null> {
    if (!this.deps.sourcePolicyReader) return null;
    return this.deps.sourcePolicyReader(domain);
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

    // 2) 合规门：source_policy（SUSPENDED / 用途）
    if (tool.compliance.requiresSourcePolicy && this.deps.sourcePolicyReader) {
      const domain = extractDomain(input);
      if (domain) {
        const policy = await this.sourcePolicy(domain);
        if (policy?.suspended) {
          this.trace(ctx, tool, 'DENIED', `source_policy SUSPENDED: ${domain}`, 0, now() - started);
          throw new ToolPolicyDenied(toolId, `domain ${domain} is SUSPENDED`);
        }
        const purposes = tool.compliance.allowedPurpose;
        if (policy?.allowedPurpose && !policy.allowedPurpose.some((p) => purposes.includes(p))) {
          this.trace(ctx, tool, 'DENIED', `purpose not allowed for ${domain}`, 0, now() - started);
          throw new ToolPolicyDenied(toolId, `purpose not allowed for ${domain}`);
        }
      }
    }
    // 注：robots 由抓取类工具内部 isAllowedByRobots 强制（已实现），此处不重复。

    // 3) 预算 reserve（reserve-then-settle）
    const runId = ctx.runId ?? ctx.workspaceId;
    const reservation = this.budget.reserve(runId, tool.cost.estimatedCents);

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
