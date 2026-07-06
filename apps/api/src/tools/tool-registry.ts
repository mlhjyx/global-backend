import { Tool, ToolCategory, ToolSourceClass } from './tool-contract';

/**
 * Tool Registry（确定性，非 LLM）——PRD 9.13。Tool 的注册表 + 路由器。
 * 启动期从代码内声明装载（非动态外部注入，避免未登记依赖）。
 * 路由是确定性规则（能力匹配→健康→成本升序→风险），非模型裁量（9.11）。
 *
 * 与现有 data_provider 表的关系：Registry 管**工具实现与选路**；data_provider
 * 表管**Provider 运行开关（ENABLED/DISABLED = Kill Switch）与成本参数**。二者是
 * 一个体系的两面（Tool 是更细入口），不是两个竞争的路由器。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly healthCache = new Map<string, { healthy: boolean; at: number }>();
  private readonly healthTtlMs = 60_000;

  register(tool: Tool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`tool ${tool.id} already registered`);
    }
    // 装载期校验契约完整（缺字段即启动失败，避免运行期惊喜）
    for (const f of ['version', 'category', 'cost', 'rateLimit', 'compliance', 'capabilities'] as const) {
      if (tool[f] == null) throw new Error(`tool ${tool.id} missing ${f}`);
    }
    this.tools.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * 按能力/源类路由，返回有序候选（含 fallback 展开）。
   * 确定性排序：健康优先 → 成本升序 → 风险升序。budget 传入时过滤超单价预算。
   */
  async resolve(query: {
    category?: ToolCategory;
    sourceClass?: ToolSourceClass;
    produces?: string;
    maxUnitCents?: number;
  }): Promise<Tool[]> {
    let cands = this.all().filter((t) => {
      if (query.category && t.category !== query.category) return false;
      if (query.sourceClass && t.sourceClass !== query.sourceClass) return false;
      if (query.produces && !t.capabilities.produces.includes(query.produces as never)) return false;
      if (query.maxUnitCents != null && t.cost.estimatedCents > query.maxUnitCents) return false;
      return true;
    });

    // 健康过滤（缓存的 healthCheck）
    const healthy: Tool[] = [];
    for (const t of cands) {
      if (await this.isHealthy(t)) healthy.push(t);
    }
    cands = healthy.length ? healthy : cands; // 全不健康时不至于空手，交给 Broker 降级/报错

    const riskOrder = { low: 0, medium: 1, high: 2 };
    cands.sort(
      (a, b) => a.cost.estimatedCents - b.cost.estimatedCents || riskOrder[a.compliance.risk] - riskOrder[b.compliance.risk],
    );
    return cands;
  }

  private async isHealthy(tool: Tool): Promise<boolean> {
    const cached = this.healthCache.get(tool.id);
    if (cached && Date.now() - cached.at < this.healthTtlMs) return cached.healthy;
    let healthy = true;
    try {
      healthy = (await tool.healthCheck()).healthy;
    } catch {
      healthy = false;
    }
    this.healthCache.set(tool.id, { healthy, at: Date.now() });
    return healthy;
  }
}
