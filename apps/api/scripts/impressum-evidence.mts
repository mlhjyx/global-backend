/**
 * A1 DoD 证据脚本（2026-11-08）：德语区真实样本的 Impressum 挖掘命中率。
 *
 * 口径（交接总纲 WP A1）：可达 Impressum 的 DE/AT 公司 ≥80% 产出 ≥1 个 role 邮箱 + ≥1 个电话。
 * 样本：dev 库 canonical_company 里 country=DE、有域名的公司（`md5(domain)` 排序 → 可复现抽样）。
 * 每次抓取前 robots 先检（与产品代码同一个 isAllowedByRobots）；抓取走 crawl4ai.render（原始 HTML）。
 * 抽取/装配直接复用产品代码（legalPageCandidates + collectCompanyChannels），命中率即产品行为。
 *
 * 运行（apps/api 下，.env 已链接）：
 *   pnpm exec tsx scripts/impressum-evidence.mts --limit=20
 * 输出：stdout 摘要 + docs/evidence/acquisition/impressum-miner-<date>.json（进 PR 作为证据）。
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { crawlHtml, crawlUrl } from '../src/adapters/web-crawler';
import { extractSameSiteLinks } from '../src/adapters/site-links';
import { isAllowedByRobots } from '../src/adapters/robots';
import { legalPageCandidates } from '../src/discovery/impressum/find-legal-pages';
import { collectCompanyChannels, type ImpressumPage } from '../src/discovery/impressum/collect-company-channels';
import { stripHtml } from '../src/discovery/impressum/impressum-extract';

const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 20);
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.split('=')[1]
  ?.split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
const authorize = async () => true;

function sameHostLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./u, '');
  const out = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"'#]+)["']/giu)) {
    try {
      const url = new URL(match[1]!, base);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.hostname.replace(/^www\./u, '') !== baseHost) continue;
      url.hash = '';
      url.search = '';
      out.add(url.toString());
    } catch {
      // 坏 href 跳过
    }
  }
  return [...out];
}

interface PageResult {
  url: string;
  kind: string;
  htmlBytes: number;
  textBytes: number;
  emails: string[];
  phones: string[];
}

interface DomainResult {
  name: string;
  domain: string;
  robotsAllowed: boolean;
  homeFetched: boolean;
  impressumReachable: boolean;
  roleEmails: string[];
  phones: string[];
  formUrls: string[];
  pagesTried: number;
  pages: PageResult[];
  error: string | null;
}

const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const allRows = await db.$queryRaw<{ name: string; domain: string }[]>`
  SELECT name, domain FROM canonical_company
  WHERE domain IS NOT NULL AND country = 'DE' AND domain NOT LIKE '%.example'
  ORDER BY md5(domain)
  LIMIT ${only ? 100_000 : limit * 5}`;
const seenDomains = new Set<string>();
const rows = allRows
  .filter((row) => {
    const domain = row.domain.replace(/^www\./u, '').toLowerCase();
    if (seenDomains.has(domain)) return false;
    seenDomains.add(domain);
    return only ? only.includes(domain) : true;
  })
  .slice(0, only ? only.length : limit);
// 🚨 部署窗口纪律：样本名录一次查询后**立即断开**，抓取阶段不持有任何数据库连接
//（switch-backend 的迁移要求运行时外零数据库连接；此前长连接曾阻塞发车窗口）。
await db.$disconnect();

const results: DomainResult[] = [];
for (const row of rows) {
  const domain = row.domain.replace(/^www\./u, '').toLowerCase();
  const base = `https://${domain}/`;
  const rec: DomainResult = {
    name: row.name,
    domain,
    robotsAllowed: false,
    homeFetched: false,
    impressumReachable: false,
    roleEmails: [],
    phones: [],
    formUrls: [],
    pagesTried: 0,
    pages: [],
    error: null,
  };
  try {
    rec.robotsAllowed = await isAllowedByRobots(base, { authorizeExternalAction: authorize });
    if (!rec.robotsAllowed) {
      results.push(rec);
      continue;
    }
    // 首页用渲染 HTML 取链接（href 解析）；渲染失败/文本过小（JS/同意墙）时用 markdown
    // 链接解析兜底（extractSameSiteLinks，产品 provider 对 markdown 用同款）。
    let homeLinks: string[] = [];
    try {
      const rendered = await crawlHtml(base, authorize);
      rec.homeFetched = true;
      homeLinks = sameHostLinks(rendered.html, base);
      if (stripHtml(rendered.html).trim().length < 300) {
        try {
          const md = await crawlUrl(base, authorize);
          homeLinks = [...new Set([...homeLinks, ...extractSameSiteLinks(md.text, base)])];
        } catch {
          // markdown 兜底失败可容忍
        }
      }
    } catch {
      try {
        const md = await crawlUrl(base, authorize);
        rec.homeFetched = true;
        homeLinks = extractSameSiteLinks(md.text, base);
      } catch (error) {
        rec.error = String(error).slice(0, 160);
        results.push(rec);
        continue;
      }
    }
    const candidates = legalPageCandidates(base, homeLinks, { maxPages: 5 });
    const pages: ImpressumPage[] = [];
    for (const candidate of candidates) {
      rec.pagesTried += 1;
      try {
        if (!(await isAllowedByRobots(candidate.url, { authorizeExternalAction: authorize }))) continue;
        let page: { html: string };
        try {
          page = await crawlHtml(candidate.url, authorize);
        } catch {
          // 渲染响应过大 → 用 markdown 端点（无 HTML 面，仍可跑文本抽取）。
          const md = await crawlUrl(candidate.url, authorize);
          page = { html: '' };
          const mdText = md.text.slice(0, 40_000);
          if (mdText.trim()) {
            pages.push({ url: candidate.url, kind: candidate.kind, text: mdText });
            const perPage = collectCompanyChannels({ domain, country: 'DE', pages: [{ url: candidate.url, kind: candidate.kind, text: mdText }] });
            rec.pages.push({ url: candidate.url, kind: candidate.kind, htmlBytes: 0, textBytes: mdText.length,
              emails: perPage.filter((c) => c.channel === 'email').map((c) => c.value),
              phones: perPage.filter((c) => c.channel === 'phone').map((c) => c.value) });
          }
          continue;
        }
        let text = stripHtml(page.html);
        let htmlForPage = page.html;
        let usedUrl = candidate.url;
        if (text.trim().length < 300) {
          try {
            const md = await crawlUrl(candidate.url, authorize);
            const mdText = md.text.slice(0, 40_000);
            if (mdText.length > text.length) text = mdText;
          } catch { /* markdown 回退失败可容忍 */ }
        }
        if (text.trim().length < 300) {
          const toggled = candidate.url.endsWith('/') ? candidate.url.replace(/\/+$/u, '') : `${candidate.url}/`;
          try {
            if (!(await isAllowedByRobots(toggled, { authorizeExternalAction: authorize }))) throw new Error('robots');
            const alt = await crawlHtml(toggled, authorize);
            const altText = stripHtml(alt.html);
            if (altText.length > text.length) {
              text = altText;
              htmlForPage = alt.html;
              usedUrl = toggled;
            }
          } catch { /* 尾斜杠回退失败可容忍 */ }
        }
        if (htmlForPage && text.trim()) {
          pages.push({ url: usedUrl, kind: candidate.kind, html: htmlForPage, text });
          const perPage = collectCompanyChannels({ domain, country: 'DE', pages: [{ url: usedUrl, kind: candidate.kind, html: htmlForPage, text }] });
          rec.pages.push({
            url: usedUrl,
            kind: candidate.kind,
            htmlBytes: page.html.length,
            textBytes: text.length,
            emails: perPage.filter((c) => c.channel === 'email').map((c) => c.value),
            phones: perPage.filter((c) => c.channel === 'phone').map((c) => c.value),
          });
        }
      } catch {
        // 单页失败可容忍
      }
    }
    rec.impressumReachable = pages.some((p) => p.kind === 'impressum' || p.kind === 'contact');
    const channels = collectCompanyChannels({ domain, country: 'DE', pages });
    rec.roleEmails = channels.filter((c) => c.channel === 'email').map((c) => c.value);
    rec.phones = channels.filter((c) => c.channel === 'phone').map((c) => c.value);
    rec.formUrls = channels.filter((c) => c.channel === 'form_url').map((c) => c.value);
  } catch (error) {
    rec.error = String(error).slice(0, 160);
  }
  results.push(rec);
  console.log(
    `${rec.domain}: home=${rec.homeFetched} impressum=${rec.impressumReachable} ` +
      `emails=${rec.roleEmails.length} phones=${rec.phones.length}${rec.error ? ` err=${rec.error}` : ''}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

const reachable = results.filter((r) => r.impressumReachable);
const both = reachable.filter((r) => r.roleEmails.length > 0 && r.phones.length > 0);
const summary = {
  generatedAt: new Date().toISOString(),
  criterion: 'reachable Impressum companies with >=1 role email AND >=1 phone (DoD >= 80%)',
  sampleSize: results.length,
  robotsDisallowed: results.filter((r) => !r.robotsAllowed).length,
  homeFetched: results.filter((r) => r.homeFetched).length,
  reachableImpressum: reachable.length,
  withRoleEmail: reachable.filter((r) => r.roleEmails.length > 0).length,
  withPhone: reachable.filter((r) => r.phones.length > 0).length,
  withRoleEmailAndPhone: both.length,
  hitRate: reachable.length ? Number((both.length / reachable.length).toFixed(4)) : 0,
};
console.log('\nSUMMARY ' + JSON.stringify(summary));

const date = summary.generatedAt.slice(0, 10);
const evidencePath = `../../docs/evidence/acquisition/impressum-miner-${date}.json`;
writeFileSync(
  evidencePath,
  JSON.stringify({ summary, results }, null, 2) + '\n',
  { mode: 0o644 },
);
console.log(`evidence written: ${evidencePath}`);
