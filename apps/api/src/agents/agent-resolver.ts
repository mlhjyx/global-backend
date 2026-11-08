import type { AgentRegistryStore } from "./agent-registry.store";
import {
  AgentUnavailableError,
  type AgentLoopPolicyView,
  type AgentResolver,
  type ResolvedAgent,
} from "./agent-runtime";

/**
 * DB 驱动的 agent 解析器（执行侧）。语义（设计 §4/§5，负向 1/2）：
 *   1. 平台目录行不存在 → AGENT_NOT_REGISTERED
 *   2. status=DISABLED  → AGENT_DISABLED
 *
 * 解析结果按 (workspace, agentKey) 缓存 `ttlMs`（默认 30s，与技能解析器同口径）：
 * ops 启停在新解析时立即生效，worker 内最迟一个 TTL。
 */

export interface DbAgentResolver extends AgentResolver {
  readonly kind: "db";
  invalidate(agentKey?: string): void;
}

export interface DbAgentResolverOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_ROUNDS = 1;

function loopPolicyView(policy: Record<string, unknown>): AgentLoopPolicyView {
  const raw = policy["maxRounds"];
  const rounds =
    typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_ROUNDS;
  return { maxRounds: rounds };
}

export function createDbAgentResolver(
  store: AgentRegistryStore,
  options: DbAgentResolverOptions = {},
): DbAgentResolver {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; agent: ResolvedAgent }>();

  const cacheKey = (workspaceId: string, agentKey: string): string =>
    `${workspaceId}\u0000${agentKey}`;

  async function resolve(agentKey: string, workspaceId: string): Promise<ResolvedAgent> {
    const key = cacheKey(workspaceId, agentKey);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.agent;

    const profile = await store.loadProfile(workspaceId, agentKey);
    if (!profile) {
      throw new AgentUnavailableError("AGENT_NOT_REGISTERED", `${agentKey} is not registered`);
    }
    if (profile.status !== "ACTIVE") {
      throw new AgentUnavailableError("AGENT_DISABLED", `${agentKey} is disabled for the platform`);
    }

    const agent: ResolvedAgent = {
      agentKey: profile.agentKey,
      name: profile.name,
      rolePromptVersion: profile.rolePromptVersion,
      skillKeys: [...profile.skillKeys],
      modelPolicy: { ...profile.modelPolicy },
      memoryScope: profile.memoryScope,
      loopPolicy: loopPolicyView(profile.loopPolicy),
    };
    cache.set(key, { expiresAt: now() + ttlMs, agent });
    return agent;
  }

  return {
    kind: "db",
    resolve,
    invalidate(agentKey?: string): void {
      if (agentKey === undefined) {
        cache.clear();
        return;
      }
      for (const key of cache.keys()) {
        if (key.split("\u0000")[1] === agentKey) cache.delete(key);
      }
    },
  };
}
