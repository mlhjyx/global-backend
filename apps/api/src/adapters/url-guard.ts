import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';

/**
 * PRD 10.7.3: 不得把任意用户 URL 原样交给浏览器服务。API 侧先行校验：
 * scheme 白名单 + 公网地址（拒内网/loopback/link-local/metadata），
 * Crawl4AI 自身的 egress 防护应是第二道，不是唯一一道。
 *
 * 注意：该 helper 当前只覆盖显式调用它的 CompanyService 路径；Site Builder intake、
 * robots 直连及 Crawl4AI redirect 的统一 egress gate 仍属于 R1-safety。Ubuntu mihomo
 * fake-IP 开发环境也不能用 broad allow-internal 代替生产校验。
 */

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) || // link-local / cloud metadata
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) // CGNAT
  );
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice(7);
      if (isIP(v4) === 4) return isPrivateIPv4(v4);
    }
    return isPrivateIPv6(lower);
  }
  return true; // unknown format → treat as unsafe
}

const reject = (message: string): never => {
  throw new BadRequestException({ error: { code: 'INVALID_URL', message } });
};

/** Validate a user-supplied website URL before any crawler ever sees it. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  if (!raw || raw.length > 2000) reject('URL 为空或过长');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('URL 格式不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) reject('仅支持 http/https');
  if (url.username || url.password) reject('URL 不允许携带认证信息');
  const host = url.hostname;
  if (isIP(host)) {
    if (isPrivateIp(host)) reject('不允许内网/保留地址');
    return url;
  }
  // DEV 例外：仅限开发者可信 URL；不得在生产或不可信输入路径启用。
  if (process.env.CRAWLER_ALLOW_PRIVATE === 'true') return url;
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) reject('域名解析到内网/保留地址');
  } catch {
    reject('域名无法解析');
  }
  return url;
}
