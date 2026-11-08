import type { CatchAllClass, EmailVerificationState } from '../../discovery/contact-point-verification-state';
import { scoreEmailPoint } from './verification-policy';
import {
  unavailableProviderResult,
  type EmailVerificationProvider,
  type EmailVerificationProviderResult,
  type EmailVerificationRequest,
} from './email-verification-provider';

/**
 * Emailable（api.emailable.com/v1/verify）验证器客户端 —— 双正规则里的「第二票」。
 *
 * 映射（供应商 `state` 词表 → 四态；计划 §2.3.5.2）：
 *  - `deliverable` → VALID（accept_all 不为 false 时按 catch-all 层处理，缺字段同样保守）；
 *  - `undeliverable` / `disposable` → INVALID；
 *  - `risky` → accept_all=true 时 CATCH_ALL_RISKY·true_catch_all，否则 UNKNOWN（不是地址级证据）；
 *  - `unknown` / 畸形体 / 供应商错误 → UNKNOWN。
 *  - Emailable 自带 `score`（0–100）：作为 detail 留痕；基础分仍用 scoreEmailPoint 的统一口径，
 *    避免两套评分表面。
 *
 * 凭据与参数从 env 读（EMAILABLE_API_KEY / _BASE_URL / _TIMEOUT_MS / _COST_MICROUSD，
 * $0.0076/条 = 7600 微美元）；缺 key 时 `isConfigured()=false`，verify 降级 UNKNOWN。
 * HTTP 走注入的 fetch（单测 fixture，零真实出网）；429/5xx/超时/畸形体一律 UNKNOWN + error。
 */

export interface EmailableConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export function resolveEmailableConfig(env: NodeJS.ProcessEnv = process.env): EmailableConfig {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    apiKey: (env.EMAILABLE_API_KEY ?? '').trim() || null,
    baseUrl: (env.EMAILABLE_BASE_URL ?? 'https://api.emailable.com').replace(/\/+$/u, ''),
    timeoutMs: positiveInt(env.EMAILABLE_TIMEOUT_MS, 8_000),
    // $0.0076/条（5K credits $38，2026-11-08 快照）→ 7600 微美元。
    costMicrousd: positiveInt(env.EMAILABLE_COST_MICROUSD, 7_600),
  };
}

export interface EmailableMapping {
  state: EmailVerificationState;
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  catchAllClass: CatchAllClass;
  acceptAll: boolean | null;
  disposable: boolean | null;
  role: boolean | null;
  detail: string;
  error: string | null;
  /** 供应商自带评分（0–100，可能缺失）。 */
  providerScore: number | null;
}

