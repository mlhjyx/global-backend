import { lookup } from 'node:dns/promises';

/**
 * SSRF 出网护栏（平台级共享）。任何「目标主机来自外部/语料、可被投毒」的原始出网
 * （SMTP 连 MX、plain-fetch sitemap 等）在连接前都应过这里：解析到公网 IP 才放行，
 * 拒私网/保留/链路本地/云元数据地址。避免被指向内网的域名驱动内部请求。
 */

/** IPv4/IPv6 私有·保留·链路本地·CGNAT·回环 判定。 */
export function isPrivateIp(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // 链路本地 + 云元数据 169.254.169.254
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  const low = ip.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
}

/**
 * 解析主机名并判断是否**全部**解析到公网 IP（任一私网即判不安全）。
 * 返回解析到的首个公网 IP（供调用方直接连该 IP，避免 connect 时二次解析的 TOCTOU/DNS rebinding）。
 */
export async function resolvePublicIp(host: string): Promise<{ safe: boolean; ip?: string; reason?: string }> {
  // IP 字面量直接判定（不接受直接给 IP 目标）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return { safe: false, reason: 'ip_literal_not_allowed' };
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { safe: false, reason: 'dns_lookup_failed' };
  }
  if (!addrs.length) return { safe: false, reason: 'no_address' };
  const bad = addrs.find((a) => isPrivateIp(a.address));
  if (bad) return { safe: false, reason: `private_ip:${bad.address}` };
  return { safe: true, ip: addrs[0].address };
}
