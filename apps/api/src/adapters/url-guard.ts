import { BadRequestException } from '@nestjs/common';
import { resolvePublicIp, type ResolvePublicIpOptions } from './net-guard';

export class EgressBlockedError extends Error {
  constructor(public readonly code: string) {
    super('URL blocked');
    this.name = 'EgressBlockedError';
  }
}

export interface PinnedPublicUrl {
  url: URL;
  ip: string;
  family: 4 | 6;
}

export type PublicUrlResolver = (
  raw: string,
  options?: ResolvePublicIpOptions,
) => Promise<PinnedPublicUrl>;

/** 校验 URL 并返回一次解析所得的连接 IP；调用方必须使用该 IP，禁止二次 DNS。 */
export const resolvePublicHttpUrl: PublicUrlResolver = async (raw, options = {}) => {
  if (!raw || raw.length > 2_000) throw new EgressBlockedError('invalid_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressBlockedError('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressBlockedError('invalid_scheme');
  }
  if (url.username || url.password) throw new EgressBlockedError('url_credentials_forbidden');

  const resolution = await resolvePublicIp(url.hostname, options);
  if (!resolution.safe || !resolution.ip || !resolution.family) {
    throw new EgressBlockedError(resolution.reason ?? 'url_blocked');
  }
  return { url, ip: resolution.ip, family: resolution.family };
};

/** Controller/service 输入校验兼容层：不泄露解析地址，只返回稳定 INVALID_URL 信封。 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  try {
    return (await resolvePublicHttpUrl(raw)).url;
  } catch {
    throw new BadRequestException({
      error: { code: 'INVALID_URL', message: 'URL 必须是可解析的公网 http/https 地址' },
    });
  }
}
