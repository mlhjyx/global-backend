/**
 * 跨通道模型自动降级链（Batch 1.4-A）：
 *
 * 仅在非 site-builder 结算路径、非平台出网围栏路径、且 D13 确定未计费上游故障
 * （`definiteModelFailureCode(err) !== undefined`，如中转池 HTTP 429/500-503 或建连失败、
 * 原预算预留已 RELEASED）时启用，避免单条中转线路临时抖动直接打断客户任务。
 *
 * 治理护栏：
 *  - 默认关闭，需部署显式开启 `MODEL_CROSS_CHANNEL_FALLBACK_ENABLED=on` 或配置
 *    `MODEL_CROSS_CHANNEL_FALLBACKS_JSON`；
 *  - 终判任务（`discovery.qualify_fit`）严格受 `JUDGE_MODEL_ALLOWLIST` 约束，绝不降级到 flash 档；
 *  - 最多尝试 2 个跨通道备选模型，严格去重并排除当前失败主模型。
 */
import {
  isJudgeFinalVerdictTask,
  isJudgeModelAllowlisted,
  judgeAllowsFlash,
} from '../ai-tasks/judge-model-routing';
import { isLegacyExecutionBudgetBypass } from '../execution-budget/legacy-execution-budget-mode';

export const MODEL_CROSS_CHANNEL_FALLBACK_ENABLED_ENV = 'MODEL_CROSS_CHANNEL_FALLBACK_ENABLED';
export const MODEL_CROSS_CHANNEL_FALLBACKS_JSON_ENV = 'MODEL_CROSS_CHANNEL_FALLBACKS_JSON';

const MAX_FALLBACK_CANDIDATES = 2;
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;

/** 经 2026-11-25 4router + DeepSeek 官方 20 模型实测验证的跨渠道降级表（Ch.6 Claude ↔ Ch.7 GPT ↔ Ch.5 Gemini ↔ Ch.1 DeepSeek）。 */
export const DEFAULT_CROSS_CHANNEL_FALLBACKS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'claude-sonnet-5-5': Object.freeze(['gpt-6.2-sol', 'deepseek-flash']),
  'claude-sonnet-4-6': Object.freeze(['gpt-6.2-sol', 'deepseek-flash']),
  'gpt-6.2-sol': Object.freeze(['claude-sonnet-5-5', 'gemini-4-argon', 'deepseek-v4-pro']),
  'gpt-6-luna': Object.freeze(['deepseek-flash', 'gpt-6.2-sol']),
  'gemini-4-argon': Object.freeze(['gpt-6.2-sol', 'claude-sonnet-5-5']),
});

function parseEnvFallbackMap(raw: string | undefined): Record<string, readonly string[]> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, readonly string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!MODEL_NAME_RE.test(key.trim()) || !Array.isArray(value)) continue;
      const clean = value
        .filter((item): item is string => typeof item === 'string' && MODEL_NAME_RE.test(item.trim()))
        .map((item) => item.trim());
      if (clean.length > 0) out[key.trim()] = Object.freeze(clean);
    }
    return out;
  } catch {
    return null;
  }
}

export function isCrossChannelFallbackEnabled(
  env: { readonly [key: string]: string | undefined } = process.env,
): boolean {
  const flag = (env[MODEL_CROSS_CHANNEL_FALLBACK_ENABLED_ENV] ?? '').trim().toLowerCase();
  if (flag === 'on' || flag === 'true' || flag === '1') return true;
  if (flag === 'off' || flag === 'false' || flag === '0') return false;
  return Boolean((env[MODEL_CROSS_CHANNEL_FALLBACKS_JSON_ENV] ?? '').trim());
}

/** 仅在旧执行预算旁路模式下允许主模型单跳超时自动切换备用通道，保持 enforce 模式 D13 fail-closed 不变。 */
export function isCrossChannelTimeoutFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isLegacyExecutionBudgetBypass(env) && isCrossChannelFallbackEnabled(env);
}

/** 解析给定主模型与任务的跨渠道备选模型列表（最多 2 个；终判任务严格遵守 JUDGE_MODEL_ALLOWLIST）。 */
export function resolveCrossChannelFallbackModels(
  requestedModel: string | undefined,
  taskId: string,
  env: { readonly [key: string]: string | undefined } = process.env,
): readonly string[] {
  const primary = (requestedModel ?? '').trim();
  if (!primary || !isCrossChannelFallbackEnabled(env)) return [];

  const custom = parseEnvFallbackMap(env[MODEL_CROSS_CHANNEL_FALLBACKS_JSON_ENV]);
  const rawList = custom?.[primary] ?? DEFAULT_CROSS_CHANNEL_FALLBACKS[primary] ?? [];
  if (rawList.length === 0) return [];

  const enforceJudgeAllowlist = isJudgeFinalVerdictTask(taskId) && !judgeAllowsFlash(env);
  const out: string[] = [];
  for (const candidate of rawList) {
    if (candidate === primary || out.includes(candidate)) continue;
    if (enforceJudgeAllowlist && !isJudgeModelAllowlisted(candidate)) continue;
    out.push(candidate);
    if (out.length >= MAX_FALLBACK_CANDIDATES) break;
  }
  return out;
}
