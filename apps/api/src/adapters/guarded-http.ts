import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  EgressBlockedError,
  resolvePublicHttpUrl,
  type PinnedPublicUrl,
  type PublicUrlResolver } from './url-guard';

export { EgressBlockedError } from './url-guard';
export type { PinnedPublicUrl, PublicUrlResolver } from './url-guard';

export interface PublicHttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
  finalUrl: string;
}

export interface PublicHttpRequestOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  redirect?: 'follow' | 'manual';
}

interface PinnedHttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
}

// Node 22 http.request forwards these net connection options at runtime；当前仓库的
// @types/node 版本尚未把它们暴露在 RequestOptions 上，故在本地交叉类型补齐。
type HappyEyeballsRequestOptions = RequestOptions & {
  autoSelectFamily: boolean;
  autoSelectFamilyAttemptTimeout: number;
};

export type PinnedHttpExecutor = (
  target: PinnedPublicUrl,
  options: {
    method: NonNullable<PublicHttpRequestOptions['method']>;
    headers: Record<string, string>;
    body?: Buffer;
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    redirect: NonNullable<PublicHttpRequestOptions['redirect']>;
  },
) => Promise<PinnedHttpResult>;

export interface PublicHttpDependencies {
  resolver?: PublicUrlResolver;
  executePinned?: PinnedHttpExecutor;
  /** Acquisition suppression admission, rechecked before DNS and every wire hop. */
  authorizeExternalAction?: () => Promise<boolean>;
  /** Caller policy admission, rechecked exactly once immediately before each physical request. */
  beforeRequest?: () => Promise<void>;
  /** Cost observation fired only after all gates/DNS checks and immediately before socket execution. */
  onRequestStarted?: () => void;
}

const MAX_PUBLIC_HTTP_REQUEST_BYTES = 1_000_000;

export class ExternalHttpActionDeniedError extends Error {
  readonly decision = 'suppression_action_gate';

  constructor(options?: { cause?: unknown }) {
    super('external action denied: suppression_action_gate', options);
    this.name = 'ExternalHttpActionDeniedError';
  }
}

async function assertExternalHttpActionAuthorized(authorizeExternalAction?: () => Promise<boolean>): Promise<void> {
  if (!authorizeExternalAction) return;
  try {
    if ((await authorizeExternalAction()) === true) return;
  } catch (cause) {
    throw new ExternalHttpActionDeniedError({ cause });
  }
  throw new ExternalHttpActionDeniedError();
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') normalized[name] = value;
    else if (Array.isArray(value)) normalized[name] = value.join(', ');
  }
  return normalized;
}

function sanitizeRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (['host', 'connection', 'proxy-authorization', 'proxy-connection'].includes(lower)) continue;
    result[name] = value;
  }
  return result;
}

const executePinnedHttp: PinnedHttpExecutor = async (target, options) =>
  new Promise<PinnedHttpResult>((resolve, reject) => {
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(error);
    };
    const finishResolve = (value: PinnedHttpResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(value);
    };
    const requestOptions: HappyEyeballsRequestOptions = {
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: options.method,
      headers: options.headers,
      agent: false,
      // 强制 Node 取回完整的已验证地址集并做 Happy Eyeballs；不会回到系统 DNS。
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      // Host/SNI 保持原域名，但 socket 只连接守卫返回的 pin，关闭 DNS rebinding/TOCTOU。
      lookup: (_hostname, lookupOptions, callback) => {
        // Node 22 的 autoSelectFamily 会以 all=true 请求地址数组；两种 callback 形状都必须
        // 返回同一个已 pin 的地址，不能退回系统解析。
        if (typeof lookupOptions === 'object' && lookupOptions.all) {
          const callbackAll = callback as unknown as (
            error: NodeJS.ErrnoException | null,
            addresses: { address: string; family: number }[],
          ) => void;
          callbackAll(null, target.addresses);
          return;
        }
        const callbackOne = callback as unknown as (
          error: NodeJS.ErrnoException | null,
          address: string,
          family: number,
        ) => void;
        callbackOne(null, target.ip, target.family);
      },
    };
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const contentLength = Number(response.headers['content-length'] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
        response.destroy();
        finishReject(new EgressBlockedError('response_too_large'));
        return;
      }
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > options.maxBytes) {
          response.destroy();
          finishReject(new EgressBlockedError('response_too_large'));
          return;
        }
        if (options.method !== 'HEAD') chunks.push(buffer);
      });
      response.once('end', () => {
        const body = options.method === 'HEAD' ? Buffer.alloc(0) : Buffer.concat(chunks);
        finishResolve({
          status: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          body,
          text: body.toString('utf8'),
        });
      });
      response.once('error', finishReject);
    });
    // request.setTimeout 只是 socket 空闲超时；慢速端可定期吐 1 字节无限续命。
    // 用墙钟 deadline 给整次响应（含 body）设硬上限。
    const deadline = setTimeout(() => {
      request.destroy(new Error('public_http_timeout'));
    }, options.timeoutMs);
    request.once('error', finishReject);
    if (options.body && options.method !== 'HEAD') request.write(options.body);
    request.end();
  });

