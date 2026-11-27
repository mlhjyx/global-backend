import { PLATFORM_ROBOTS_RESPONSE_MAX_BYTES } from '../platform-authority/platform-execution-contract';
import { requestPublicHttp } from './guarded-http';
import { resolvePublicHttpUrl } from './url-guard';

export const DISCOVERY_V3_ROBOTS_TIMEOUT_MS = 10_000;
const UNRESOLVED = 'DISCOVERY_V3_ROBOTS_RESPONSE_UNRESOLVED';

export type PrepareDiscoveryV3Robots = () => Promise<(signal: AbortSignal) => Promise<boolean>>;
export type CheckDiscoveryV3Robots = (targetUrl: string, prepare: PrepareDiscoveryV3Robots) => Promise<boolean>;

export function discoveryV3RobotsTarget(targetUrl: string): { robotsUrl: string; path: string } {
  let target: URL;
  try { target = new URL(targetUrl); } catch { throw new Error('DISCOVERY_V3_ROBOTS_TARGET_INVALID'); }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) {
    throw new Error('DISCOVERY_V3_ROBOTS_TARGET_INVALID');
  }
  return { robotsUrl: new URL('/robots.txt', target).href, path: `${target.pathname}${target.search}` };
}

/** The preparation is invoked only for a fresh operation. Its DNS pins are reused by the wire. */
export function isAllowedByDiscoveryV3Robots(targetUrl: string, check: CheckDiscoveryV3Robots): Promise<boolean> {
  const { robotsUrl, path } = discoveryV3RobotsTarget(targetUrl);
  return check(targetUrl, async () => {
    const target = await resolvePublicHttpUrl(targetUrl);
    return async (signal) => {
      const response = await requestPublicHttp(robotsUrl, {
        timeoutMs: DISCOVERY_V3_ROBOTS_TIMEOUT_MS,
        maxBytes: PLATFORM_ROBOTS_RESPONSE_MAX_BYTES,
        maxRedirects: 0,
        headers: { 'User-Agent': 'GlobalBot/1.0' },
      }, {
        resolver: async (raw) => {
          if (raw !== robotsUrl || new URL(raw).origin !== target.url.origin) {
            throw new Error('DISCOVERY_V3_ROBOTS_TARGET_INVALID');
          }
          return { ...target, url: new URL(robotsUrl) };
        },
        dispatchPhysicalWire: (execute) => execute(signal),
      });
      if (response.status === 401 || response.status === 403) return false;
      if (response.status === 404 || response.status === 410) return true;
      if (response.status !== 200 || !/^text\/plain(?:\s*;|$)/iu.test(response.headers['content-type'] ?? '')) {
        throw new Error(UNRESOLVED);
      }
      let robots: string;
      try { robots = new TextDecoder('utf-8', { fatal: true }).decode(response.body); } catch { throw new Error(UNRESOLVED); }
      return discoveryV3RobotsAllowsPath(robots, path);
    };
  });
}

function normalizePath(value: string): string {
  return value.replace(/%([0-9a-f]{2})|[^\x20-\x7e]/giu, (character, hexadecimal: string | undefined) => {
    if (!hexadecimal) return encodeURIComponent(character);
    const decoded = String.fromCharCode(Number.parseInt(hexadecimal, 16));
    return /^[a-z0-9._~-]$/iu.test(decoded) ? decoded : character.toUpperCase();
  });
}

/** Match the robots glob from the beginning of the path, without a backtracking regex. */
function disallowMatches(path: string, rule: string): boolean {
  const exact = rule.endsWith('$');
  const pattern = exact ? rule.slice(0, -1) : rule;
  if (!pattern.includes('*')) return exact ? path === pattern : path.startsWith(pattern);
  const [prefix, ...parts] = pattern.split('*');
  const suffix = exact ? parts.pop() ?? '' : '';
  const end = path.length - suffix.length;
  if (!path.startsWith(prefix!) || !path.endsWith(suffix) || prefix!.length > end) return false;
  let offset = prefix!.length;
  for (const part of parts) {
    const next = path.indexOf(part, offset);
    if (next < 0 || next + part.length > end) return false;
    offset = next + part.length;
  }
  return true;
}

export function discoveryV3RobotsAllowsPath(robots: string, path: string): boolean {
  const normalized = normalizePath(path);
  let applies = false;
  let hasUserAgent = false;
  let hasRule = false;
  // Conservatively honor disallows from both wildcard and GlobalBot groups.
  for (const raw of robots.split(/\r?\n/u)) {
    const line = raw.split('#', 1)[0]!.trim();
    if (!line) continue;
    const directive = /^([a-z][a-z0-9_-]*)\s*:\s*(.*?)$/iu.exec(line);
    if (!directive) throw new Error(UNRESOLVED);
    const field = directive[1]!.toLowerCase();
    const value = directive[2]!;
    if (field === 'user-agent') {
      if (!value) throw new Error(UNRESOLVED);
      if (hasRule) { applies = false; hasRule = false; }
      hasUserAgent = true;
      applies ||= value === '*' || /^globalbot(?:\/|\s|$)/iu.test(value);
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    if (!hasUserAgent) throw new Error(UNRESOLVED);
    hasRule = true;
    if (applies && field === 'disallow' && value && disallowMatches(normalized, normalizePath(value))) return false;
  }
  return true;
}
