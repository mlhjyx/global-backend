import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * SSRF 出网护栏（平台级共享）。规则不是“列几个私网段”，而是只允许 ipaddr.js
 * 判定为普通 global unicast 的地址；保留/文档/CGNAT/multicast/IPv6 过渡形态全部拒绝。
 *
 * Ubuntu mihomo 会把公网域名全部映射到 RFC 2544 的 198.18/15。只有当系统 DNS 的
 * **全部**答案都属于该 fake-IP 段时，才向固定 Cloudflare DoH 端点查询真实答案；
 * 真私网或 fake+private 混合答案绝不借 DoH 洗白。
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (host: string) => Promise<ResolvedAddress[]>;

export interface ResolvePublicIpOptions {
  systemLookup?: HostResolver;
  dohLookup?: HostResolver;
}

export interface PublicIpResolution {
  safe: boolean;
  ip?: string;
  family?: 4 | 6;
  reason?: string;
}

const FAKE_IP_RANGE = ipaddr.parseCIDR('198.18.0.0/15');
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DNS_TIMEOUT_MS = 5_000;

function parsedIp(ip: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    return ipaddr.parse(ip);
  } catch {
    return null;
  }
}

function isMihomoFakeIp(ip: string): boolean {
  const parsed = parsedIp(ip);
  return parsed?.kind() === 'ipv4' && parsed.match(FAKE_IP_RANGE);
}

/** 保留旧函数名兼容 SMTP 调用方；true 实际表示“不是普通 global unicast”。 */
export function isPrivateIp(ip: string): boolean {
  const parsed = parsedIp(ip);
  if (!parsed) return true;
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().range() !== 'unicast';
  }
  return parsed.range() !== 'unicast';
}

const systemLookup: HostResolver = async (host) => {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

interface DnsJsonAnswer {
  type?: number;
  data?: string;
}

interface DnsJsonResponse {
  Status?: number;
  Answer?: DnsJsonAnswer[];
}

async function queryDoh(host: string, type: 'A' | 'AAAA'): Promise<ResolvedAddress[]> {
  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set('name', host);
  url.searchParams.set('type', type);
  const response = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('doh_lookup_failed');
  const body = (await response.json()) as DnsJsonResponse;
  if (body.Status !== 0 && body.Status !== 3) throw new Error('doh_lookup_failed');
  const wantedType = type === 'A' ? 1 : 28;
  return (body.Answer ?? [])
    .filter((answer) => answer.type === wantedType && typeof answer.data === 'string')
    .flatMap((answer) => {
      const family = isIP(answer.data as string);
      return family === 4 || family === 6
        ? [{ address: answer.data as string, family }]
        : [];
    });
}

const dohLookup: HostResolver = async (host) => {
  const [v4, v6] = await Promise.all([queryDoh(host, 'A'), queryDoh(host, 'AAAA')]);
  const answers = [...v4, ...v6];
  if (!answers.length) throw new Error('dns_lookup_failed');
  return answers;
};

/**
 * 解析主机名并拒绝任一非全局答案；返回的 IP 必须由调用方直接用于连接，不能再解析 host。
 * 错误 reason 保持不含目标地址，避免把守卫变成内部 DNS/IP oracle。
 */
export async function resolvePublicIp(
  host: string,
  options: ResolvePublicIpOptions = {},
): Promise<PublicIpResolution> {
  if (!host || host.length > 253 || isIP(host)) {
    return { safe: false, reason: 'ip_literal_not_allowed' };
  }
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  if (!normalizedHost || normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) {
    return { safe: false, reason: 'blocked_hostname' };
  }

  const resolveSystem = options.systemLookup ?? systemLookup;
  const resolveDoh = options.dohLookup ?? dohLookup;
  let answers: ResolvedAddress[];
  try {
    answers = await resolveSystem(normalizedHost);
  } catch {
    return { safe: false, reason: 'dns_lookup_failed' };
  }
  if (!answers.length) return { safe: false, reason: 'no_address' };

  if (answers.every((answer) => isMihomoFakeIp(answer.address))) {
    try {
      answers = await resolveDoh(normalizedHost);
    } catch {
      return { safe: false, reason: 'dns_lookup_failed' };
    }
  }

  if (!answers.length) return { safe: false, reason: 'no_address' };
  if (answers.some((answer) => isPrivateIp(answer.address))) {
    return { safe: false, reason: 'non_global_address' };
  }
  const first = answers[0];
  return { safe: true, ip: first.address, family: first.family };
}
