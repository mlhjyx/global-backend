import {
  enrichmentRequestHash,
  normalizeEnrichedEmail,
  unconfiguredFindEmailOutcome,
  type EmailEnrichmentAdapter,
  type FindEmailInput,
  type FindEmailOutcome,
} from './email-enrichment-provider';

/**
 * Findymail（app.findymail.com/api/search）finder 适配器 —— 瀑布第二位（P1-07）。
 *
 * 口径（计划 §2.3.3）：pay-on-valid 主力（$99/mo 5,000 finder credits ≈ $0.0198/email），
 * 无结果不计费（miss cost 0）。供应商返回的邮箱必须立刻进验证瀑布——finder 命中≠可用。
 *
 * 请求：POST {base}/api/search，`Authorization: Bearer <key>`，body `{ name, domain }`。
 * 响应容忍两种形状：顶层 `{ email }` 或 `{ contact: { email } }`（供应商契约随版本变化，
 * 畸形体 fail-closed 为 malformed_response，不猜）。
 *
 * 凭据与参数从 env 读（FINDYMAIL_API_KEY / _BASE_URL / _TIMEOUT_MS / _COST_MICROUSD，
 * 19800 微美元）；缺 key 时 isConfigured()=false，findEmail 返回 provider_unconfigured。
 * HTTP 走注入的 fetch（单测 fixture，零真实出网）。
 */

export interface FindymailConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export function resolveFindymailConfig(env: NodeJS.ProcessEnv = process.env): FindymailConfig {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    apiKey: (env.FINDYMAIL_API_KEY ?? '').trim() || null,
    baseUrl: (env.FINDYMAIL_BASE_URL ?? 'https://app.findymail.com').replace(/\/+$/u, ''),
    timeoutMs: positiveInt(env.FINDYMAIL_TIMEOUT_MS, 8_000),
    // $99/mo（5,000 credits）≈ $0.0198/条（2026-11-08 快照）→ 19800 微美元。
    costMicrousd: positiveInt(env.FINDYMAIL_COST_MICROUSD, 19_800),
  };
}

export type FindymailParse =
  | { ok: true; email: string | null; extra: Record<string, unknown> }
  | { ok: false; errorCode: string; detail: string };

/** 供应商响应 → 候选邮箱（纯函数；畸形体 fail-closed 为 error）。 */
export function parseFindymailResponse(raw: unknown): FindymailParse {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errorCode: 'malformed_response', detail: 'findymail_response_not_object' };
  }
  const body = raw as Record<string, unknown>;
  const topLevel = typeof body.email === 'string' ? body.email : null;
  const contact =
    body.contact && typeof body.contact === 'object'
      ? (body.contact as Record<string, unknown>)
      : null;
  const nested = contact && typeof contact.email === 'string' ? contact.email : null;
  const email = topLevel ?? nested;
  if (email === null) {
    // 顶层 email 明确为 null（无结果）是合法 miss；字段完全缺失则视为畸形体。
    const explicitMiss = body.email === null || (contact !== null && contact.email === null);
    if (explicitMiss) {
      return {
        ok: true,
        email: null,
        extra: {
          provider: 'findymail',
          status: typeof body.status === 'string' ? body.status : null,
        },
      };
    }
    return { ok: false, errorCode: 'malformed_response', detail: 'findymail_email_missing' };
  }
  return {
    ok: true,
    email,
    extra: {
      provider: 'findymail',
      status:
        (typeof body.status === 'string' && body.status) ||
        (contact && typeof contact.status === 'string' ? contact.status : null),
    },
  };
}

export class FindymailProvider implements EmailEnrichmentAdapter {
  readonly key = 'findymail' as const;
  readonly domain = 'api.findymail.com';
  readonly class = 'b2b_company_person' as const;
  readonly costMicrousd: number;

  constructor(
    private readonly config: FindymailConfig = resolveFindymailConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.costMicrousd = config.costMicrousd;
  }

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
      response = await this.fetchImpl(new URL(`${this.config.baseUrl}/api/search`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: input.fullName, domain: input.domain }),
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
        detail: timedOut ? 'findymail_timeout' : 'findymail_network_error',
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
        detail: 'findymail_http_429',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'error',
        errorCode: 'unauthorized',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: `findymail_http_${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        errorCode: response.status >= 500 ? 'provider_5xx' : 'provider_http_error',
        retryable: response.status >= 500,
        costMicrousd: 0,
        latencyMs,
        detail: `findymail_http_${response.status}`,
      };
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = parseFindymailResponse(json);
    if (!parsed.ok) {
      return {
        status: 'error',
        errorCode: parsed.errorCode,
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: parsed.detail,
      };
    }
    if (parsed.email === null) {
      return { status: 'miss', costMicrousd: 0, latencyMs, detail: 'findymail_no_match' };
    }
    const email = normalizeEnrichedEmail(parsed.email, input.domain);
    if (!email) {
      return {
        status: 'error',
        errorCode: 'invalid_payload',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: 'findymail_email_failed_validation',
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
