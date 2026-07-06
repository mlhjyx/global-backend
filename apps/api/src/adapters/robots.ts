/**
 * 轻量 robots.txt 检查（DAT-011 / 10.7.3）：抓取任意公开来源前，确认目标路径
 * 未被该域名的 robots.txt 对通配 UA 禁止。这是我方侧的第一道合规闸门——
 * 红线是「不绕过访问控制」，被 Disallow 的路径直接放弃，不换 UA 硬闯。
 *
 * 只解析 `User-agent: *` 段的 Disallow 前缀（够用于「首页是否可抓」判断）；
 * 复杂 robots（Allow 覆盖、按 UA 细分）从严处理为不可抓。结果带 TTL 缓存。
 */

interface RobotsRule {
  disallow: string[];
  fetchedAt: number;
}

const cache = new Map<string, RobotsRule>();
const TTL_MS = 60 * 60 * 1000; // 1h（生产可对齐 SourcePolicy）

async function loadRobots(origin: string): Promise<RobotsRule> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  let disallow: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const text = (await res.text()).slice(0, 100_000);
      disallow = parseWildcardDisallow(text);
    }
    // 4xx/无 robots → 视为无限制（RFC 惯例）
  } catch {
    // robots 不可达：保守放行首页级抓取（不放行深层），此处返回空 disallow
  }
  const rule = { disallow, fetchedAt: Date.now() };
  cache.set(origin, rule);
  return rule;
}

/** 解析 `User-agent: *` 段落下的 Disallow 前缀。 */
export function parseWildcardDisallow(robotsText: string): string[] {
  const lines = robotsText.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  const disallow: string[] = [];
  let inStar = false;
  for (const line of lines) {
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      inStar = value === '*';
    } else if (field === 'disallow' && inStar && value) {
      disallow.push(value);
    }
  }
  return disallow;
}

/** 目标 URL 是否允许抓取（通配 UA 视角）。 */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const rule = await loadRobots(u.origin);
  const path = u.pathname || '/';
  // 任一 Disallow 前缀命中路径 → 禁止。Disallow: / 表示全站禁抓。
  return !rule.disallow.some((d) => path.startsWith(d));
}
