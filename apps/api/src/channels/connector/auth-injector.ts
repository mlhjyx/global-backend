import type { ChannelManifestDocument } from '@global/contracts';
import { channelError } from './errors';
import type { ChannelSecretResolver } from './secret-resolver';

/**
 * 认证注入（章节 §6.3.5）：值只在内存里短暂存在，注入后由调用方丢弃；
 * 错误信息不含值；禁止注入受保护头（Host/Content-Length/Cookie/Connection 等）。
 *
 * 支持（本波）：none / apiKey（header|query）/ bearer / header / basic。
 * oauth2_client_credentials：schema 留位、v1 明确 CHANNEL_AUTH_UNSUPPORTED。
 */

export interface ChannelAuthMaterial {
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
}

type AuthConfig = NonNullable<ChannelManifestDocument['auth']>;

const PROTECTED_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
const QUERY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

function assertHeaderName(name: string): void {
  if (!HEADER_NAME_PATTERN.test(name) || PROTECTED_HEADER_NAMES.has(name.toLowerCase())) {
    throw channelError('CHANNEL_MANIFEST_INVALID', `auth header name not allowed: ${name}`);
  }
}

function assertQueryName(name: string): void {
  if (!QUERY_NAME_PATTERN.test(name)) {
    throw channelError('CHANNEL_MANIFEST_INVALID', `auth query parameter name not allowed: ${name}`);
  }
}

export async function resolveChannelAuth(
  auth: AuthConfig | undefined,
  resolver: ChannelSecretResolver,
): Promise<ChannelAuthMaterial> {
  if (!auth || auth.type === 'none') return { headers: {}, query: {} };

  if (auth.type === 'apiKey' || auth.type === 'bearer' || auth.type === 'header') {
    const target = auth.in ?? 'header';
    const name =
      auth.name ??
      (auth.type === 'header' ? undefined : target === 'header' ? 'Authorization' : undefined);
    if (!name) throw channelError('CHANNEL_MANIFEST_INVALID', 'auth name is required for this auth type');
    const secret = await resolver.resolve(auth.secretRef);
    if (target === 'query') {
      assertQueryName(name);
      return { headers: {}, query: { [name]: secret.value } };
    }
    assertHeaderName(name);
    const value = auth.type === 'bearer' ? `Bearer ${secret.value}` : secret.value;
    return { headers: { [name]: value }, query: {} };
  }

  if (auth.type === 'basic') {
    const username = await resolver.resolve(auth.usernameRef);
    const password = await resolver.resolve(auth.passwordRef);
    return {
      headers: { Authorization: `Basic ${Buffer.from(`${username.value}:${password.value}`, 'utf8').toString('base64')}` },
      query: {},
    };
  }

  throw channelError('CHANNEL_AUTH_UNSUPPORTED', 'oauth2_client_credentials is not executed in v1');
}

/** 供日志/诊断使用：只暴露注入位置（名字），永不返回值。 */
export function redactAuthForLog(material: ChannelAuthMaterial): {
  headerNames: string[];
  queryNames: string[];
} {
  return { headerNames: Object.keys(material.headers), queryNames: Object.keys(material.query) };
}
