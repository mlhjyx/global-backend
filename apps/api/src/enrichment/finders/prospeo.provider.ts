import {
  enrichmentRequestHash,
  normalizeEnrichedEmail,
  unconfiguredFindEmailOutcome,
  type EmailEnrichmentAdapter,
  type FindEmailInput,
  type FindEmailOutcome,
} from './email-enrichment-provider';

/**
 * Prospeo（api.prospeo.io/email-finder）finder 适配器 —— 瀑布第三位（P1-07）。
 *
 * 口径（计划 §2.3.3）：pay-on-valid + 90 天免费重取（$49/mo 2,000 credits ≈ $0.0245；
 * 无结果 0 credit）。90 天重取的「免费」由供应商侧保证；引擎侧另有本地 attempt 幂等与
 * 90 天缓存（P1-08），命中缓存时不发请求、成本 0。
 *
 * 请求：POST {base}/email-finder，header `X-KEY: <key>`，body `{ full_name, domain, company_name? }`。
 * 响应契约：`{ error: false, response: { email, ... } }` 或
 * `{ error: true, error_code: 'NO_MATCH' | 'RATE_LIMITED' | ... }`。
 * `NO_MATCH` / `INVALID_DATAPOINTS` = 合法 miss（0 成本）；`RATE_LIMITED` / `INTERNAL_ERROR`
 * 可重试；`INSUFFICIENT_CREDITS` / `INVALID_API_KEY` 不可重试（编排层熔断）。
 *
 * 凭据与参数从 env 读（PROSPEO_API_KEY / _BASE_URL / _TIMEOUT_MS / _COST_MICROUSD，19800）；
 * 缺 key 时 isConfigured()=false。HTTP 走注入的 fetch（单测 fixture，零真实出网）。
 */

export interface ProspeoConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export function resolveProspeoConfig(env: NodeJS.ProcessEnv = process.env): ProspeoConfig {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    apiKey: (env.PROSPEO_API_KEY ?? '').trim() || null,
    baseUrl: (env.PROSPEO_BASE_URL ?? 'https://api.prospeo.io').replace(/\/+$/u, ''),
    timeoutMs: positiveInt(env.PROSPEO_TIMEOUT_MS, 8_000),
    // $49/mo（2,000 credits）≈ $0.0245；年付 $0.0166–$0.0198 → 取月付口径 19800 微美元。
    costMicrousd: positiveInt(env.PROSPEO_COST_MICROUSD, 19_800),
  };
}

export type ProspeoParse =
  | { ok: true; email: string | null; extra: Record<string, unknown> }
  | { ok: false; errorCode: string; retryable: boolean; detail: string };

const PROSPEO_MISS_CODES: ReadonlySet<string> = new Set(['NO_MATCH', 'INVALID_DATAPOINTS']);
const PROSPEO_RETRYABLE_CODES: ReadonlySet<string> = new Set(['RATE_LIMITED', 'INTERNAL_ERROR']);

/** 供应商响应 → 候选邮箱（纯函数；畸形体 fail-closed 为 error）。 */
export function parseProspeoResponse(raw: unknown): ProspeoParse {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errorCode: 'malformed_response', retryable: false, detail: 'prospeo_response_not_object' };
  }
  const body = raw as Record<string, unknown>;
  if (body.error === true) {
    const errorCode = typeof body.error_code === 'string' ? body.error_code : 'unknown_error';
    if (PROSPEO_MISS_CODES.has(errorCode)) {
      return { ok: true, email: null, extra: { provider: 'prospeo', error_code: errorCode } };
    }
    return {
      ok: false,
      errorCode: errorCode.toLowerCase(),
      retryable: PROSPEO_RETRYABLE_CODES.has(errorCode),
      detail: typeof body.message === 'string' ? body.message : `prospeo_${errorCode}`,
    };
  }
  if (body.error !== false) {
    return { ok: false, errorCode: 'malformed_response', retryable: false, detail: 'prospeo_error_flag_missing' };
  }
  const response =
    body.response && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>)
      : null;
  const email = response && typeof response.email === 'string' ? response.email : null;
  if (email === null) {
    return { ok: true, email: null, extra: { provider: 'prospeo' } };
  }
  return { ok: true, email, extra: { provider: 'prospeo' } };
}

export class ProspeoProvider implements EmailEnrichmentAdapter {
  readonly key = 'prospeo' as const;
  readonly domain = 'api.prospeo.io';
  readonly class = 'b2b_company_person' as const;

  constructor(
    private readonly config: ProspeoConfig = resolveProspeoConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.config.apiKey !== null;
  }

  requestHash(input: FindEmailInput): string {
    return enrichmentRequestHash(input.contactId, this.key, input);
  }

  async findEmail(input: FindEmailInput): Promise<FindEmailOutcome> {
    const startedAt = Date.now();
    if (!this.config.apiKey) return unconfiguredFindEmailOutcome();

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`${this.config.baseUrl}/email-finder`), {
        method: 'POST',
        headers: {
          'x-key': this.config.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          full_name: input.fullName,
          domain: input.domain,
          ...(input.companyName ? { company_name: input.companyName } : {}),
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        status: 'error',
        errorCode: timedOut ? 'timeout' : 'network_error',
        retryable: true,
        costMicrousd: 0,
        latencyMs: Date.now() - startedAt,
        detail: timedOut ? 'prospeo_timeout' : 'prospeo_network_error',
      };
    }

    const latencyMs = Date.now() - startedAt;
    if (response.status === 429) {
      return {
        status: 'error',
        errorCode: 'rate_limited',
        retryable: true,
        costMicrousd: 0,
        latencyMs,
        detail: 'prospeo_http_429',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'error',
        errorCode: 'unauthorized',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: `prospeo_http_${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        errorCode: response.status >= 500 ? 'provider_5xx' : 'provider_http_error',
        retryable: response.status >= 500,
        costMicrousd: 0,
        latencyMs,
        detail: `prospeo_http_${response.status}`,
      };
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = parseProspeoResponse(json);
    if (!parsed.ok) {
      return {
        status: 'error',
        errorCode: parsed.errorCode,
        retryable: parsed.retryable,
        costMicrousd: 0,
        latencyMs,
        detail: parsed.detail,
      };
    }
    if (parsed.email === null) {
      return { status: 'miss', costMicrousd: 0, latencyMs, detail: 'prospeo_no_match' };
    }
    const email = normalizeEnrichedEmail(parsed.email, input.domain);
    if (!email) {
      return {
        status: 'error',
        errorCode: 'invalid_payload',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: 'prospeo_email_failed_validation',
      };
    }
    return {
      status: 'hit',
      hit: { email, raw: parsed.extra },
      costMicrousd: this.config.costMicrousd,
      latencyMs,
    };
  }
}
