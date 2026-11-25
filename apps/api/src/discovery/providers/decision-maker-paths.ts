/**
 * 决策人抓页多语种固定路径与 HTTP-first 快速探测辅助（Batch 1.4-D）。
 *
 * 实测 run 607b314d 暴露的问题：
 *  1) 固定路径曾写死德语（`/impressum`、`/kontakt`、`/ueber-uns`），在意大利/西语/法语/英语站点上
 *     全员 404，还被送进无头浏览器（crawl4ai）每页空耗 23-71 秒；
 *  2) 裸域 TLS 证书只签了 `www.`（如 `coenergia.com` → `www.coenergia.com`）时直接报错未重试。
 *
 * 本模块按公司国别/ccTLD 选出匹配语种的固定路径，对未在首页发现的盲猜路径先用轻量 `http.get`
 * 探测（400/404/410 立刻跳过，200 且正文充足直接免开浏览器），并支持同可注册域的 `www.` 互切。
 */
import { inferCountryFromCcTld } from '../domain-country';
import { stripHtml } from '../impressum/impressum-extract';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';

const GERMAN_PATHS = ['/impressum', '/kontakt', '/en/imprint', '/impressum.html', '/team', '/ueber-uns'] as const;
const ITALIAN_PATHS = ['/contatti', '/chi-siamo', '/azienda', '/team', '/about', '/contact'] as const;
const SPANISH_PATHS = ['/contacto', '/quienes-somos', '/equipo', '/empresa', '/about', '/contact'] as const;
const FRENCH_PATHS = ['/mentions-legales', '/contact', '/equipe', '/a-propos', '/team', '/about'] as const;
const PORTUGUESE_PATHS = ['/contato', '/sobre', '/equipe', '/empresa', '/contact', '/about'] as const;
const DUTCH_PATHS = ['/contact', '/over-ons', '/team', '/about'] as const;
const DEFAULT_PATHS = ['/about', '/team', '/leadership', '/contact', '/imprint', '/impressum'] as const;

const PATHS_BY_ISO2: Readonly<Record<string, readonly string[]>> = Object.freeze({
  DE: GERMAN_PATHS,
  AT: GERMAN_PATHS,
  CH: GERMAN_PATHS,
  IT: ITALIAN_PATHS,
  ES: SPANISH_PATHS,
  MX: SPANISH_PATHS,
  CO: SPANISH_PATHS,
  CL: SPANISH_PATHS,
  AR: SPANISH_PATHS,
  FR: FRENCH_PATHS,
  BE: FRENCH_PATHS,
  PT: PORTUGUESE_PATHS,
  BR: PORTUGUESE_PATHS,
  NL: DUTCH_PATHS,
});

/** 按公司国别或明确 ccTLD 选择固定探测路径（德语域保持原有 6 条德语路径，不破坏存量回归）。 */
export function fixedPathsForCompany(domain: string, country?: string | null): readonly string[] {
  const iso = (country ?? '').trim().toUpperCase() || inferCountryFromCcTld(domain) || '';
  return PATHS_BY_ISO2[iso] ?? DEFAULT_PATHS;
}

/** 同可注册域的裸域 ⇄ www. 互切。 */
export function toggleWwwHost(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : `www.${lower}`;
}

export function stripHtmlToVisibleText(html: string): string {
  return stripHtml(html).trim();
}

export function httpFirstMinChars(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt((env.HTTP_FIRST_MIN_CHARS ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 5000 ? parsed : 300;
}

export type GuessedPageProbeResult =
  | { kind: 'text'; text: string }
  | { kind: 'skip_not_found' }
  | { kind: 'fallback_browser' };

/**
 * 从 `/sitemap.xml` 提取同站人物页 URL（线性扫描 `<loc>...</loc>`，免回溯正则），
 * 按人物页优先级排序返回最多 4 条真实站点路径，避免在 JS 导航站点上盲猜 404。
 */
export function extractPeopleUrlsFromSitemapXml(
  xml: string,
  host: string,
  scoreUrl: (url: string) => number,
): Array<{ url: string; w: number }> {
  const normalizedRoot = host.trim().toLowerCase().replace(/^www\./u, '');
  if (!normalizedRoot || !xml) return [];
  const bounded = xml.slice(0, 500_000);
  const lower = bounded.toLowerCase();
  const seen = new Set<string>();
  const matches: Array<{ url: string; w: number }> = [];
  let cursor = 0;
  while (cursor < bounded.length) {
    const start = lower.indexOf('<loc>', cursor);
    if (start === -1) break;
    const end = lower.indexOf('</loc>', start + 5);
    if (end === -1) break;
    cursor = end + 6;
    const raw = bounded.slice(start + 5, end).trim();
    if (!raw || raw.length > 512) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      const candidateRoot = parsed.hostname.toLowerCase().replace(/^www\./u, '');
      if (candidateRoot !== normalizedRoot) continue;
      parsed.search = '';
      parsed.hash = '';
      const cleanUrl = parsed.toString();
      const w = scoreUrl(cleanUrl);
      if (w <= 0) continue;
      const dedupeKey = cleanUrl.toLowerCase().replace(/^https?:\/\/(www\.)?/u, '').replace(/\/$/u, '');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      matches.push({ url: cleanUrl, w });
    } catch {
      /* ignore malformed <loc> */
    }
  }
  matches.sort((a, b) => b.w - a.w);
  return matches.slice(0, 4);
}

/** 轻量读取 `/sitemap.xml` 补齐真实人物页路径（404/非 XML 时静默返回空数组）。 */
export async function probeSitemapPeopleUrls(
  broker: ExecutionBroker,
  host: string,
  toolCtx: ToolContext,
  scoreUrl: (url: string) => number,
): Promise<Array<{ url: string; w: number }>> {
  try {
    const res = await broker.invoke<
      { url: string },
      { status?: number; ok?: boolean; text?: string }
    >('http.get', { url: `https://${host}/sitemap.xml` }, toolCtx);
    const status = res.data?.status ?? 0;
    if (status < 200 || status >= 300 || !res.data?.text) return [];
    return extractPeopleUrlsFromSitemapXml(res.data.text, host, scoreUrl);
  } catch (err) {
    if (isExecutionControlError(err)) throw err;
    return [];
  }
}

/**
 * 对固定路径盲猜页先走轻量 `http.get`：
 *  - HTTP 400/404/410 明确不存在 → 直接跳过，绝不送进无头浏览器空耗数十秒；
 *  - HTTP 200 且剥离 HTML 后正文 ≥ HTTP_FIRST_MIN_CHARS → 直接使用，免开浏览器；
 *  - 薄 JS 壳 / 403 / 其余情况 → 回退 `crawl4ai.fetch`。
 */
export async function probeGuessedPeoplePageHttpFirst(
  broker: ExecutionBroker,
  url: string,
  toolCtx: ToolContext,
): Promise<GuessedPageProbeResult> {
  try {
    const res = await broker.invoke<
      { url: string },
      { status?: number; ok?: boolean; text?: string }
    >('http.get', { url }, toolCtx);
    const status = res.data?.status ?? 0;
    if (status === 400 || status === 404 || status === 410) {
      return { kind: 'skip_not_found' };
    }
    if (status >= 200 && status < 300) {
      const visible = stripHtmlToVisibleText((res.data?.text ?? '').slice(0, 300_000));
      if (visible.length >= httpFirstMinChars()) {
        return { kind: 'text', text: visible.slice(0, 30_000) };
      }
    }
    return { kind: 'fallback_browser' };
  } catch (err) {
    if (isExecutionControlError(err)) throw err;
    return { kind: 'fallback_browser' };
  }
}
