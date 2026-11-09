import {
  enrichmentRequestHash,
  namesMatch,
  normalizeEnrichedEmail,
  personNameParts,
  unconfiguredFindEmailOutcome,
  type EmailEnrichmentAdapter,
  type FindEmailInput,
  type FindEmailOutcome,
} from './email-enrichment-provider';

/**
 * Hunter（api.hunter.io/v2/domain-search）finder 适配器 —— 瀑布第一位（P1-07，计划 §2.3.3）。
 *
 * 选它打头不是最准，而是 Domain Search 顺带返回两个结构化信号：
 *  - `data.pattern`：域名级命名格式（喂 pattern 学习）；
 *  - `data.accept_all`：域名 catch-all 标志（accept-all 地址退信概率约为 valid 的 27 倍，
 *    必须直接进 catch-all 层，不允许当 VALID——由验证瀑布按此标志裁决）。
 *
 * 匹配口径：按 `first_name`/`last_name` 与输入姓名做归一化精确匹配（大小写/变音符/标点
 * 无关）；同一人多条取 confidence 最高。命中值必须过 `normalizeEnrichedEmail`（语法 + 域名
 * 一致），否则按 §2.3.4.6 记 `invalid_payload`（不计费）。
 * 计费口径：Hunter 按「返回的邮箱」计 credit；miss 不扣。cost 记在命中上。
 *
 * 凭据与参数从 env 读（HUNTER_API_KEY / _BASE_URL / _TIMEOUT_MS / _COST_MICROUSD，
 * 年付 Starter $0.0170/email = 1700 微美元）；缺 key 时 isConfigured()=false，
 * findEmail 返回 provider_unconfigured（cost 0）。HTTP 走注入的 fetch，单测零真实出网。
 */

export interface HunterConfig {
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  costMicrousd: number;
}

export function resolveHunterConfig(env: NodeJS.ProcessEnv = process.env): HunterConfig {
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    apiKey: (env.HUNTER_API_KEY ?? '').trim() || null,
    baseUrl: (env.HUNTER_BASE_URL ?? 'https://api.hunter.io').replace(/\/+$/u, ''),
    timeoutMs: positiveInt(env.HUNTER_TIMEOUT_MS, 8_000),
    // 年付 Starter $34/mo（2,000 credits）≈ $0.0170/条（2026-11-08 快照）→ 1700 微美元。
    costMicrousd: positiveInt(env.HUNTER_COST_MICROUSD, 1_700),
  };
}

export interface HunterPersonMatch {
  /** 归一（小写）后的邮箱；边界校验在 findEmail 内做。 */
  email: string;
  confidence: number | null;
}

export type HunterDomainSearchParse =
  | {
      ok: true;
      match: HunterPersonMatch | null;
      acceptAll: boolean | null;
      pattern: string | null;
      candidateCount: number;
      /** match=null 时的诚实原因（name_not_parseable / no_name_match）。 */
      missReason: string | null;
    }
  | { ok: false; errorCode: string; detail: string };

/** 供应商响应 → 人-邮箱匹配（纯函数；畸形体 fail-closed 为 error）。 */
export function parseHunterDomainSearch(
  raw: unknown,
  input: Pick<FindEmailInput, 'fullName'>,
): HunterDomainSearchParse {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errorCode: 'malformed_response', detail: 'hunter_response_not_object' };
  }
  const body = raw as Record<string, unknown>;
  const data = body.data;
  if (!data || typeof data !== 'object') {
    return { ok: false, errorCode: 'malformed_response', detail: 'hunter_data_missing' };
  }
  const record = data as Record<string, unknown>;
  const acceptAll = typeof record.accept_all === 'boolean' ? record.accept_all : null;
  const pattern = typeof record.pattern === 'string' && record.pattern.trim() ? record.pattern : null;
  const emails = Array.isArray(record.emails) ? record.emails : [];
  const parts = personNameParts(input.fullName);
  if (!parts) {
    return {
      ok: true,
      match: null,
      acceptAll,
      pattern,
      candidateCount: emails.length,
      missReason: 'name_not_parseable',
    };
  }
  let best: HunterPersonMatch | null = null;
  for (const entry of emails) {
    if (!entry || typeof entry !== 'object') continue;
    const email = entry as Record<string, unknown>;
    if (!namesMatch(email.first_name, parts.first) || !namesMatch(email.last_name, parts.last)) {
      continue;
    }
    if (typeof email.value !== 'string') continue;
    const confidence =
      typeof email.confidence === 'number' && Number.isFinite(email.confidence)
        ? email.confidence
        : null;
    if (best === null || (confidence ?? -1) > (best.confidence ?? -1)) {
      best = { email: email.value, confidence };
    }
  }
  return {
    ok: true,
    match: best,
    acceptAll,
    pattern,
    candidateCount: emails.length,
    missReason: best === null ? 'no_name_match' : null,
  };
}

export class HunterProvider implements EmailEnrichmentAdapter {
  readonly key = 'hunter' as const;
  readonly domain = 'api.hunter.io';
  readonly class = 'b2b_company_person' as const;

  constructor(
    private readonly config: HunterConfig = resolveHunterConfig(),
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

    const url = new URL(`${this.config.baseUrl}/v2/domain-search`);
    url.searchParams.set('domain', input.domain);
    url.searchParams.set('limit', '10');
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
      return {
        status: 'error',
        errorCode: timedOut ? 'timeout' : 'network_error',
        retryable: true,
        costMicrousd: 0,
        latencyMs: Date.now() - startedAt,
        detail: timedOut ? 'hunter_timeout' : 'hunter_network_error',
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
        detail: 'hunter_http_429',
      };
    }
    if (response.status === 401 || response.status === 403) {
      // 凭据失效/欠费：立即熔断该 provider（编排层按 non-retryable 处理）。
      return {
        status: 'error',
        errorCode: 'unauthorized',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: `hunter_http_${response.status}`,
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        errorCode: response.status >= 500 ? 'provider_5xx' : 'provider_http_error',
        retryable: response.status >= 500,
        costMicrousd: 0,
        latencyMs,
        detail: `hunter_http_${response.status}`,
      };
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = parseHunterDomainSearch(json, input);
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
    const evidence = {
      provider: this.key,
      accept_all: parsed.acceptAll,
      pattern: parsed.pattern,
      candidate_count: parsed.candidateCount,
    };
    if (!parsed.match) {
      return {
        status: 'miss',
        costMicrousd: 0,
        latencyMs,
        detail: `hunter_${parsed.missReason ?? 'no_match'}`,
      };
    }
    const email = normalizeEnrichedEmail(parsed.match.email, input.domain);
    if (!email) {
      return {
        status: 'error',
        errorCode: 'invalid_payload',
        retryable: false,
        costMicrousd: 0,
        latencyMs,
        detail: 'hunter_email_failed_validation',
      };
    }
    return {
      status: 'hit',
      hit: {
        email,
        ...(parsed.match.confidence === null
          ? {}
          : { providerConfidence: parsed.match.confidence }),
        acceptAll: parsed.acceptAll,
        pattern: parsed.pattern,
        raw: { ...evidence, confidence: parsed.match.confidence },
      },
      costMicrousd: this.config.costMicrousd,
      latencyMs,
    };
  }
}
