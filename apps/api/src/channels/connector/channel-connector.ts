import type { ChannelManifestDocument } from '@global/contracts';
import { resolveChannelAuth, type ChannelAuthMaterial } from './auth-injector';
import { ChannelCircuitBreaker, type CircuitStateValue, type CircuitTransition } from './circuit-breaker';
import { channelError, ChannelRuntimeError, type ChannelErrorCode, isChannelRuntimeError } from './errors';
import { extractRecordsFromJson, itemsArray, type RawChannelRecord } from './field-extractor';
import type { ChannelHttpClient, ChannelHttpResponse } from './http-transport';
import { ChannelPaginator, type RequestPlanDraft } from './paginator';
import { ChannelTokenBucket, perDomainDelayMs } from './rate-limit';
import {
  isRetryableStatus,
  parseRetryAfterMs,
  runWithRetries,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from './retry';
import type { ChannelSecretResolver } from './secret-resolver';

/**
 * 通用 HTTP 连接器运行时（章节 §6.3.5）：manifest 驱动，逐页 plan → fetch → parse，
 * 限速（令牌桶 + 每域延迟）、退避重试（3 次/60s/Retry-After）、三态熔断。
 * 产出统一「原始记录」接口（不接 canonicalize/物化——那是抓取工作流的事）。
 *
 * 出网面：物理请求由注入的 ChannelHttpClient 执行；本模块不直接持有 fetch。
 * 失败语义：首请求即系统性失败 → FAILED；已拿到部分记录后失败/截断 → PARTIAL（CP-G7 修正方向）。
 */

export interface ConnectorRunOptions {
  /** 单轮请求预算（页/请求数）；probe 传 1。 */
  readonly maxRequests: number;
}

export interface ConnectorDependencies {
  readonly http: ChannelHttpClient;
  readonly secrets: ChannelSecretResolver;
  readonly breaker?: ChannelCircuitBreaker;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly retryPolicy?: RetryPolicy;
}

export interface ConnectorRunResult {
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  readonly records: RawChannelRecord[];
  readonly pagesFetched: number;
  readonly requests: number;
  readonly bytesFetched: number;
  readonly http4xx: number;
  readonly http5xx: number;
  readonly http429: number;
  readonly truncated: boolean;
  readonly errorCode: ChannelErrorCode | null;
  readonly circuitState: CircuitStateValue;
  readonly transitions: CircuitTransition[];
  readonly durationMs: number;
  readonly fieldFillRates: Record<string, number>;
}

type AttemptOutcome =
  | { readonly kind: 'response'; readonly response: ChannelHttpResponse }
  | { readonly kind: 'error'; readonly error: ChannelRuntimeError };

const RETRYABLE_CODES: ReadonlySet<ChannelErrorCode> = new Set(['CHANNEL_TIMEOUT', 'CHANNEL_UPSTREAM_5XX', 'CHANNEL_RATE_LIMITED']);

export class ManifestChannelConnector {
  private readonly deps: ConnectorDependencies;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ConnectorDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(manifest: ChannelManifestDocument, options: ConnectorRunOptions): Promise<ConnectorRunResult> {
    const startedAt = this.now();
    const transitions: CircuitTransition[] = [];
    const breaker = this.deps.breaker ?? new ChannelCircuitBreaker(null, {}, this.now);

    const result = (fields: Partial<ConnectorRunResult> & Pick<ConnectorRunResult, 'status'>): ConnectorRunResult => ({
      records: [],
      pagesFetched: 0,
      requests: 0,
      bytesFetched: 0,
      http4xx: 0,
      http5xx: 0,
      http429: 0,
      truncated: false,
      errorCode: null,
      transitions,
      durationMs: Math.max(0, this.now() - startedAt),
      fieldFillRates: {},
      ...fields,
      // 结束时快照（调用期间 breaker 可能已经变化）；这一处是 circuitState 的唯一来源。
      circuitState: breaker.snapshot().circuit,
    });

    if (manifest.transport.responseType !== 'json' || !manifest.records) {
      return result({ status: 'FAILED', errorCode: 'CHANNEL_MANIFEST_INVALID' });
    }
    if (manifest.records.detail?.enabled === true) {
      // 详情页逐条抓取属于后续波次；宁可明确拒绝，不在列表页作用域伪造详情字段。
      return result({ status: 'FAILED', errorCode: 'CHANNEL_DETAIL_UNSUPPORTED' });
    }

    let auth: ChannelAuthMaterial;
    try {
      auth = await resolveChannelAuth(manifest.auth, this.deps.secrets);
    } catch (error) {
      return result({ status: 'FAILED', errorCode: codeOf(error) });
    }

    let paginator: ChannelPaginator;
    try {
      // 分页器只受 manifest.maxPages（schema 上限 100）约束；运行预算由下面的
      // requests 计数判定，这样「预算截断」能如实落 truncated，而不是被分页器静默吞掉。
      paginator = new ChannelPaginator(manifest, { maxPages: 1000 });
    } catch (error) {
      return result({ status: 'FAILED', errorCode: codeOf(error) });
    }

    const bucket = new ChannelTokenBucket(manifest.rateLimit ?? {}, this.now);
    const domainDelayMs = perDomainDelayMs(manifest.rateLimit ?? {});
    const mappedKeys = Object.keys(manifest.fieldMapping ?? {});
    const records: RawChannelRecord[] = [];
    let pagesFetched = 0;
    let requests = 0;
    let bytesFetched = 0;
    let http4xx = 0;
    let http5xx = 0;
    let http429 = 0;
    let truncated = false;
    let errorCode: ChannelErrorCode | null = null;

    let plan: RequestPlanDraft | null = paginator.first();
    let firstPage = true;
    while (plan) {
      if (requests >= options.maxRequests) {
        truncated = true;
        break;
      }
      const decision = breaker.allowRequest();
      if (decision.transition) transitions.push(decision.transition);
      if (!decision.allowed) {
        errorCode = 'CHANNEL_CIRCUIT_OPEN';
        break;
      }

      const waitMs = bucket.acquire(this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      bucket.commit();
      if (!firstPage && domainDelayMs > 0) await this.sleep(domainDelayMs);

      const requestUrl = this.appendQuery(plan.url, auth.query);
      const pageUrl = this.redactUrl(plan.url, auth.query);
      const retryPolicy: RetryPolicy = {
        ...(this.deps.retryPolicy ?? DEFAULT_RETRY_POLICY),
        respectRetryAfter:
          manifest.rateLimit?.respectRetryAfter ?? this.deps.retryPolicy?.respectRetryAfter ?? DEFAULT_RETRY_POLICY.respectRetryAfter,
      };
      const outcome = await runWithRetries<AttemptOutcome>(
        async () => {
          requests += 1;
          try {
            const response = await this.deps.http.request({
              url: requestUrl,
              method: 'GET',
              headers: { ...(manifest.transport.headers ?? {}), ...auth.headers },
              allowedHosts: manifest.transport.allowedHosts ?? [],
              ...(manifest.transport.timeoutMs === undefined ? {} : { timeoutMs: manifest.transport.timeoutMs }),
              ...(manifest.transport.maxResponseBytes === undefined ? {} : { maxBytes: manifest.transport.maxResponseBytes }),
            });
            // 每个物理响应都计数（重试尝试也算），错误分布才是真实的上游画像。
            if (response.status === 429) http429 += 1;
            else if (response.status >= 500) http5xx += 1;
            else if (response.status >= 400) http4xx += 1;
            return { kind: 'response', response } as const;
          } catch (error) {
            return { kind: 'error', error: normalizeError(error) } as const;
          }
        },
        {
          policy: retryPolicy,
          isRetryable: (value) =>
            value.kind === 'error' ? RETRYABLE_CODES.has(value.error.code) : isRetryableStatus(value.response.status),
          retryAfterOf: (value) =>
            value.kind === 'response' ? parseRetryAfterMs(value.response.headers['retry-after'], this.now()) : null,
          sleep: this.sleep,
          now: this.now,
        },
      );

      if (outcome.kind === 'error') {
        errorCode = outcome.error.code;
        transitions.push(...breaker.recordFailure(errorCode));
        break;
      }
      const response = outcome.response;
      bytesFetched += Buffer.byteLength(response.bodyText, 'utf8');

      if (response.status < 200 || response.status >= 300) {
        errorCode = classifyStatus(response.status);
        transitions.push(...breaker.recordFailure(errorCode));
        break;
      }

      let body: unknown;
      try {
        body = JSON.parse(response.bodyText);
      } catch {
        errorCode = 'CHANNEL_PARSE_ERROR';
        transitions.push(...breaker.recordFailure(errorCode));
        break;
      }
      const items = itemsArray(body, manifest.records.itemsPath);
      if (items === null) {
        errorCode = 'CHANNEL_SCHEMA_MISMATCH';
        transitions.push(...breaker.recordFailure(errorCode));
        break;
      }
      transitions.push(...breaker.recordSuccess());
      const page = extractRecordsFromJson(manifest, body, this.redactUrl(response.finalUrl || pageUrl, auth.query));
      records.push(...page.records);
      pagesFetched += 1;
      firstPage = false;
      try {
        plan = paginator.next({ bodyText: response.bodyText, recordsCount: items.length });
      } catch (error) {
        errorCode = codeOf(error);
        break;
      }
    }

    const fieldFillRates: Record<string, number> = {};
    for (const key of mappedKeys) {
      const filled = records.filter((record) => (record.fields as Record<string, string | undefined>)[key] !== undefined).length;
      fieldFillRates[key] = records.length === 0 ? 0 : round3(filled / records.length);
    }

    const status: ConnectorRunResult['status'] =
      errorCode !== null || truncated ? (records.length > 0 ? 'PARTIAL' : 'FAILED') : 'SUCCEEDED';

    return result({
      status,
      records,
      pagesFetched,
      requests,
      bytesFetched,
      http4xx,
      http5xx,
      http429,
      truncated,
      errorCode,
      fieldFillRates,
    });
  }

  /** 查询参数形态的认证注入（apiKey/bearer 的 in=query）：只拼到实际请求，不进入记录。 */
  private appendQuery(rawUrl: string, query: Record<string, string>): string {
    if (Object.keys(query).length === 0) return rawUrl;
    try {
      const url = new URL(rawUrl);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  /** 去掉认证注入的查询参数（密钥绝不进 sourceUrl / 样本 / 落库）。 */
  private redactUrl(rawUrl: string, secretQuery: Record<string, string>): string {
    const names = Object.keys(secretQuery);
    if (names.length === 0) return rawUrl;
    try {
      const url = new URL(rawUrl);
      for (const name of names) url.searchParams.delete(name);
      return url.toString();
    } catch {
      return rawUrl;
    }
  }
}

function classifyStatus(status: number): ChannelErrorCode {
  if (status === 429) return 'CHANNEL_RATE_LIMITED';
  if (status === 401 || status === 403) return 'CHANNEL_AUTH_INVALID';
  if (status === 404) return 'CHANNEL_NOT_FOUND';
  if (status >= 500) return 'CHANNEL_UPSTREAM_5XX';
  return 'CHANNEL_HTTP_4XX';
}

function normalizeError(error: unknown): ChannelRuntimeError {
  if (isChannelRuntimeError(error)) return error;
  return channelError('CHANNEL_UPSTREAM_5XX', 'channel transport failed', { cause: error });
}

function codeOf(error: unknown): ChannelErrorCode {
  return isChannelRuntimeError(error) ? error.code : 'CHANNEL_MANIFEST_INVALID';
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
