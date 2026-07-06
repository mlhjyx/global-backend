/**
 * L0 Tool 契约（PRD 9.13）。最细粒度原子采集能力，一后端一动作。
 * 无状态、无业务语义、不做权限/预算判断——那些由 ToolBroker 在调用点强制。
 * 产物统一带 provenance，延续字段级 Evidence。
 */

export type ToolCategory =
  | 'search' // 元搜索（searxng）
  | 'fetch' // 抓取（crawl4ai）
  | 'structured_source' // SPARQL/Overpass/registry API（wikidata/osm/gleif/opencorporates）
  | 'certificate' // crt.sh
  | 'archive_index' // common crawl
  | 'trade' // 海关/贸易
  | 'verify'; // 邮箱验证

/** 复用现有七类 SourceClass —— 工具产物落回 raw_source_record.source_class。 */
export type ToolSourceClass =
  | 'trade_data'
  | 'b2b_company_person'
  | 'company_registry'
  | 'contact_discovery'
  | 'email_verification'
  | 'public_intelligence'
  | 'industry_data';

export interface CostModel {
  unit: 'request' | 'row' | 'page' | 'token' | 'call';
  estimatedCents: number; // 每单位估算（供预算 reserve；执行后按实际 settle）
  external: boolean; // 是否外部付费/计额度
}

export interface RateLimitSpec {
  rps: number;
  concurrency: number;
  perDomainCrawlDelayMs?: number;
}

export interface ComplianceMeta {
  requiresSourcePolicy: boolean; // true → Broker 执行前查 source_policy（非 SUSPENDED 等）
  respectsRobots: boolean; // true → 抓取前 isAllowedByRobots
  personalData: boolean; // true → 走用途/脱敏门
  allowedPurpose: string[]; // ['discovery','enrichment']
  reversible: boolean; // 只读采集 = true；对外动作 = false（走 ActionProposal→OPA→approval）
  authRequired: boolean; // 需外部密钥（密钥管理，业务码不见 SDK）
  risk: 'low' | 'medium' | 'high';
}

/** 执行上下文——由 Broker 注入，工具只读取，不自造。 */
export interface ToolContext {
  workspaceId: string;
  runId?: string;
  taskContractId?: string; // 发起此调用的 AI Task（用于 allowedTools 校验与 Trace）
  correlationId?: string;
  /** Broker 查过的 source_policy 快照（工具据此避免重复查库）。 */
  sourcePolicySnapshot?: Record<string, unknown>;
}

export interface ToolResult<T = unknown> {
  data: T; // 符合 outputSchema
  costCents: number; // 实际成本（settle 用）
  provenance?: {
    sourceUrl?: string;
    fetchedAt: string;
    contentHash?: string;
    parserVersion: string;
  };
  degraded?: boolean; // 走了 fallback / 降级
}

export interface Tool<I = unknown, O = unknown> {
  id: string; // 'searxng.search' | 'crawl4ai.fetch' | 'wikidata.sparql' ...
  version: string; // semver
  category: ToolCategory;
  sourceClass?: ToolSourceClass;
  cost: CostModel;
  rateLimit: RateLimitSpec;
  compliance: ComplianceMeta;
  /** 声明消费/产出什么，供确定性 SourceSelector 连接工具图（非运行时 LLM）。 */
  capabilities: {
    produces: ('company' | 'domain' | 'contact' | 'relation' | 'certificate' | 'trade_record')[];
    accepts: ('keywords' | 'domain' | 'lei' | 'coordinates' | 'hs_code')[];
    enrichesOnly?: boolean;
  };
  /** 纯函数：由归一化 input 派生稳定幂等键（与 raw_source_record 去重统一）。 */
  idempotencyKey(input: I): string;
  /** 探测后端可用性/延迟（Registry 健康路由与熔断依据）。 */
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
  /** 唯一执行实现。权限/预算/合规不在此判断——Broker 已在调用前强制。 */
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
  /** 同能力降级链。 */
  fallbackToolIds?: string[];
}
