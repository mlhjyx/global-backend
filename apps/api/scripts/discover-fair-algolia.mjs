#!/usr/bin/env node
/**
 * 展会 Algolia 配置发现器 —— 给一个 RX/Algolia 系展会的参展商目录 URL，用 Crawl4AI
 * 渲染 JS 并抓取网络请求，从 *.algolianet.com / *.algolia.net 调用里提取
 * appId / apiKey / indexName / eventEditionId，打印可粘进 trade-fairs.ts 的模板片段。
 *
 * 用途：新增展会 或 换届刷新（apiKey/eventEditionId 按届变化）。
 *
 *   CRAWLER_URL=http://localhost:11235 CRAWLER_TOKEN=xxx \
 *     node scripts/discover-fair-algolia.mjs "https://www.euroblech.com/en-gb/exhibitor-directory.html"
 */
import { readFileSync } from 'node:fs';

// 载入 apps/api/.env（若存在）取 CRAWLER_URL/TOKEN
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* .env 可选 */
}

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/discover-fair-algolia.mjs <exhibitor-directory-url>');
  process.exit(1);
}
const CB = process.env.CRAWLER_URL ?? 'http://localhost:11235';
const TOK = process.env.CRAWLER_TOKEN ?? '';

const res = await fetch(`${CB}/crawl`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
  body: JSON.stringify({
    urls: [url],
    browser_config: { type: 'BrowserConfig', params: { headless: true } },
    crawler_config: {
      type: 'CrawlerRunConfig',
      params: { delay_before_return_html: 8.0, page_timeout: 50000, cache_mode: 'BYPASS', capture_network_requests: true },
    },
  }),
  signal: AbortSignal.timeout(120000),
});
if (!res.ok) {
  console.error(`crawl4ai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const data = await res.json();
const result = Array.isArray(data.results) ? data.results[0] : data;
const net = result.network_requests ?? [];

let found = null;
for (const r of net) {
  const u = r.url ?? '';
  if (r.event_type === 'request' && /algolia(net)?\.(com|net)\/1\/indexes\//.test(u)) {
    const appId = (u.match(/x-algolia-application-id=([A-Za-z0-9]+)/) || [])[1];
    const apiKey = (u.match(/x-algolia-api-key=([a-f0-9]+)/) || [])[1];
    const indexName = decodeURIComponent((u.match(/\/indexes\/([^/]+)\/query/) || [])[1] || '');
    const body = r.post_data ?? '';
    const eventEditionId = (decodeURIComponent(body).match(/eventEditionId:(eve-[a-f0-9-]+)/) || [])[1];
    const locale = (decodeURIComponent(body).match(/locale:([a-z-]+)/) || [])[1] || 'en-gb';
    if (appId && apiKey && indexName) {
      found = { appId, apiKey, indexName, eventEditionId, locale };
      break;
    }
  }
}

if (!found) {
  console.error(`未在 ${net.length} 个网络请求里找到 Algolia 调用。可能该展会不是 RX/Algolia 平台，`);
  console.error('或需要更长 delay_before_return_html / 触发搜索交互。');
  const hosts = [...new Set(net.map((r) => { try { return new URL(r.url).host; } catch { return null; } }).filter(Boolean))]
    .filter((h) => /api|search|exhibitor|algolia|elastic|swapcard|expo/i.test(h));
  console.error('候选数据主机:', hosts.slice(0, 12).join(', '));
  process.exit(2);
}

console.log('// 粘进 apps/api/src/discovery/trade-fairs.ts 的 TRADE_FAIRS：');
console.log(JSON.stringify(
  {
    slug: 'CHANGE-ME-slug-year',
    name: 'CHANGE-ME Fair Name (edition/year)',
    platform: 'rx_algolia',
    exhibitorUrl: url,
    algolia: found,
    topics: ['CHANGE-ME', 'add', 'industry', 'topics'],
    region: 'CHANGE-ME',
  },
  null,
  2,
));
