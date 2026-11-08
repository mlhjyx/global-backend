import { ApplicationFailure } from "@temporalio/activity";
import type { AgentDecisionTraceStore } from "./agent-decision-trace.store";
import {
  AgentUnavailableError,
  type AgentResolver,
  type ResolvedAgent,
} from "./agent-runtime";
import type { SkillResolver } from "../skills/skill-runtime";

/**
 * M2 步 9b：活动层的 agent 回合辅助。两个角色（源侦察员 / 资格判定员）共用：
 * 回合开始先过注册表（fail-closed），再按技能子集经 S0 resolver 校验（技能平台停用等
 * 不可用状态同样 fail-closed，且由调用方把 reason_code 落进轨迹）。
 */

export interface AgentRoundRuntime {
  readonly agents: AgentResolver;
  readonly traces: AgentDecisionTraceStore;
}

/**
 * 回合级 agent 解析。未注册/平台停用 → nonRetryable（run 按既有失败语义走）；
 * 其它错误原样上抛（例如连接故障走既有重试策略）。
 */
export async function resolveAgentRound(
  agents: AgentResolver,
  agentKey: string,
  workspaceId: string,
): Promise<ResolvedAgent> {
  try {
    return await agents.resolve(agentKey, workspaceId);
  } catch (error) {
    if (error instanceof AgentUnavailableError) {
      throw ApplicationFailure.nonRetryable(error.code, error.code);
    }
    throw error;
  }
}

/**
 * 技能子集校验：回合内每个技能都经 S0 resolver 解析一次（与既有执行路径同一解析器，
 * 30s 缓存）。任一不可用即抛出原始 SkillUnavailableError，由调用方决定是否先落轨迹。
 */
export async function verifyAgentSkills(
  skills: SkillResolver | undefined,
  agent: ResolvedAgent,
  workspaceId: string,
): Promise<void> {
  if (!skills) return;
  for (const skillKey of agent.skillKeys) {
    await skills.resolve(skillKey, workspaceId);
  }
}
