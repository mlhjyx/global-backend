/**
 * M2 步 9b 多 agent 编排 v0：内置 agent 定义（代码侧真值，DB 注册表由 owner seed 幂等同步）。
 *
 * v0 只有两个角色，且都是既有管线的角色化包装：不新增执行能力、不新起工作流、
 * loop 恒单回合（D-9b-3）。`agent_profile` 的运营启停状态以 DB 为准，seed 不覆盖。
 */

export interface AgentLoopPolicy {
  /** v0 恒 1（单回合，无自我重试循环）；有界重规划属 M2.2。 */
  readonly maxRounds: number;
}

export interface AgentDefinition {
  readonly agentKey: string;
  readonly name: string;
  /** 角色提示词版本（随代码演进；轨迹行按此归因）。 */
  readonly rolePromptVersion: string;
  /** 技能子集（S0 `skill_package.skill_key`），回合内经 skill resolver 解析（平台停用 → fail-closed）。 */
  readonly skillKeys: readonly string[];
  /** 模型策略（v0 只记录、不改变既有模型选择——零行为变化红线）。 */
  readonly modelPolicy: Readonly<Record<string, unknown>>;
  /** 记忆作用域 v0 恒 `run`。 */
  readonly memoryScope: "run";
  readonly loopPolicy: AgentLoopPolicy;
}

/** 首批两个角色 agent 的注册键（轨迹、ops 与活动共用）。 */
export const AGENT_KEYS = {
  /** 源侦察员：discovery `executeQuery` 多源 fan-out 的角色化。 */
  sourceScout: "discovery.source_scout",
  /** 资格判定员：quickScan 批量判定的角色化。 */
  qualifier: "discovery.qualifier",
} as const;

export const BUILTIN_AGENTS: readonly AgentDefinition[] = Object.freeze([
  Object.freeze({
    agentKey: AGENT_KEYS.sourceScout,
    name: "源侦察员",
    rolePromptVersion: "v1",
    skillKeys: [],
    modelPolicy: {},
    memoryScope: "run",
    loopPolicy: { maxRounds: 1 },
  }),
  Object.freeze({
    agentKey: AGENT_KEYS.qualifier,
    name: "资格判定员",
    rolePromptVersion: "v1",
    skillKeys: ["discovery.qualify_fit"],
    modelPolicy: {},
    memoryScope: "run",
    loopPolicy: { maxRounds: 1 },
  }),
]);
