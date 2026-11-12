import type { CatchAllClass, EmailVerificationState } from '../../discovery/contact-point-verification-state';
import {
  type EmailVerificationProvider,
  type EmailVerificationProviderResult,
  type EmailVerificationRequest,
} from './email-verification-provider';
import {
  assembleProviderResult,
  fetchProviderJson,
  resolveProviderHttpConfig,
  type ProviderHttpConfig,
} from './provider-http';

/**
 * ZeroBounce（api.zerobounce.net/v2/validate）验证器客户端 —— 验证瀑布的**仲裁席**
 * （计划 §2.3.5.1 第 ⑤ 步：仅在标准验证与二次确认冲突/未收敛时调用，控制成本）。
 *
 * 映射（供应商 `status` 词表 → 四态）：
 *  - `valid` → VALID（ZeroBounce 的 catch-all 单独成态，valid 即地址级可投递）；
 *  - `invalid` / `spamtrap` / `abuse` / `do_not_mail` → INVALID（危险/陷阱地址按不可投递处理）；
 *  - `catch-all` → CATCH_ALL_RISKY·true_catch_all；
 *  - `unknown` / 畸形体 → UNKNOWN（有效裁决 error=null、按次计费）。
 *  - 200 响应里的 `error` 字段（如坏 key）→ UNKNOWN + error、不计费。
 *
 * env：ZEROBOUNCE_API_KEY / _BASE_URL / _TIMEOUT_MS / _COST_MICROUSD（默认 $0.0099/条 = 9900 微美元）。
 * 缺 key → isConfigured()=false，verify 降级 UNKNOWN；HTTP 走注入 fetch（fixture 测试，零真实出网）。
 */

export type ZeroBounceConfig = ProviderHttpConfig;

export function resolveZeroBounceConfig(env: NodeJS.ProcessEnv = process.env): ZeroBounceConfig {
  return resolveProviderHttpConfig(env, {
    keyEnv: 'ZEROBOUNCE_API_KEY',
    baseUrlEnv: 'ZEROBOUNCE_BASE_URL',
    timeoutEnv: 'ZEROBOUNCE_TIMEOUT_MS',
    costEnv: 'ZEROBOUNCE_COST_MICROUSD',
    defaultBaseUrl: 'https://api.zerobounce.net',
    defaultTimeoutMs: 8_000,
    // $0.0099/条（ONE $99/10,000，2026-11-08 快照）→ 9900 微美元。
    defaultCostMicrousd: 9_900,
  });
}

export interface ZeroBounceMapping {
  state: EmailVerificationState;
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  catchAllClass: CatchAllClass;
  acceptAll: boolean | null;
  disposable: boolean | null;
  role: boolean | null;
  detail: string;
  error: string | null;
  /** 供应商自带置信信息（子状态等），留痕用。 */
  providerDetail: string | null;
}

export function mapZeroBounceResponse(raw: unknown): ZeroBounceMapping {
  const unknown = (detail: string, error: string | null): ZeroBounceMapping => ({
    state: 'UNKNOWN',
    catchAll: 'unknown',
    catchAllClass: 'unknown',
    acceptAll: null,
    disposable: null,
    role: null,
    detail,
    error,
    providerDetail: null,
  });
  if (!raw || typeof raw !== 'object') return unknown('malformed_response', 'malformed_response');
  const body = raw as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  const subStatus = typeof body.sub_status === 'string' && body.sub_status ? body.sub_status : null;
  const detail = subStatus ? `${status || 'no_status'}:${subStatus}` : status || 'no_status';
  const providerDetail = subStatus;

  if (typeof body.error === 'string' && body.error.length > 0) {
    return { ...unknown(detail, body.error), providerDetail };
  }
  switch (status) {
    case 'valid':
      return {
        state: 'VALID',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        acceptAll: null,
        disposable: null,
        role: null,
        detail,
        error: null,
        providerDetail,
      };
    case 'invalid':
    case 'spamtrap':
    case 'abuse':
    case 'do_not_mail':
      return {
        state: 'INVALID',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        acceptAll: null,
        disposable: null,
        role: null,
        detail,
        error: null,
        providerDetail,
      };
    case 'catch-all':
      return {
        state: 'CATCH_ALL_RISKY',
        catchAll: 'catch_all',
        catchAllClass: 'true_catch_all',
        acceptAll: true,
        disposable: null,
        role: null,
        detail,
        error: null,
        providerDetail,
      };
    case 'unknown':
      return { ...unknown(detail, null), providerDetail };
    default:
      return {
        ...unknown(detail, status ? `unrecognized_status:${status}` : 'malformed_response'),
        providerDetail,
      };
  }
}

export class ZeroBounceProvider implements EmailVerificationProvider {
  readonly key = 'zerobounce';
  readonly domain = 'api.zerobounce.net';

  constructor(
    private readonly config: ZeroBounceConfig = resolveZeroBounceConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.config.apiKey !== null;
  }

  async verify(request: EmailVerificationRequest): Promise<EmailVerificationProviderResult> {
    const startedAt = Date.now();
    const url = new URL(`${this.config.baseUrl}/v2/validate`);
    url.searchParams.set('api_key', this.config.apiKey ?? '');
    url.searchParams.set('email', request.email);
    url.searchParams.set('ip_address', '');
    const outcome = await fetchProviderJson({
      providerKey: this.key,
      apiKey: this.config.apiKey,
      unconfiguredDetail: 'ZEROBOUNCE_API_KEY 未配置，降级 UNKNOWN',
      url,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.config.timeoutMs,
      startedAt,
    });
    if ('unavailable' in outcome) return outcome.unavailable;
    const mapping = mapZeroBounceResponse(outcome.body);
    return assembleProviderResult({
      providerKey: this.key,
      mapping,
      detail: mapping.providerDetail
        ? `${mapping.detail};sub=${mapping.providerDetail}`
        : mapping.detail,
      costMicrousd: this.config.costMicrousd,
      startedAt,
    });
  }
}
