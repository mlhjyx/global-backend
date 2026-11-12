import type {
  CatchAllClass,
  EmailVerificationState,
} from '../../discovery/contact-point-verification-state';
import type { EmailVerificationProviderResult } from './email-verification-provider';
import { unavailableProviderResult } from './email-verification-provider';
import { scoreEmailPoint } from './verification-policy';

/**
 * P2-8：四个 HTTP 验证器（MillionVerifier / ZeroBounce / Emailable / Truelist）的共享骨架。
 *
 * 四家的差异只有 env 名字/默认值、请求 URL 与响应→四态的映射；config 解析、
 * 未配置降级、超时/网络/429/非 2xx 错误映射、JSON 解析与最终结果装配逐字相同，
 * 此前在四个文件里各写一遍。行为契约保持不变：任何错误都降级为 UNKNOWN 且不计费，
 * 成功解析出的裁决按次计费。
 */

export interface ProviderHttpConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export interface ProviderHttpConfigSpec {
  keyEnv: string;
  baseUrlEnv: string;
  timeoutEnv: string;
  costEnv: string;
  defaultBaseUrl: string;
  defaultTimeoutMs: number;
  defaultCostMicrousd: number;
}

export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveProviderHttpConfig(
  env: NodeJS.ProcessEnv,
  spec: ProviderHttpConfigSpec,
): ProviderHttpConfig {
  return {
    apiKey: (env[spec.keyEnv] ?? '').trim() || null,
    baseUrl: (env[spec.baseUrlEnv] ?? spec.defaultBaseUrl).replace(/\/+$/u, ''),
    timeoutMs: positiveIntEnv(env[spec.timeoutEnv], spec.defaultTimeoutMs),
    costMicrousd: positiveIntEnv(env[spec.costEnv], spec.defaultCostMicrousd),
  };
}

/** 各 provider 映射函数的公共形状（四态 + catch-all 子类 + 供应商细节）。 */
export interface VerificationMapping {
  state: EmailVerificationState;
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  catchAllClass: CatchAllClass;
  acceptAll: boolean | null;
  disposable: boolean | null;
  role: boolean | null;
  detail: string;
  error: string | null;
}

/**
 * 供应商错误（error 非空）不计费；解析出的裁决（含 unknown）按次计费。
 * `detail` 可覆盖（Emailable/ZeroBounce 在映射 detail 上追加供应商原始字段）。
 */
export function assembleProviderResult(input: {
  providerKey: string;
  mapping: VerificationMapping;
  detail?: string;
  costMicrousd: number;
  startedAt: number;
}): EmailVerificationProviderResult {
  const { mapping } = input;
  return {
    providerKey: input.providerKey,
    state: mapping.state,
    catchAll: mapping.catchAll,
    catchAllClass: mapping.catchAllClass,
    score: scoreEmailPoint({
      state: mapping.state,
      catchAllClass: mapping.catchAllClass,
    }),
    acceptAll: mapping.acceptAll,
    disposable: mapping.disposable,
    role: mapping.role,
    detail: input.detail ?? mapping.detail,
    error: mapping.error,
    costMicrousd: mapping.error === null ? input.costMicrousd : 0,
    latencyMs: Date.now() - input.startedAt,
  };
}

export type ProviderJsonOutcome =
  | { body: unknown }
  | { unavailable: EmailVerificationProviderResult };

/** 未配置 → 网络/超时 → 429 → 非 2xx → JSON（畸形体返回 null，由映射函数判 malformed）。 */
export async function fetchProviderJson(input: {
  providerKey: string;
  apiKey: string | null;
  unconfiguredDetail: string;
  url: URL;
  headers?: Record<string, string>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  startedAt: number;
}): Promise<ProviderJsonOutcome> {
  const latency = () => Date.now() - input.startedAt;
  if (!input.apiKey) {
    return {
      unavailable: unavailableProviderResult({
        providerKey: input.providerKey,
        error: 'provider_unconfigured',
        detail: input.unconfiguredDetail,
        latencyMs: latency(),
      }),
    };
  }
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: 'GET',
      ...(input.headers ? { headers: input.headers } : {}),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      unavailable: unavailableProviderResult({
        providerKey: input.providerKey,
        error: timedOut ? 'timeout' : 'network_error',
        detail: timedOut ? 'provider_timeout' : 'provider_network_error',
        latencyMs: latency(),
      }),
    };
  }
  if (response.status === 429) {
    return {
      unavailable: unavailableProviderResult({
        providerKey: input.providerKey,
        error: 'rate_limited',
        detail: 'provider_http_429',
        latencyMs: latency(),
      }),
    };
  }
  if (!response.ok) {
    return {
      unavailable: unavailableProviderResult({
        providerKey: input.providerKey,
        error: `http_${response.status}`,
        detail: `provider_http_${response.status}`,
        latencyMs: latency(),
      }),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { body };
}
