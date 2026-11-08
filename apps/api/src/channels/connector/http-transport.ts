import {
  EgressBlockedError,
  isPublicHttpTransportFailure,
  requestPublicHttp,
  type PublicHttpDependencies,
} from '../../adapters/guarded-http';
import { resolvePublicHttpUrl } from '../../adapters/url-guard';
import { hostAllowed } from './channel-manifest';
import { channelError } from './errors';

/**
 * 连接器物理请求面（失败闭合）：
 *   - 只用既有 guarded-http（https、公网 IP 校验、逐跳重定向复验、字节上限、墙钟 deadline）；
 *   - 出网前必须命中 manifest.transport.allowedHosts（每一跳都校验）；
 *   - **必须**注入 platform egress 绑定（beforePhysicalWire = Grant/fence 的 authorize+ACK）。
 *     本波没有在组合根里接这道绑定，因此 GuardedChannelHttpClient 在缺绑定时一律
 *     CHANNEL_EGRESS_DENIED —— 不存在「未治理出网」的可用路径（CH-5 接线后才有）。
 */

export interface ChannelHttpRequest {
  readonly url: string;
  readonly method: 'GET';
  readonly headers: Record<string, string>;
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface ChannelHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
  readonly finalUrl: string;
  readonly durationMs: number;
}

export interface ChannelHttpClient {
  request(request: ChannelHttpRequest): Promise<ChannelHttpResponse>;
}

/** Nest 注入令牌：缺省不提供（probe/run 端点即 fail-closed 503）。 */
export const CHANNEL_HTTP_CLIENT = 'CHANNEL_HTTP_CLIENT';

export interface GuardedChannelHttpClientOptions extends PublicHttpDependencies {
  /** 渠道 manifest 只允许 https（章节 §6.3.10）。 */
  readonly enforceHttps?: boolean;
}

export class GuardedChannelHttpClient implements ChannelHttpClient {
  private readonly dependencies: PublicHttpDependencies;
  private readonly enforceHttps: boolean;

  constructor(dependencies: PublicHttpDependencies = {}, options: GuardedChannelHttpClientOptions = {}) {
    this.dependencies = dependencies;
    this.enforceHttps = options.enforceHttps ?? true;
  }

  async request(request: ChannelHttpRequest): Promise<ChannelHttpResponse> {
    if (!this.dependencies.beforePhysicalWire) {
      // 本波未接平台围栏：宁可明确拒绝，也不产生绕过治理的出网路径。
      throw channelError('CHANNEL_EGRESS_DENIED', 'channel egress binding is not wired in this process');
    }
    let initial: URL;
    try {
      initial = new URL(request.url);
    } catch {
      throw channelError('CHANNEL_MANIFEST_INVALID', 'request url is invalid');
    }
    if (this.enforceHttps && initial.protocol !== 'https:') {
      throw channelError('CHANNEL_EGRESS_DENIED', 'channel requests must use https');
    }
    if (!hostAllowed(initial.hostname, request.allowedHosts)) {
      throw channelError('CHANNEL_HOST_NOT_ALLOWED', `host not allowed: ${initial.hostname}`);
    }

    const startedAt = Date.now();
    const resolver = async (raw: string) => {
      const next = new URL(raw);
      if (this.enforceHttps && next.protocol !== 'https:') {
        throw channelError('CHANNEL_EGRESS_DENIED', 'redirect must stay on https');
      }
      if (!hostAllowed(next.hostname, request.allowedHosts)) {
        throw channelError('CHANNEL_HOST_NOT_ALLOWED', `redirect host not allowed: ${next.hostname}`);
      }
      return (this.dependencies.resolver ?? resolvePublicHttpUrl)(raw);
    };
    try {
      const response = await requestPublicHttp(
        request.url,
        {
          method: 'GET',
          headers: request.headers,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        },
        {
          ...this.dependencies,
          resolver,
        },
      );
      return {
        status: response.status,
        headers: response.headers,
        bodyText: response.text,
        finalUrl: response.finalUrl,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw mapTransportError(error);
    }
  }
}

function mapTransportError(error: unknown): unknown {
  if (error instanceof EgressBlockedError) {
    if (error.code === 'response_too_large') {
      return channelError('CHANNEL_RESPONSE_TOO_LARGE', 'upstream response exceeded maxResponseBytes', { cause: error });
    }
    return channelError('CHANNEL_EGRESS_DENIED', `egress blocked: ${error.code}`, { cause: error });
  }
  if (error instanceof Error && /public_http_timeout|timeout/iu.test(error.message)) {
    return channelError('CHANNEL_TIMEOUT', 'upstream request timed out', { cause: error });
  }
  if (isPublicHttpTransportFailure(error)) {
    return channelError('CHANNEL_UPSTREAM_5XX', 'upstream transport failed', { cause: error });
  }
  return error;
}
