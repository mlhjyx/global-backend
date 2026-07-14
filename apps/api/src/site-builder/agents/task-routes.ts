/**
 * site_builder per-task 模型路由（09 §3 施工执行版；02 §6 终版定档 2026-07-14 唯一真值）。
 *
 * 配置驱动（D-M1-2）：默认值=今天网关里已实测活的模型；通道接入后翻 env
 * `SITE_BUILDER_MODEL_<TASK>` / `SITE_BUILDER_FALLBACKS_<TASK>` + 重启 worker 即切换，
 * 不改代码（获客侧 #35 先例：旧进程持旧注册表须重启）。
 * 回退链语义=合法路由（AiTask 基类逐模型尝试），非静默降级。
 */

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
  primary: string;
  fallbacks: string[];
  maxTokens: number;
  timeoutMs: number;
  /** 🔴 reasoning 模型护栏：v4-pro 做 copy 必配 low（评测实证，02 §6）。 */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

const ASSEMBLE_TIMEOUT_MS = 180_000; // glm-5.2 组装超时预算（用户拍板：宁慢勿错，超时走回退链）

const DEFAULT_ROUTES: Record<SiteBuilderTaskId, TaskRoute> = {
  // H2：deepseek v4 是 reasoning 模型，maxTokens 过小时思考吃光预算 → content 空。
  // 12000=真机校准值（6000 时 v4-pro 两跑两截断：一次空 content、一次 JSON 中断，均落回退链）。
  'site_builder.brand_profile': {
    primary: 'deepseek-v4-pro',
    fallbacks: ['glm-5.2'],
    maxTokens: 12_000,
    timeoutMs: 150_000,
  },
  'site_builder.copy': {
    primary: 'deepseek-v4-pro',
    fallbacks: ['glm-5.2', 'doubao-seed-2.0-pro'],
    maxTokens: 4000,
    timeoutMs: 120_000,
    reasoningEffort: 'low',
  },
  'site_builder.design_spec': {
    primary: 'minimax-m3',
    fallbacks: ['doubao-seed-2.0-pro'],
    maxTokens: 4000,
    timeoutMs: 120_000,
  },
  'site_builder.assemble': {
    primary: 'glm-5.2',
    fallbacks: ['deepseek-v4-pro'],
    maxTokens: 16_000,
    timeoutMs: ASSEMBLE_TIMEOUT_MS,
  },
  'site_builder.assembly_fix': {
    primary: 'glm-5.2',
    fallbacks: ['deepseek-v4-pro'],
    maxTokens: 8000,
    timeoutMs: ASSEMBLE_TIMEOUT_MS,
  },
  'site_builder.qa_summarize': {
    primary: 'deepseek-v4-flash',
    fallbacks: ['doubao-seed-2.0-lite'],
    maxTokens: 3000,
    timeoutMs: 90_000,
  },
  'site_builder.seo_review': {
    primary: 'deepseek-v4-flash',
    fallbacks: ['doubao-seed-2.0-lite'],
    maxTokens: 3000,
    timeoutMs: 90_000,
  },
};

/** taskId → env 后缀：site_builder.brand_profile → BRAND_PROFILE。 */
function envSuffix(taskId: SiteBuilderTaskId): string {
  return taskId.split('.')[1].toUpperCase();
}

export function resolveTaskRoute(
  taskId: SiteBuilderTaskId,
  env: NodeJS.ProcessEnv = process.env,
): TaskRoute {
  const defaults = DEFAULT_ROUTES[taskId];
  if (!defaults) throw new Error(`unknown site_builder task: ${taskId}`);

  const suffix = envSuffix(taskId);
  const primary = env[`SITE_BUILDER_MODEL_${suffix}`]?.trim();
  const fallbacksRaw = env[`SITE_BUILDER_FALLBACKS_${suffix}`];
  const fallbacks = fallbacksRaw
    ?.split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  return {
    ...defaults,
    ...(primary ? { primary } : {}),
    ...(fallbacks ? { fallbacks } : {}),
  };
}
