/**
 * 渠道连接器错误词表（GainOS v3.0 第 6 章 §6.3.5）。
 *
 * 所有错误都带稳定 code（落 source_channel_run.error_code / probe.error_code / 运营台提示）。
 * 错误信息绝不含密钥值或完整请求头（认证注入失败只报 CHANNEL_SECRET_UNAVAILABLE /
 * CHANNEL_AUTH_INVALID，不区分 not-found/decrypt-failed，防探测）。
 */

export const CHANNEL_ERROR_CODES = [
  'CHANNEL_MANIFEST_INVALID',
  'CHANNEL_SECRET_UNAVAILABLE',
  'CHANNEL_AUTH_INVALID',
  'CHANNEL_AUTH_UNSUPPORTED',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_RATE_LIMITED',
  'CHANNEL_UPSTREAM_5XX',
  'CHANNEL_HTTP_4XX',
  'CHANNEL_TIMEOUT',
  'CHANNEL_SCHEMA_MISMATCH',
  'CHANNEL_PARSE_ERROR',
  'CHANNEL_QUOTA_EXCEEDED',
  'CHANNEL_EGRESS_DENIED',
  'CHANNEL_ROBOTS_DENIED',
  'CHANNEL_CIRCUIT_OPEN',
  'CHANNEL_HOST_NOT_ALLOWED',
  'CHANNEL_RESPONSE_TOO_LARGE',
  'CHANNEL_DETAIL_UNSUPPORTED',
  'CHANNEL_METHOD_UNSUPPORTED',
  'CHANNEL_PAGINATION_UNSUPPORTED',
] as const;

export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

/** 默认按「瞬时故障可重试」分类（与 §6.3.5 的 429/5xx/超时一致）。 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ChannelErrorCode> = new Set([
  'CHANNEL_TIMEOUT',
  'CHANNEL_UPSTREAM_5XX',
  'CHANNEL_RATE_LIMITED',
]);

export interface ChannelRuntimeErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class ChannelRuntimeError extends Error {
  readonly code: ChannelErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ChannelErrorCode, message?: string, options: ChannelRuntimeErrorOptions = {}) {
    super(message ?? code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChannelRuntimeError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    if (options.details) this.details = options.details;
  }
}

export function channelError(
  code: ChannelErrorCode,
  message?: string,
  options?: ChannelRuntimeErrorOptions,
): ChannelRuntimeError {
  return new ChannelRuntimeError(code, message, options);
}

export function isChannelRuntimeError(value: unknown): value is ChannelRuntimeError {
  return value instanceof ChannelRuntimeError;
}