/** 供应商响应 → 四态映射（纯函数；畸形/未成功一律 UNKNOWN）。 */
export function mapEmailableResponse(raw: unknown): EmailableMapping {
  const base = {
    acceptAll: null as boolean | null,
    disposable: null as boolean | null,
    role: null as boolean | null,
    providerScore: null as number | null,
  };
  const unknown = (detail: string, error: string | null): EmailableMapping => ({
    state: 'UNKNOWN',
    catchAll: 'unknown',
    catchAllClass: 'unknown',
    ...base,
    detail,
    error,
  });
  if (!raw || typeof raw !== 'object') return unknown('malformed_response', 'malformed_response');
  const body = raw as Record<string, unknown>;
  const state = typeof body.state === 'string' ? body.state.trim().toLowerCase() : '';
  const reason = typeof body.reason === 'string' ? body.reason : null;
  const acceptAll = typeof body.accept_all === 'boolean' ? body.accept_all : null;
  const disposable = typeof body.disposable === 'boolean' ? body.disposable : null;
  const role = typeof body.role === 'boolean' ? body.role : null;
  const providerScore =
    typeof body.score === 'number' && Number.isFinite(body.score)
      ? Math.max(0, Math.min(100, Math.round(body.score)))
      : null;
  const detail = reason ? `${state || 'no_state'}:${reason}` : state || 'no_state';
  const withFeatures = { acceptAll, disposable, role, providerScore };

  if (body.success === false) {
    const error = typeof body.message === 'string' && body.message ? body.message : 'provider_error';
    return { ...unknown(detail, error), ...withFeatures };
  }
  switch (state) {
    case 'deliverable':
      // accept_all 优先：只有明确 false 才判 VALID；true → true_catch_all；缺字段 → inconclusive。
      if (acceptAll !== false) {
        return {
          state: 'CATCH_ALL_RISKY',
          catchAll: acceptAll === true ? 'catch_all' : 'inconclusive',
          catchAllClass: acceptAll === true ? 'true_catch_all' : 'inconclusive',
          ...withFeatures,
          detail,
          error: null,
        };
      }
      return {
        state: 'VALID',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        ...withFeatures,
        detail,
        error: null,
      };
    case 'undeliverable':
      return {
        state: 'INVALID',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        ...withFeatures,
        detail,
        error: null,
      };
    case 'disposable':
      return {
        state: 'INVALID',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        ...withFeatures,
        detail: `disposable:${reason ?? 'yes'}`,
        error: null,
      };
    case 'risky':
      if (acceptAll === true) {
        return {
          state: 'CATCH_ALL_RISKY',
          catchAll: 'catch_all',
          catchAllClass: 'true_catch_all',
          ...withFeatures,
          detail,
          error: null,
        };
      }
      // risky 不是地址级证据：记 UNKNOWN（进重验/解析器队列），不进 CATCH_ALL_RISKY。
      return { ...unknown(detail, null), ...withFeatures };
    case 'unknown':
      return { ...unknown(detail, null), ...withFeatures };
    default:
      return {
        ...unknown(detail, state ? `unrecognized_state:${state}` : 'malformed_response'),
        ...withFeatures,
      };
  }
}

export class EmailableProvider implements EmailVerificationProvider {
  readonly key = 'emailable';
  readonly domain = 'api.emailable.com';

  constructor(
    private readonly config: EmailableConfig = resolveEmailableConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.config.apiKey !== null;
  }

  async verify(request: EmailVerificationRequest): Promise<EmailVerificationProviderResult> {
    const startedAt = Date.now();
    if (!this.config.apiKey) {
      return unavailableProviderResult({
        providerKey: this.key,
        error: 'provider_unconfigured',
        detail: 'EMAILABLE_API_KEY 未配置，降级 UNKNOWN',
        latencyMs: Date.now() - startedAt,
      });
    }
    const url = new URL(`${this.config.baseUrl}/v1/verify`);
    url.searchParams.set('email', request.email);
    url.searchParams.set('api_key', this.config.apiKey);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return unavailableProviderResult({
        providerKey: this.key,
        error: timedOut ? 'timeout' : 'network_error',
        detail: timedOut ? 'provider_timeout' : 'provider_network_error',
        latencyMs: Date.now() - startedAt,
      });
    }
    if (response.status === 429) {
      return unavailableProviderResult({
        providerKey: this.key,
        error: 'rate_limited',
        detail: 'provider_http_429',
        latencyMs: Date.now() - startedAt,
      });
    }
    if (!response.ok) {
      return unavailableProviderResult({
        providerKey: this.key,
        error: `http_${response.status}`,
        detail: `provider_http_${response.status}`,
        latencyMs: Date.now() - startedAt,
      });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const mapping = mapEmailableResponse(body);
    return {
      providerKey: this.key,
      state: mapping.state,
      catchAll: mapping.catchAll,
      catchAllClass: mapping.catchAllClass,
      score: scoreEmailPoint({ state: mapping.state, catchAllClass: mapping.catchAllClass }),
      acceptAll: mapping.acceptAll,
      disposable: mapping.disposable,
      role: mapping.role,
      // 供应商自带 score 留痕在 detail（基础分口径由 scoreEmailPoint 统一）。
      detail: mapping.providerScore === null ? mapping.detail : `${mapping.detail};score=${mapping.providerScore}`,
      error: mapping.error,
      // 供应商侧错误（无有效裁决）不计费；解析出的裁决按次计费。
      costMicrousd: mapping.error === null ? this.config.costMicrousd : 0,
      latencyMs: Date.now() - startedAt,
    };
  }
}
