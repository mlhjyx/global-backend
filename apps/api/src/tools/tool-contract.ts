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

/**
 * source_policy 治理模式（收口②，fail-closed 分层）：
 *  - required：受治理**数据源**（TED/openFDA/GLEIF/Wikidata/Algolia…）。未登记、无 reader、
 *    提不出治理域 → 一律拒（fail-closed）。数据源必须先过合规审查登记才可直连。
 *  - advisory：**标的站点**类工具（抓任意公司官网 / SMTP 探测任意邮箱域）。要求预登记会杀死
 *    发现引擎——未登记放行（robots/SSRF/DAT-011 兜底），但**登记即强制**（SUSPENDED/用途门）。
 *  - none：自托管基座（searxng），无外部源治理对象。
 */
export type SourcePolicyMode = 'required' | 'advisory' | 'none';

export interface ComplianceMeta {
  sourcePolicy: SourcePolicyMode; // Broker 执行前的 source_policy 闸门模式（见上）
  /** required 工具的固定治理域（API 类工具的策略键，如 'api.ted.europa.eu'）；缺省从 input 提取 url/domain。 */
  policyDomain?: string;
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
  /**
   * 本次调用的用途（'discovery' | 'enrichment' | 'intent' …，可多值=任一允许即放行）。
   * source_policy 用途门优先按它判（须在工具声明集内 + 域策略允许其一）；
   * 缺省退回工具声明的 allowedPurpose 任一交集（多用途工具如 smtp.rcpt_probe 的既有语义）。
   */
  purpose?: string | string[];
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

/** source_policy 闸门的拒绝原因（checkSourcePolicy 与 invoke 共用词表）。 */
export type SourcePolicyDenyReason = 'suspended' | 'purpose_not_allowed' | 'unregistered' | 'policy_unavailable';

/**
 * Broker 的最小执行面（provider/service 依赖注入用，测试可注假实现；ToolBroker 实现之）。
 * 所有原始出网（HTTP/SMTP）必须经 invoke —— 白名单/source_policy/预算/限流/Trace 在闸门内强制。
 */
export interface ExecutionBroker {
  checkSourcePolicy(toolId: string, domain: string, purpose?: string | string[]): Promise<{ allowed: boolean; reason?: SourcePolicyDenyReason }>;
  invoke<I, O>(toolId: string, input: I, ctx: ToolContext): Promise<ToolResult<O>>;
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
