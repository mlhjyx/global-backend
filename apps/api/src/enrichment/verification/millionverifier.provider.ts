import type { CatchAllClass, EmailVerificationState } from '../../discovery/contact-point-verification-state';
import { scoreEmailPoint } from './verification-policy';
import {
  unavailableProviderResult,
  type EmailVerificationProvider,
  type EmailVerificationProviderResult,
  type EmailVerificationRequest,
} from './email-verification-provider';

/**
 * MillionVerifier（api.millionverifier.com/api/v3）验证器客户端。
 *
 * 映射（供应商 result 词表 → 四态，见计划 §2.3.5.2）：
 *  - `ok`：**accept_all=true 时降为 CATCH_ALL_RISKY**（accept-all 地址的退信风险约为
 *    valid 的 27 倍，必须直接进 catch-all 层，不允许当 VALID）；否则 VALID（单票，
 *    最终 VALID 仍需验证瀑布的第二票）。
 *  - `invalid` / `disposable` → INVALID；`catch_all` → CATCH_ALL_RISKY·true_catch_all；
 *  - `unknown` / `error` / 畸形体 → UNKNOWN（进重验队列）。
 *
 * 凭据与参数从 env 读（MILLIONVERIFIER_API_KEY / _BASE_URL / _TIMEOUT_MS /
 * _COST_MICROUSD）；缺 key 时 `isConfigured()=false`，verify 降级 UNKNOWN。
 * HTTP 走注入的 fetch（单测用 fixture，不打真实外网）；429/5xx/超时/畸形体一律 UNKNOWN
 * + error，不抛异常（编排方按事件账记录 error 而不是中断整批）。
 */

export interface MillionVerifierConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export function resolveMillionVerifierConfig(env: NodeJS.ProcessEnv = process.env): MillionVerifierConfig {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    apiKey: (env.MILLIONVERIFIER_API_KEY ?? '').trim() || null,
    baseUrl: (env.MILLIONVERIFIER_BASE_URL ?? 'https://api.millionverifier.com').replace(/\/+$/u, ''),
    timeoutMs: positiveInt(env.MILLIONVERIFIER_TIMEOUT_MS, 8_000),
    // $0.00178/条（50,000 条 $89，2026-11-08 快照）→ 1780 微美元。
    costMicrousd: positiveInt(env.MILLIONVERIFIER_COST_MICROUSD, 1_780),
  };
}

export interface MillionVerifierMapping {
  state: EmailVerificationState;
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  catchAllClass: CatchAllClass;
  acceptAll: boolean | null;
  disposable: boolean | null;
  role: boolean | null;
  detail: string;
  error: string | null;
}

/** 供应商响应 → 四态映射（纯函数；畸形/未成功一律 UNKNOWN）。 */
export function mapMillionVerifierResponse(raw: unknown): MillionVerifierMapping {
  const unknown = (detail: string, error: string): MillionVerifierMapping => ({
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
  const acceptAll = typeof body.accept_all === 'boolean' ? body.accept_all : null;
  const disposable = typeof body.disposable === 'boolean' ? body.disposable : null;
  const role = typeof body.role === 'boolean' ? body.role : null;
  const result = typeof body.result === 'string' ? body.result.trim().toLowerCase() : '';
  const subresult = typeof body.subresult === 'string' ? body.subresult : null;
  const detail = subresult ? `${result || 'no_result'}:${subresult}` : result || 'no_result';

  if (body.success === false || (typeof body.error === 'string' && body.error.length > 0)) {
    const error = typeof body.error === 'string' && body.error ? body.error : 'provider_error';
    return { ...unknown(detail, error), acceptAll, disposable, role };
  }
  switch (result) {
    case 'ok':
      // accept_all 优先：只有**明确 false**才允许判 VALID；true → true_catch_all；
      // 缺字段（null，老契约/畸形体）→ inconclusive（保守进 catch-all 层）。
      if (acceptAll !== false) {
        return {
          state: 'CATCH_ALL_RISKY',
          catchAll: acceptAll === true ? 'catch_all' : 'inconclusive',
          catchAllClass: acceptAll === true ? 'true_catch_all' : 'inconclusive',
          acceptAll,
          disposable,
          role,
          detail,
          error: null,
        };
      }
      return {
        state: 'VALID',
        catchAll: 'not_catch_all',
        catchAllClass: 'not_catch_all',
        acceptAll,
        disposable,
        role,
        detail,
        error: null,
      };
    case 'invalid':
      return {
        state: 'INVALID',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        acceptAll,
        disposable,
        role,
        detail,
        error: null,
      };
    case 'disposable':
      return {
        state: 'INVALID',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        acceptAll,
        disposable,
        role,
        detail: `disposable:${subresult ?? 'yes'}`,
        error: null,
      };
    case 'catch_all':
      return {
        state: 'CATCH_ALL_RISKY',
        catchAll: 'catch_all',
        catchAllClass: 'true_catch_all',
        acceptAll: acceptAll ?? true,
        disposable,
        role,
        detail,
        error: null,
      };
    case 'unknown':
      // `unknown` 是**有效裁决**（进重验队列），不是供应商侧错误：error 留空、
      // 事件账 verdict 记 unknown、按次计费。只有提供方报错（success:false/error 字段/
      // result:error/畸形体/HTTP 失败）才是 error。
      return {
        state: 'UNKNOWN',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        acceptAll,
        disposable,
        role,
        detail,
        error: null,
      };
    case 'error':
      return { ...unknown(detail, 'provider_reported_error'), acceptAll, disposable, role };
    default:
      return {
        ...unknown(detail, result ? `unrecognized_result:${result}` : 'malformed_response'),
        acceptAll,
        disposable,
        role,
      };
  }
}

export class MillionVerifierProvider implements EmailVerificationProvider {
  readonly key = 'millionverifier';
  readonly domain = 'api.millionverifier.com';

  constructor(
    private readonly config: MillionVerifierConfig = resolveMillionVerifierConfig(),
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
        detail: 'MILLIONVERIFIER_API_KEY 未配置，降级 UNKNOWN',
        latencyMs: Date.now() - startedAt,
      });
    }
    const url = new URL(`${this.config.baseUrl}/api/v3/`);
    url.searchParams.set('api', this.config.apiKey);
    url.searchParams.set('email', request.email);
    // 供应商侧 timeout 提示不得大于客户端 abort 窗口（默认 8s），否则永远等不到对方回包。
    const providerTimeoutSeconds =
      request.providerTimeoutSeconds ?? Math.max(1, Math.floor(this.config.timeoutMs / 1000));
    url.searchParams.set('timeout', String(providerTimeoutSeconds));

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
    const mapping = mapMillionVerifierResponse(body);
    return {
      providerKey: this.key,
      ...mapping,
      // 与 contact_point 写入侧同一评分口径（§2.3.2.8 基础分；最终分由投票裁决方再算）。
      score: scoreEmailPoint({ state: mapping.state, catchAllClass: mapping.catchAllClass }),
      // 供应商侧错误（未产生一次有效验证）不计费；解析出的结论按次计费（含 unknown）。
      costMicrousd: mapping.error === null ? this.config.costMicrousd : 0,
      latencyMs: Date.now() - startedAt,
    };
  }
}
