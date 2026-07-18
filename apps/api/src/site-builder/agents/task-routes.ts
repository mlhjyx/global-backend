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
import { SITE_BUILDER_MODEL_PROFILES, type SiteBuilderModelProfileId } from './model-profiles';

export const SITE_BUILDER_TASK_IDS = [
  'site_builder.brand_profile',
  'site_builder.copy',
  'site_builder.design_spec',
  'site_builder.assemble',
  'site_builder.assembly_fix',
  'site_builder.qa_summarize',
  'site_builder.seo_review',
] as const;

export type SiteBuilderTaskId = (typeof SITE_BUILDER_TASK_IDS)[number];

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

const ASSEMBLE_TIMEOUT_MS = 180_000; // 组装超时预算（用户拍板：宁慢勿错，超时走回退链）

interface TaskRouteBinding {
  profile: SiteBuilderModelProfileId;
  maxTokens: number;
  timeoutMs: number;
  maxCostCents: number;
  reasoningEffort?: TaskRoute['reasoningEffort'];
}

const TASK_BINDINGS: Record<SiteBuilderTaskId, TaskRouteBinding> = {
  'site_builder.brand_profile': {
    profile: 'structured.workspace_materials',
    // H2：现役 reasoning 模型在 6000 token 时两跑截断；12000 是当前校准预算。
    maxTokens: 12_000,
    timeoutMs: 150_000,
    // Matches the pre-MODEL-0 ai-task registry declaration.
    maxCostCents: 40,
  },
  'site_builder.copy': {
    profile: 'copy.premium',
    maxTokens: 4000,
    timeoutMs: 120_000,
    maxCostCents: 20,
    reasoningEffort: 'low',
  },
  'site_builder.design_spec': {
    profile: 'structured.default',
    maxTokens: 4000,
    timeoutMs: 120_000,
    maxCostCents: 20,
  },
  'site_builder.assemble': {
    profile: 'structured.default',
    maxTokens: 16_000,
    timeoutMs: ASSEMBLE_TIMEOUT_MS,
    maxCostCents: 20,
  },
  'site_builder.assembly_fix': {
    profile: 'structured.default',
    maxTokens: 8000,
    timeoutMs: ASSEMBLE_TIMEOUT_MS,
    maxCostCents: 20,
  },
  'site_builder.qa_summarize': {
    profile: 'text.summary',
    maxTokens: 3000,
    timeoutMs: 90_000,
    maxCostCents: 20,
  },
  'site_builder.seo_review': {
    profile: 'text.summary',
    maxTokens: 3000,
    timeoutMs: 90_000,
    maxCostCents: 20,
  },
};

/** taskId → env 后缀：site_builder.brand_profile → BRAND_PROFILE。 */
function envSuffix(taskId: SiteBuilderTaskId): string {
  return taskId.split('.')[1].toUpperCase();
}

/**
 * Profile is an independent operational override. It changes the semantic
 * policy binding only; MODEL-0 deliberately keeps the task's current model
 * snapshot and existing `SITE_BUILDER_MODEL_*` behavior untouched.
 */
function resolveProfileOverride(
  suffix: string,
  defaultProfile: SiteBuilderModelProfileId,
  env: NodeJS.ProcessEnv,
): SiteBuilderModelProfileId {
  const profile = env[`SITE_BUILDER_PROFILE_${suffix}`]?.trim();
  if (!profile) return defaultProfile;
  if (!Object.hasOwn(SITE_BUILDER_MODEL_PROFILES, profile)) {
    throw new Error(`unknown Site Builder model profile: ${profile}`);
  }
  return profile as SiteBuilderModelProfileId;
}

function resolveRollbackOverride(suffix: string, env: NodeJS.ProcessEnv): boolean {
  const name = `SITE_BUILDER_MODEL_ROLLBACK_${suffix}`;
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

export function resolveTaskRoute(taskId: SiteBuilderTaskId, env: NodeJS.ProcessEnv = process.env): TaskRoute {
  const binding = TASK_BINDINGS[taskId];
  if (!binding) throw new Error(`unknown site_builder task: ${taskId}`);
  const suffix = envSuffix(taskId);
  const activePolicy = modelPolicyRegistry.getActiveTaskPolicy(taskId);
  const rollback = resolveRollbackOverride(suffix, env);
  if (rollback && activePolicy.state !== 'promotedRoute') {
    throw new Error(`${taskId} has no promoted route to roll back`);
  }
  const selectedPolicy = rollback
    ? modelPolicyRegistry.getLegacyTaskPolicy(taskId)
    : activePolicy;
  const selectedRoute = selectedPolicy.route;
  const profile = resolveProfileOverride(suffix, binding.profile, env);
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
    profile !== binding.profile ||
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
