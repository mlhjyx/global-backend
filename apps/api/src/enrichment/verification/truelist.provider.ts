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
 * Truelist（api.truelist.io `/api/v1/verify_inline`）验证器客户端 —— 验证瀑布的
 * **catch-all 解析席**（计划 §2.3.5.1 第 ③ 步：仅当标准验证判 unknown/catch-all 时调用，
 * 用地址级证据把「不可证的 catch-all」收敛成可判定的结果）。
 *
 * 注意：**当前未接入 provider 池/瀑布**——瀑布的解析分支（主验 unknown/catch_all → 解析器 →
 * 地址级 valid 需第二票确认）属于 P1-06 后续编排改造；本适配器先就位并登记（DISABLED），
 * 编排接线后才会被调用。直接把它放进按位置取席位的池会把它误当仲裁席，故不入池。
 *
 * 映射（`emails[0].email_state` 词表 → 四态；契约按公开文档实现，真实 key 到位时校准）：
 *  - `ok` → VALID（enhanced catch-all 解析成功时供应商同样回 ok —— 这是地址级证据）；
 *  - `email_invalid` → INVALID；`is_disposable=true` 同样 INVALID；
 *  - `accept_all` → CATCH_ALL_RISKY·true_catch_all（解析器也未能给出地址级答案）；
 *  - `unknown` / 畸形体 → UNKNOWN（有效裁决 error=null、按次计费）。
 *
 * env：TRUELIST_API_KEY / _BASE_URL / _TIMEOUT_MS / _COST_MICROUSD（默认 $0.0014/条 = 1400
 * 微美元；enhanced 3 credits ≈ $0.0042 —— 真实计费以账单为准，事件账按条记账）。
 * 鉴权 `Authorization: Bearer <key>`；HTTP 走注入 fetch（fixture 测试，零真实出网）。
 */

export type TruelistConfig = ProviderHttpConfig;

export function resolveTruelistConfig(env: NodeJS.ProcessEnv = process.env): TruelistConfig {
  return resolveProviderHttpConfig(env, {
    keyEnv: 'TRUELIST_API_KEY',
    baseUrlEnv: 'TRUELIST_BASE_URL',
    timeoutEnv: 'TRUELIST_TIMEOUT_MS',
    costEnv: 'TRUELIST_COST_MICROUSD',
    defaultBaseUrl: 'https://api.truelist.io',
    defaultTimeoutMs: 8_000,
    defaultCostMicrousd: 1_400,
  });
}

export interface TruelistMapping {
  state: EmailVerificationState;
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  catchAllClass: CatchAllClass;
  acceptAll: boolean | null;
  disposable: boolean | null;
  role: boolean | null;
  detail: string;
  error: string | null;
}

export function mapTruelistResponse(raw: unknown): TruelistMapping {
  const unknown = (detail: string, error: string | null): TruelistMapping => ({
    state: 'UNKNOWN',
    catchAll: 'unknown',
    catchAllClass: 'unknown',
    acceptAll: null,
    disposable: null,
    role: null,
    detail,
    error,
  });
  if (!raw || typeof raw !== 'object') return unknown('malformed_response', 'malformed_response');
  const body = raw as Record<string, unknown>;
  if (typeof body.error === 'string' && body.error.length > 0) {
    return unknown('provider_error', body.error);
  }
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const entry = emails[0] as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== 'object') return unknown('malformed_response', 'malformed_response');
  const state = typeof entry.email_state === 'string' ? entry.email_state.trim().toLowerCase() : '';
  const reason = typeof entry.reason === 'string' && entry.reason ? entry.reason : null;
  const disposable = typeof entry.is_disposable === 'boolean' ? entry.is_disposable : null;
  const role = typeof entry.is_role === 'boolean' ? entry.is_role : null;
  const detail = reason ? `${state || 'no_state'}:${reason}` : state || 'no_state';

  if (disposable === true) {
    return {
      state: 'INVALID',
      catchAll: 'unknown',
      catchAllClass: 'unknown',
      acceptAll: null,
      disposable,
      role,
      detail: `disposable:${reason ?? 'yes'}`,
      error: null,
    };
  }
  switch (state) {
    case 'ok':
      return {
        state: 'VALID',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        acceptAll: false,
        disposable,
        role,
        detail,
        error: null,
      };
    case 'email_invalid':
      return {
        state: 'INVALID',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        acceptAll: null,
        disposable,
        role,
        detail,
        error: null,
      };
    case 'accept_all':
      return {
        state: 'CATCH_ALL_RISKY',
        catchAll: 'catch_all',
        catchAllClass: 'true_catch_all',
        acceptAll: true,
        disposable,
        role,
        detail,
        error: null,
      };
    case 'unknown':
      return { ...unknown(detail, null), disposable, role };
    default:
      return {
        ...unknown(detail, state ? `unrecognized_state:${state}` : 'malformed_response'),
        disposable,
        role,
      };
  }
}

export class TruelistProvider implements EmailVerificationProvider {
  readonly key = 'truelist';
  readonly domain = 'api.truelist.io';

  constructor(
    private readonly config: TruelistConfig = resolveTruelistConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.config.apiKey !== null;
  }

  async verify(request: EmailVerificationRequest): Promise<EmailVerificationProviderResult> {
    const startedAt = Date.now();
    const url = new URL(`${this.config.baseUrl}/api/v1/verify_inline`);
    url.searchParams.set('email', request.email);
    const outcome = await fetchProviderJson({
      providerKey: this.key,
      apiKey: this.config.apiKey,
      unconfiguredDetail: 'TRUELIST_API_KEY 未配置，降级 UNKNOWN',
      url,
      headers: { authorization: `Bearer ${this.config.apiKey ?? ''}` },
      fetchImpl: this.fetchImpl,
      timeoutMs: this.config.timeoutMs,
      startedAt,
    });
    if ('unavailable' in outcome) return outcome.unavailable;
    return assembleProviderResult({
      providerKey: this.key,
      mapping: mapTruelistResponse(outcome.body),
      costMicrousd: this.config.costMicrousd,
      startedAt,
    });
  }
}