/**
 * 只访问公网 URL 的 GET/HEAD/POST：初始 URL 与每一跳 redirect 均重新解析校验，实际连接固定到
 * 当次校验 IP；响应流按字节上限中止，避免 robots/sitemap 响应先撑爆内存再 slice。
 */
export async function requestPublicHttp(
  raw: string,
  options: PublicHttpRequestOptions = {},
  dependencies: PublicHttpDependencies = {},
): Promise<PublicHttpResponse> {
  const body = options.body == null ? undefined : Buffer.from(options.body);
  if (body && body.length > MAX_PUBLIC_HTTP_REQUEST_BYTES) {
    throw new EgressBlockedError('request_body_too_large');
  }
  let headers = sanitizeRequestHeaders(options.headers);
  if (body) {
    headers = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
    );
    headers['content-length'] = String(body.length);
  }
  const effective = {
    method: options.method ?? 'GET',
    headers,
    body,
    timeoutMs: Math.min(Math.max(options.timeoutMs ?? 15_000, 100), 30_000),
    maxBytes: Math.min(Math.max(options.maxBytes ?? 1_000_000, 1), 8 * 1024 * 1024),
    maxRedirects: Math.min(Math.max(options.maxRedirects ?? 3, 0), 5),
    redirect: options.redirect ?? 'follow',
  };
  if (effective.body && effective.method !== 'POST') throw new EgressBlockedError('request_body_forbidden');
  const resolver = dependencies.resolver ?? resolvePublicHttpUrl;
  const execute = dependencies.executePinned ?? executePinnedHttp;
  let current = raw;
  let currentHeaders = effective.headers;
  let currentMethod = effective.method;
  let currentBody = effective.body;

  for (let hop = 0; hop <= effective.maxRedirects; hop++) {
    await assertExternalHttpActionAuthorized(dependencies.authorizeExternalAction);
    const target = await resolver(current);
    await assertExternalHttpActionAuthorized(dependencies.authorizeExternalAction);
    await dependencies.beforeRequest?.();
    dependencies.onRequestStarted?.();
    const response = await execute(target, {
      ...effective,
      method: currentMethod,
      body: currentBody,
      headers: currentHeaders,
    });
    if (response.status < 300 || response.status >= 400) {
      return {
        ...response,
        ok: response.status >= 200 && response.status < 300,
        finalUrl: target.url.toString(),
      };
    }
    const location = response.headers.location;
    if (!location) {
      return { ...response, ok: false, finalUrl: target.url.toString() };
    }
    if (effective.redirect === 'manual') {
      return { ...response, ok: false, finalUrl: target.url.toString() };
    }
    if (hop === effective.maxRedirects) {
      throw new EgressBlockedError('too_many_redirects');
    }
    try {
      const next = new URL(location, target.url);
      if (next.origin !== target.url.origin) {
        // 即使当前调用者误带认证信息，也不能在跨域 redirect 时泄给另一站。
        currentHeaders = Object.fromEntries(
          Object.entries(currentHeaders).filter(
            ([name]) => !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
          ),
        );
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
        currentHeaders = Object.fromEntries(
          Object.entries(currentHeaders).filter(
            ([name]) => !['content-length', 'content-type'].includes(name.toLowerCase()),
          ),
        );
      }
      current = next.toString();
    } catch {
      throw new EgressBlockedError('invalid_redirect');
    }
  }

  throw new EgressBlockedError('too_many_redirects');
}
