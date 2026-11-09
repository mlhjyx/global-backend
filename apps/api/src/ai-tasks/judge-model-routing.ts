/**
 * 终判 judge 任务的模型路由护栏（P3 J03；设计 §4.3.3.6）。
 *
 * 背景（2026-11-09 线上实测）：`MODEL_ACQUISITION_TASK_MODELS` 里一条
 * `{"discovery.qualify_fit":"gemini-3.8-flash"}` 把 L2 深判拖到了 flash 档——
 * 这是「判定 45% 失败」的直接工程根因之一。本模块把「终判只允许 pro 档白名单」
 * 固化成代码：
 *  - 非白名单的 per-task override 在注册表解析时被忽略（回落 tier 默认，并留痕）；
 *  - 启动自检：终判任务最终解析到的模型必须在白名单内，除非显式
 *    `JUDGE_ALLOW_FLASH=true`（fail-closed）；
 *  - 模型身份替换（MODEL_IDENTITY_SUBSTITUTES）对终判任务收紧为只接受白名单目标，
 *    防止 deepseek-v4-pro→flash 这类「同代理换模型」把终判悄悄降档。
 *
 * 本文件故意零依赖：task-registry 与 model-gateway 都可以安全静态引用，不产生环。
 */

/** 产出最终 verdict 的 judge 任务（L2 深判）。L1 快扫的 provisional 判定不在其列。 */
export const JUDGE_FINAL_VERDICT_TASK_IDS: readonly string[] = Object.freeze([
  'discovery.qualify_fit',
]);

/**
 * 已过金标校准、允许做终判的模型白名单（设计 §4.3.3.6：pro 档）。
 * 新增模型必须先跑金标（J13）再进这里——白名单只许经评审收紧/替换。
 */
export const JUDGE_MODEL_ALLOWLIST: readonly string[] = Object.freeze([
  'deepseek-v4-pro',
  'gemini-4-argon-high',
  // gpt-5.6-sol 仅限非生命科学域（2026-11-02 拒答事故），域限制在调用侧执行。
  'gpt-5.6-sol',
]);

export const JUDGE_ALLOW_FLASH_ENV = 'JUDGE_ALLOW_FLASH';

export function judgeAllowsFlash(
  env: { readonly [key: string]: string | undefined } = process.env,
): boolean {
  return (env[JUDGE_ALLOW_FLASH_ENV] ?? '').trim().toLowerCase() === 'true';
}

export function isJudgeFinalVerdictTask(taskId: string): boolean {
  return JUDGE_FINAL_VERDICT_TASK_IDS.includes(taskId);
}

export function isJudgeModelAllowlisted(model: string): boolean {
  return JUDGE_MODEL_ALLOWLIST.includes(model.trim());
}

/**
 * 终判任务的模型身份替换过滤：非白名单目标一律剔除（剔除后为空 = 只接受精确身份，
 * 上游换模型会被身份门拒绝——fail closed）。`JUDGE_ALLOW_FLASH=true` 时不收紧。
 */
export function filterJudgeSubstitutes(
  taskId: string,
  substitutes: readonly string[],
  env: { readonly [key: string]: string | undefined } = process.env,
): readonly string[] {
  if (!isJudgeFinalVerdictTask(taskId) || judgeAllowsFlash(env)) {
    return substitutes;
  }
  return substitutes.filter((model) => isJudgeModelAllowlisted(model));
}

/**
 * 启动自检：每个终判任务都必须解析到白名单模型。
 * `resolveModel` 由调用方注入（注册表的 getTask），避免本模块反向依赖注册表。
 */
export function assertJudgeModelRouting(
  resolveModel: (taskId: string) => string | undefined,
  env: { readonly [key: string]: string | undefined } = process.env,
): void {
  if (judgeAllowsFlash(env)) return;
  for (const taskId of JUDGE_FINAL_VERDICT_TASK_IDS) {
    const model = resolveModel(taskId)?.trim();
    if (!model) {
      throw new Error(
        `judge routing: ${taskId} is missing from the task registry; a final-verdict judge cannot start without a pinned model`,
      );
    }
    if (!isJudgeModelAllowlisted(model)) {
      throw new Error(
        `judge routing: ${taskId} resolves to "${model}", which is not on JUDGE_MODEL_ALLOWLIST (${JUDGE_MODEL_ALLOWLIST.join(', ')}). ` +
          `Set MODEL_ACQUISITION_REASONING_MODEL (or the ${taskId} entry in MODEL_ACQUISITION_TASK_MODELS) to an allowlisted pro-tier model, ` +
          `or set ${JUDGE_ALLOW_FLASH_ENV}=true to allow a flash-tier judge deliberately.`,
      );
    }
  }
}
