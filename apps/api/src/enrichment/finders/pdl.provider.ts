import {
  enrichmentRequestHash,
  normalizeEnrichedEmail,
  unconfiguredFindEmailOutcome,
  type EmailEnrichmentAdapter,
  type FindEmailInput,
  type FindEmailOutcome,
} from './email-enrichment-provider';

/**
 * People Data Labs（api.peopledatalabs.com/v5/person/enrich）finder 适配器 —— 瀑布可选尾
 * （P1-09，计划 §2.3.3）。**只对 A 档公司路由**（同 Apollo，由调用方追加尾部）。
 *
 * 计费口径（计划 §2.3.3 / §2.3.4.6）：`required=emails`——只有返回邮箱的记录才计费；
 * 404（无记录）与「记录存在但无邮箱」都不扣。Pro 档 $98/mo 350 records ≈ $0.28/record
 * （280000 微美元），是瀑布里最贵的一档，所以只作尾部署。
 *
 * 请求：GET {base}/v5/person/enrich?name=…&company=…&required=emails&pretty=true，
 * header `X-Api-Key`。响应：`{ status: 200, data: { emails: [{ address, type }] } }`；
 * 404 = 无记录（合法 miss）。邮箱优先取 `current_professional` 类型。
 *
 * 官方域名以文档为准（api.peopledatalabs.com）；计划里的 `api.peerdatalab.com` 为笔误，
 * source_policy 按官方域登记。凭据与参数从 env 读（PDL_API_KEY / _BASE_URL / _TIMEOUT_MS /
 * _COST_MICROUSD）；缺 key 时 isConfigured()=false。HTTP 走注入的 fetch（单测零真实出网）。
 */

export interface PdlConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export function resolvePdlConfig(env: NodeJS.ProcessEnv = process.env): PdlConfig {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    apiKey: (env.PDL_API_KEY ?? '').trim() || null,
    baseUrl: (env.PDL_BASE_URL ?? 'https://api.peopledatalabs.com').replace(/\/+$/u, ''),
    timeoutMs: positiveInt(env.PDL_TIMEOUT_MS, 8_000),
    // Pro $98/mo（350 records）≈ $0.28/record（2026-11-08 快照）→ 280000 微美元。
    costMicrousd: positiveInt(env.PDL_COST_MICROUSD, 280_000),
  };
}

export type PdlParse =
  | { ok: true; email: string | null; emailType: string | null }
  | { ok: false; errorCode: string; detail: string };

/** 供应商响应 → 候选邮箱（纯函数；畸形体 fail-closed 为 error）。 */
export function parsePdlResponse(raw: unknown): PdlParse {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errorCode: 'malformed_response', detail: 'pdl_response_not_object' };
  }
  const body = raw as Record<string, unknown>;
  const data = body.data;
  if (!data || typeof data !== 'object') {
    // status 200 但无 data 视为无记录（PDL 在无匹配时返回 404，此分支为防御）。
    if (body.status === 404) return { ok: true, email: null, emailType: null };
    return { ok: false, errorCode: 'malformed_response', detail: 'pdl_data_missing' };
  }
  const record = data as Record<string, unknown>;
  const emails = Array.isArray(record.emails) ? record.emails : [];
  let chosen: { address: string; type: string | null } | null = null;
  for (const entry of emails) {
    if (!entry || typeof entry !== 'object') continue;
    const email = entry as Record<string, unknown>;
    if (typeof email.address !== 'string' || !email.address.trim()) continue;
    const type = typeof email.type === 'string' ? email.type : null;
    if (chosen === null || (type === 'current_professional' && chosen.type !== 'current_professional')) {
      chosen = { address: email.address, type };
    }
  }
  return { ok: true, email: chosen?.address ?? null, emailType: chosen?.type ?? null };
}

export class PdlProvider implements EmailEnrichmentAdapter {
  readonly key = 'pdl' as const;
  readonly domain = 'api.peopledatalabs.com';
  readonly class = 'b2b_company_person' as const;
  readonly costMicrousd: number;

  constructor(
    private readonly config: PdlConfig = resolvePdlConfig(),
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

    const url = new URL(`${this.config.baseUrl}/v5/person/enrich`);
    url.searchParams.set('name', input.fullName);
    url.searchParams.set('company', input.companyName ?? input.domain);
    // required=emails：只有带邮箱的记录才计费；无邮箱不扣。
    url.searchParams.set('required', 'emails');
    url.searchParams.set('pretty', 'true');

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'x-api-key': this.config.apiKey },
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
        detail: timedOut ? 'pdl_timeout' : 'pdl_network_error',
      };
    }

    const latencyMs = Date.now() - startedAt;
    if (response.status === 404) {
      // 无记录：required=emails 下不扣费。
      return { status: 'miss', costMicrousd: 0, latencyMs, detail: 'pdl_not_found' };
    }
    if (response.status === 429) {
      return {
        status: 'error',
        errorCode: 'rate_limited',
        retryable: true,
        costMicrousd: 0,
        latencyMs,
        detail: 'pdl_http_429',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'error',
        errorCode: 'unauthorized',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: `pdl_http_${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        errorCode: response.status >= 500 ? 'provider_5xx' : 'provider_http_error',
        retryable: response.status >= 500,
        costMicrousd: 0,
        latencyMs,
        detail: `pdl_http_${response.status}`,
      };
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = parsePdlResponse(json);
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
      // 记录存在但无邮箱：required=emails 下不扣费。
      return { status: 'miss', costMicrousd: 0, latencyMs, detail: 'pdl_no_email' };
    }
    const email = normalizeEnrichedEmail(parsed.email, input.domain);
    if (!email) {
      return {
        status: 'error',
        errorCode: 'invalid_payload',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: 'pdl_email_failed_validation',
      };
    }
    return {
      status: 'hit',
      hit: {
        email,
        raw: { provider: this.key, email_type: parsed.emailType },
      },
      costMicrousd: this.config.costMicrousd,
      latencyMs,
    };
  }
}
