#!/usr/bin/env node
/**
 * MapYourShow 数据接口发现器：给一个 MYS 参展商画廊 URL，用 crawl4ai 抓网络请求，
 * 打印所有指向 mapyourshow.com 的 XHR/fetch（ajax/cfm/json/api），含方法/post_data/响应片段，
 * 以便定位其无鉴权参展商 JSON 端点（内化到 MapYourShowSourceAdapter）。
 *   node scripts/discover-mys-api.mjs "https://<show>.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm"
 */
import { readFileSync } from 'node:fs';
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const url = process.argv[2];
if (!url) { console.error('usage: discover-mys-api.mjs <gallery-url>'); process.exit(1); }
const CB = process.env.CRAWLER_URL ?? 'http://localhost:11235';
const TOK = process.env.CRAWLER_TOKEN ?? '';

const res = await fetch(`${CB}/crawl`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
  body: JSON.stringify({
    urls: [url],
    browser_config: { type: 'BrowserConfig', params: { headless: true } },
    crawler_config: { type: 'CrawlerRunConfig', params: { delay_before_return_html: 9.0, page_timeout: 55000, cache_mode: 'BYPASS', capture_network_requests: true } },
  }),
  signal: AbortSignal.timeout(120000),
});
if (!res.ok) { console.error(`crawl4ai ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1); }
const data = await res.json();
const result = Array.isArray(data.results) ? data.results[0] : data;
const net = result.network_requests ?? [];

const hosts = new Map();
for (const r of net) { try { const h = new URL(r.url).host; hosts.set(h, (hosts.get(h) ?? 0) + 1); } catch {} }
console.log(`网络请求 ${net.length} 条，主机:`, [...hosts.entries()].map(([h, n]) => `${h}(${n})`).join(', '), '\n');

const seen = new Set();
for (const r of net) {
  const u = r.url ?? '';
  if (!/mapyourshow\.com/.test(u)) continue;
  if (!/\.(cfm|json|asp|aspx)(\?|$)|\/ajax\/|\/api\/|remote-proxy|search|exhibitor|result/i.test(u)) continue;
  if (r.event_type !== 'request') continue;
  const key = u.split('?')[0] + (r.post_data ? '#POST' : '');
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`▶ ${r.method ?? 'GET'} ${u.slice(0, 200)}`);
  if (r.post_data) console.log(`   post_data: ${String(r.post_data).slice(0, 240)}`);
}
console.log('\n(若无命中，参展商可能是首屏 SSR 或另一交互触发；看上面主机清单人工判断)');
