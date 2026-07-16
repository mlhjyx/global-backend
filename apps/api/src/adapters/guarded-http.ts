import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  EgressBlockedError,
  resolvePublicHttpUrl,
  type PinnedPublicUrl,
  type PublicUrlResolver,
} from './url-guard';

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
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

interface PinnedHttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
}

export type PinnedHttpExecutor = (
  target: PinnedPublicUrl,
  options: Required<Omit<PublicHttpRequestOptions, 'headers'>> & {
    headers: Record<string, string>;
  },
) => Promise<PinnedHttpResult>;

export interface PublicHttpDependencies {
  resolver?: PublicUrlResolver;
  executePinned?: PinnedHttpExecutor;
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
    const requestOptions: RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: options.method,
      headers: options.headers,
      agent: false,
      // Host/SNI 保持原域名，但 socket 只连接守卫返回的 pin，关闭 DNS rebinding/TOCTOU。
      lookup: (_hostname, lookupOptions, callback) => {
        // Node 22 的 autoSelectFamily 会以 all=true 请求地址数组；两种 callback 形状都必须
        // 返回同一个已 pin 的地址，不能退回系统解析。
        if (typeof lookupOptions === 'object' && lookupOptions.all) {
          const callbackAll = callback as unknown as (
            error: NodeJS.ErrnoException | null,
            addresses: { address: string; family: number }[],
          ) => void;
          callbackAll(null, [{ address: target.ip, family: target.family }]);
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
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
      requestOptions,
      (response) => {
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
      },
    );
    // request.setTimeout 只是 socket 空闲超时；慢速端可定期吐 1 字节无限续命。
    // 用墙钟 deadline 给整次响应（含 body）设硬上限。
    const deadline = setTimeout(() => {
      request.destroy(new Error('public_http_timeout'));
    }, options.timeoutMs);
    request.once('error', finishReject);
    request.end();
  });

/**
 * 只访问公网 URL 的 GET/HEAD：初始 URL 与每一跳 redirect 均重新解析校验，实际连接固定到
 * 当次校验 IP；响应流按字节上限中止，避免 robots/sitemap 响应先撑爆内存再 slice。
 */
export async function requestPublicHttp(
  raw: string,
  options: PublicHttpRequestOptions = {},
  dependencies: PublicHttpDependencies = {},
): Promise<PublicHttpResponse> {
  const effective = {
    method: options.method ?? 'GET',
    headers: sanitizeRequestHeaders(options.headers),
    timeoutMs: Math.min(Math.max(options.timeoutMs ?? 15_000, 100), 30_000),
    maxBytes: Math.min(Math.max(options.maxBytes ?? 1_000_000, 1), 5_000_000),
    maxRedirects: Math.min(Math.max(options.maxRedirects ?? 3, 0), 5),
  };
  const resolver = dependencies.resolver ?? resolvePublicHttpUrl;
  const execute = dependencies.executePinned ?? executePinnedHttp;
  let current = raw;
  let currentHeaders = effective.headers;

  for (let hop = 0; hop <= effective.maxRedirects; hop++) {
    const target = await resolver(current);
    const response = await execute(target, { ...effective, headers: currentHeaders });
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
      current = next.toString();
    } catch {
      throw new EgressBlockedError('invalid_redirect');
    }
  }

  throw new EgressBlockedError('too_many_redirects');
}
