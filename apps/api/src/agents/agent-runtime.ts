/**
 * Agent Runtime v0 的解析契约（执行侧）。
 *
 * 语义（设计 §4/§8，负向 1/2）：
 *   1. agent 平台目录行不存在 → AGENT_NOT_REGISTERED（活动直接拒绝，不可重试）
 *   2. status=DISABLED         → AGENT_DISABLED（对应回合 fail-closed，run 按既有失败语义走）
 *
 * 本模块只定义类型与错误；DB 解析器见 agent-resolver.ts，注册表访问见 agent-registry.store.ts。
 */

export const AGENT_RESOLVER_VERSION = "agent-resolver/v0";

export type AgentUnavailableCode = "AGENT_NOT_REGISTERED" | "AGENT_DISABLED";

export class AgentUnavailableError extends Error {
  constructor(
    readonly code: AgentUnavailableCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/** 解析成功的 agent 回合描述：角色、技能子集、模型策略与 loop 策略。 */
export interface ResolvedAgent {
  readonly agentKey: string;
  readonly name: string;
  readonly rolePromptVersion: string;
  readonly skillKeys: readonly string[];
  readonly modelPolicy: Readonly<Record<string, unknown>>;
  readonly memoryScope: string;
  readonly loopPolicy: AgentLoopPolicyView;
}

export interface AgentLoopPolicyView {
  readonly maxRounds: number;
}

export interface AgentResolver {
  /** 未注册/停用即抛 AgentUnavailableError（fail-closed，绝不返回“默认 agent”）。 */
  resolve(agentKey: string, workspaceId: string): Promise<ResolvedAgent>;
}

/** 各决策轨迹的 decision_type 词表（F2 字段组，v0 固定两类）。 */
export const AGENT_DECISION_TYPES = Object.freeze({
  /** 源侦察员选源：chosen=source key，rejected_candidates=未路由源及跳过原因。 */
  sourceRoute: "source.route",
  /** 资格判定员批量判定：chosen=批次，rejected_candidates=被否候选及理由码。 */
  fitJudge: "fit.judge",
});
