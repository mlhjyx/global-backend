import {
  enrichmentRequestHash,
  normalizeEnrichedEmail,
  unconfiguredFindEmailOutcome,
  type EmailEnrichmentAdapter,
  type FindEmailInput,
  type FindEmailOutcome,
} from './email-enrichment-provider';

/**
 * Apollo（api.apollo.io/api/v1/people/match）finder 适配器 —— 瀑布可选尾（P1-09，计划 §2.3.3）。
 *
 * 定位：兜底 + 搜索面。**只对 A 档公司路由**（评分 ≥80；由调用方在构造 finder 列表时追加，
 * 不对全量开启——见 `resolveConfiguredTailFinderProviders`）。credits 不滚存、按 reveals 计费；
 * credit 单价未公开，成本按内部规划值 $0.025/命中（25000 微美元，**待核**）。
 *
 * 请求：POST {base}/api/v1/people/match，header `x-api-key`，body
 * `{ first_name, last_name, domain, organization_name?, linkedin_url? }`。
 * 响应：`{ person: { email, email_status } }`（无记录时 person 缺失/为 null）→ miss 不计费。
 * `email_status`（verified / guessed / unavailable / bounced）折算 providerConfidence 透传，
 * 最终可用性仍由验证瀑布裁决——finder 命中≠可用。
 *
 * 凭据与参数从 env 读（APOLLO_API_KEY / _BASE_URL / _TIMEOUT_MS / _COST_MICROUSD）；
 * 缺 key 时 isConfigured()=false。HTTP 走注入的 fetch（单测 fixture，零真实出网）。
 */

export interface ApolloConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export function resolveApolloConfig(env: NodeJS.ProcessEnv = process.env): ApolloConfig {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    apiKey: (env.APOLLO_API_KEY ?? '').trim() || null,
    baseUrl: (env.APOLLO_BASE_URL ?? 'https://api.apollo.io').replace(/\/+$/u, ''),
    timeoutMs: positiveInt(env.APOLLO_TIMEOUT_MS, 8_000),
    // ≈$0.025/命中（credit 单价未公开，按内部规划值 2026-11-08 快照）→ 25000 微美元，待核。
    costMicrousd: positiveInt(env.APOLLO_COST_MICROUSD, 25_000),
  };
}

const APOLLO_EMAIL_STATUS_CONFIDENCE: Readonly<Record<string, number>> = Object.freeze({
  verified: 95,
  guessed: 50,
  unavailable: 30,
  bounced: 0,
  pending_manual_fulfillment: 40,
});

export type ApolloParse =
  | { ok: true; email: string | null; emailStatus: string | null; confidence: number | null }
  | { ok: false; errorCode: string; detail: string };

/** 供应商响应 → 候选邮箱（纯函数；畸形体 fail-closed 为 error）。 */
export function parseApolloResponse(raw: unknown): ApolloParse {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errorCode: 'malformed_response', detail: 'apollo_response_not_object' };
  }
  const body = raw as Record<string, unknown>;
  if (body.person === undefined || body.person === null) {
    // 明确无记录（Apollo 对未命中返回 person: null / 缺省）→ 合法 miss。
    return { ok: true, email: null, emailStatus: null, confidence: null };
  }
  if (typeof body.person !== 'object') {
    return { ok: false, errorCode: 'malformed_response', detail: 'apollo_person_not_object' };
  }
  const person = body.person as Record<string, unknown>;
  const email = typeof person.email === 'string' && person.email.trim() ? person.email : null;
  const emailStatus = typeof person.email_status === 'string' ? person.email_status : null;
  const confidence =
    emailStatus !== null && APOLLO_EMAIL_STATUS_CONFIDENCE[emailStatus] !== undefined
      ? (APOLLO_EMAIL_STATUS_CONFIDENCE[emailStatus] as number)
      : null;
  return { ok: true, email, emailStatus, confidence };
}

function splitName(fullName: string): { firstName: string; lastName: string } | null {
  const tokens = fullName.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length < 2) return null;
  return { firstName: tokens[0] as string, lastName: tokens[tokens.length - 1] as string };
}

export class ApolloProvider implements EmailEnrichmentAdapter {
  readonly key = 'apollo' as const;
  readonly domain = 'api.apollo.io';
  readonly class = 'b2b_company_person' as const;
  readonly costMicrousd: number;

  constructor(
    private readonly config: ApolloConfig = resolveApolloConfig(),
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
    const name = splitName(input.fullName);
    if (!name) {
      // Apollo 按姓名匹配；单名输入无法形成有效请求——诚实 miss，不花配额。
      return { status: 'miss', costMicrousd: 0, latencyMs: 0, detail: 'apollo_name_not_parseable' };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`${this.config.baseUrl}/api/v1/people/match`), {
        method: 'POST',
        headers: {
          'x-api-key': this.config.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          first_name: name.firstName,
          last_name: name.lastName,
          domain: input.domain,
          ...(input.companyName ? { organization_name: input.companyName } : {}),
          ...(input.linkedinUrl ? { linkedin_url: input.linkedinUrl } : {}),
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
        detail: timedOut ? 'apollo_timeout' : 'apollo_network_error',
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
        detail: 'apollo_http_429',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'error',
        errorCode: 'unauthorized',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: `apollo_http_${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        errorCode: response.status >= 500 ? 'provider_5xx' : 'provider_http_error',
        retryable: response.status >= 500,
        costMicrousd: 0,
        latencyMs,
        detail: `apollo_http_${response.status}`,
      };
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = parseApolloResponse(json);
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
      return { status: 'miss', costMicrousd: 0, latencyMs, detail: 'apollo_no_match' };
    }
    const email = normalizeEnrichedEmail(parsed.email, input.domain);
    if (!email) {
      return {
        status: 'error',
        errorCode: 'invalid_payload',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: 'apollo_email_failed_validation',
      };
    }
    return {
      status: 'hit',
      hit: {
        email,
        ...(parsed.confidence === null ? {} : { providerConfidence: parsed.confidence }),
        raw: { provider: this.key, email_status: parsed.emailStatus },
      },
      costMicrousd: this.config.costMicrousd,
      latencyMs,
    };
  }
}
