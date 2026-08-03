/**
 * site_builder per-task 模型路由（09 §3 施工执行版；02 §6 终版定档 2026-07-14 唯一真值）。
 *
 * 配置驱动（D-M1-2）：任务只绑定 ModelProfile + budget；现役模型快照由
 * ModelPolicyRegistry 解析。通道接入后仍可翻 env
 * `SITE_BUILDER_MODEL_<TASK>` / `SITE_BUILDER_FALLBACKS_<TASK>` + 重启 worker 即切换，
 * `SITE_BUILDER_MODEL_ROLLBACK_<TASK>=true` 只执行独立 rollback policy；
 * 历史 currentRoute 仅作 provenance，不再自动成为可执行回滚。
 * 紧急 model/fallback override 优先于 rollback（获客侧 #35 先例：旧进程持旧注册表须重启）。
 * 回退链语义=合法路由（AiTask 基类逐模型尝试），非静默降级。
 */

import type {
  DeterministicFallback,
  ModelDataPolicy,
  ModelExecutionPolicySnapshot,
} from '@global/contracts';
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

export type TaskExecutionTarget =
  | { kind: 'model_route'; route: TaskRoute }
  | {
      kind: 'deterministic_fallback';
      taskId: SiteBuilderTaskId;
      profile: SiteBuilderModelProfileId;
      fallback: DeterministicFallback;
      source: 'rollback_override';
      rollbackPolicyVersion: string;
    }
  | {
      kind: 'deterministic_fallback';
      taskId: SiteBuilderTaskId;
      profile: SiteBuilderModelProfileId;
      fallback: DeterministicFallback;
      source: 'registry_deterministic';
      policyVersion: string;
    };

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

function resolveRollbackOverride(
  suffix: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const name = `SITE_BUILDER_MODEL_ROLLBACK_${suffix}`;
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

export function resolveTaskExecutionTarget(
  taskId: SiteBuilderTaskId,
  env: NodeJS.ProcessEnv = process.env,
): TaskExecutionTarget {
  const binding = getSiteBuilderTaskRouteBinding(taskId) as TaskRouteBinding;
  const suffix = envSuffix(taskId);
  assertNoProfileOverride(suffix, env);
  const activePolicy = modelPolicyRegistry.getActiveTaskPolicy(taskId);
  const rollback = resolveRollbackOverride(suffix, env);
  if (rollback && activePolicy.state !== 'promotedRoute') {
    throw new Error(`${taskId} has no promoted route to roll back`);
  }
  const rollbackPolicy = rollback
    ? modelPolicyRegistry.getExecutableRollbackPolicy(taskId)
    : null;
  const profile = binding.profile;
  const primary = env[`SITE_BUILDER_MODEL_${suffix}`]?.trim();
  const fallbacksRaw = env[`SITE_BUILDER_FALLBACKS_${suffix}`];
  const fallbacks = fallbacksRaw
    ?.split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const emergencyOverride = primary !== undefined || fallbacksRaw !== undefined;
  if (!rollback && activePolicy.state === 'deterministicFallback') {
    if (emergencyOverride) {
      throw new Error(
        `${taskId} has an active deterministic fallback and does not accept a model override`,
      );
    }
    return {
      kind: 'deterministic_fallback',
      taskId,
      profile,
      fallback: { ...activePolicy.fallback },
      source: 'registry_deterministic',
      policyVersion: modelPolicyRegistry.getPolicyVersion(),
    };
  }
  if (rollbackPolicy?.kind === 'deterministic_fallback' && !emergencyOverride) {
    return {
      kind: 'deterministic_fallback',
      taskId,
      profile,
      fallback: { ...rollbackPolicy.fallback },
      source: 'rollback_override',
      rollbackPolicyVersion: modelPolicyRegistry.getRollbackPolicyVersion(),
    };
  }
  const selectedPolicy = activePolicy;
  if (selectedPolicy.state === 'deterministicFallback') {
    // The only supported deterministic state is handled above before a model
    // execution policy is constructed. A rollback must never silently revive
    // a model route for a task whose active registry policy is deterministic.
    throw new Error(
      `${taskId} has an active deterministic fallback and no model route is available`,
    );
  }
  const selectedRoute =
    rollbackPolicy?.kind === 'model_route'
      ? rollbackPolicy.route
      : selectedPolicy.route;
  const resolvedPrimary = primary || selectedRoute.primary;
  const resolvedFallbacks = fallbacks || [...selectedRoute.fallbacks];
  for (const alias of [resolvedPrimary, ...resolvedFallbacks]) {
    if (modelPolicyRegistry.getAliasRetirementPolicy(alias)) {
      throw new Error(`RETIRED_ALIAS_RUNTIME_FORBIDDEN: ${taskId}:${alias}`);
    }
  }
  const profileDefinition = modelPolicyRegistry.getProfile(profile);
  const source = emergencyOverride
    ? 'env_override'
    : rollback
      ? 'rollback_override'
      : 'registry';
  // An operator override deliberately leaves the evidence-bound promoted
  // route. Keep the actual route in the trace, but never attribute an
  // un-evaluated model/profile/fallback combination to the registry's
  // promotion report.
  const routeState =
    emergencyOverride || rollback ? 'currentRoute' : selectedPolicy.state;
  const policy: ModelExecutionPolicySnapshot = {
    policyVersion: modelPolicyRegistry.getPolicyVersion(),
    profile,
    routeState,
    lifecycle: selectedPolicy.lifecycle,
    source,
    ...(!emergencyOverride &&
    !rollback &&
    selectedPolicy.state === 'promotedRoute'
      ? { promotionEvidenceId: selectedPolicy.promotionEvidenceId }
      : {}),
    ...(rollback && !emergencyOverride
      ? {
          rollbackPolicyVersion:
            modelPolicyRegistry.getRollbackPolicyVersion(),
        }
      : {}),
    dataPolicy: profileDefinition.dataPolicy,
    maxCostCents: binding.maxCostCents,
    route: { primary: resolvedPrimary, fallbacks: [...resolvedFallbacks] },
  };

  return {
    kind: 'model_route',
    route: {
      ...binding,
      profile,
      primary: resolvedPrimary,
      fallbacks: [...resolvedFallbacks],
      dataPolicy: { ...profileDefinition.dataPolicy },
      policy,
    },
  };
}

export function resolveTaskRoute(
  taskId: SiteBuilderTaskId,
  env: NodeJS.ProcessEnv = process.env,
): TaskRoute {
  const target = resolveTaskExecutionTarget(taskId, env);
  if (target.kind === 'deterministic_fallback') {
    throw new Error(
      `${taskId} rollback must execute deterministic fallback ${target.fallback.id}`,
    );
  }
  return target.route;
}
