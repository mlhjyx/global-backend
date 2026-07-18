/**
 * site_builder per-task 模型路由（09 §3 施工执行版；02 §6 终版定档 2026-07-14 唯一真值）。
 *
 * 配置驱动（D-M1-2）：任务只绑定 ModelProfile + budget；现役模型快照由
 * ModelPolicyRegistry 解析。通道接入后仍可翻 env
 * `SITE_BUILDER_MODEL_<TASK>` / `SITE_BUILDER_FALLBACKS_<TASK>` + 重启 worker 即切换，
 * `SITE_BUILDER_MODEL_ROLLBACK_<TASK>=true` 则回到该任务冻结的 legacy currentRoute。
 * 紧急 model/fallback override 优先于 rollback（获客侧 #35 先例：旧进程持旧注册表须重启）。
 * 回退链语义=合法路由（AiTask 基类逐模型尝试），非静默降级。
 */

import type { ModelDataPolicy, ModelExecutionPolicySnapshot } from '@global/contracts';
import { modelPolicyRegistry } from './model-policy.registry';
import type { SiteBuilderModelProfileId } from './model-profiles';
import {
  getSiteBuilderTaskRouteBinding,
  SITE_BUILDER_TASK_IDS,
  type SiteBuilderTaskId,
  type SiteBuilderTaskRouteBinding,
} from './task-route-bindings';

export { SITE_BUILDER_TASK_IDS, type SiteBuilderTaskId };

export interface TaskRoute {
  profile: SiteBuilderModelProfileId;
  primary: string;
  fallbacks: string[];
  maxTokens: number;
  timeoutMs: number;
  /** Hard reserve/settle ceiling; 20¢ retains the legacy gateway default. */
  maxCostCents: number;
  /** Profile-derived handling constraint, attached to the execution trace. */
  dataPolicy: ModelDataPolicy;
  /** Resolved production-policy snapshot for audit/replay. */
  policy: ModelExecutionPolicySnapshot;
  /** 🔴 reasoning 模型护栏：v4-pro 做 copy 必配 low（评测实证，02 §6）。 */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

type TaskRouteBinding = SiteBuilderTaskRouteBinding & {
  profile: SiteBuilderModelProfileId;
};

/** taskId → env 后缀：site_builder.brand_profile → BRAND_PROFILE。 */
function envSuffix(taskId: SiteBuilderTaskId): string {
  return taskId.split('.')[1].toUpperCase();
}

function assertNoProfileOverride(suffix: string, env: NodeJS.ProcessEnv): void {
  if (env[`SITE_BUILDER_PROFILE_${suffix}`] !== undefined) {
    throw new Error(
      `SITE_BUILDER_PROFILE_${suffix} profile override is not supported`,
    );
  }
}

function resolveRollbackOverride(suffix: string, env: NodeJS.ProcessEnv): boolean {
  const name = `SITE_BUILDER_MODEL_ROLLBACK_${suffix}`;
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

export function resolveTaskRoute(taskId: SiteBuilderTaskId, env: NodeJS.ProcessEnv = process.env): TaskRoute {
  const binding = getSiteBuilderTaskRouteBinding(taskId) as TaskRouteBinding;
  const suffix = envSuffix(taskId);
  assertNoProfileOverride(suffix, env);
  const activePolicy = modelPolicyRegistry.getActiveTaskPolicy(taskId);
  const rollback = resolveRollbackOverride(suffix, env);
  if (rollback && activePolicy.state !== 'promotedRoute') {
    throw new Error(`${taskId} has no promoted route to roll back`);
  }
  const selectedPolicy = rollback
    ? modelPolicyRegistry.getLegacyTaskPolicy(taskId)
    : activePolicy;
  const selectedRoute = selectedPolicy.route;
  const profile = binding.profile;
  const primary = env[`SITE_BUILDER_MODEL_${suffix}`]?.trim();
  const fallbacksRaw = env[`SITE_BUILDER_FALLBACKS_${suffix}`];
  const fallbacks = fallbacksRaw
    ?.split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const resolvedPrimary = primary || selectedRoute.primary;
  const resolvedFallbacks = fallbacks || [...selectedRoute.fallbacks];
  const profileDefinition = modelPolicyRegistry.getProfile(profile);
  const emergencyOverride =
    primary !== undefined ||
    fallbacksRaw !== undefined;
  const source = emergencyOverride
    ? 'env_override'
    : rollback
      ? 'rollback_override'
      : 'registry';
  // An operator override deliberately leaves the evidence-bound promoted
  // route. Keep the actual route in the trace, but never attribute an
  // un-evaluated model/profile/fallback combination to the registry's
  // promotion report.
  const routeState = emergencyOverride ? 'currentRoute' : selectedPolicy.state;
  const policy: ModelExecutionPolicySnapshot = {
    policyVersion: modelPolicyRegistry.getPolicyVersion(),
    profile,
    routeState,
    lifecycle: selectedPolicy.lifecycle,
    source,
    ...(!emergencyOverride && selectedPolicy.state === 'promotedRoute'
      ? { promotionEvidenceId: selectedPolicy.promotionEvidenceId }
      : {}),
    dataPolicy: profileDefinition.dataPolicy,
    maxCostCents: binding.maxCostCents,
    route: { primary: resolvedPrimary, fallbacks: [...resolvedFallbacks] },
  };

  return {
    ...binding,
    profile,
    primary: resolvedPrimary,
    fallbacks: [...resolvedFallbacks],
    dataPolicy: { ...profileDefinition.dataPolicy },
    policy,
  };
}
