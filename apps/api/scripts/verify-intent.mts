/**
 * 网站变更 = intent 引擎 · 真实数据验证（无 sandbox，§5 硬规矩）。
 * 对真实公司页抓渲染后 HTML → 抽意图信号（招聘/上新/供应商招募/新闻）→ 打印；
 * 再对其中一页**模拟一次快照变化**（注入新产品 + 新招募词）→ diffPageSignals → 打印产出的 intent 事件，
 * 端到端证明「一次网站变更 → 一条可喂评分的 intent 信号」。
 *   node --import tsx scripts/verify-intent.mts [url ...]
 * 需本地 crawl4ai（:11235，token 在 .env）在跑。
 */
import { readFileSync } from 'node:fs';
import { Crawl4aiPageFetcher } from '../src/intent/page-fetcher';
import { classifyPageKind, extractPageSignals, signalHash, diffPageSignals, PageSignals } from '../src/intent/page-signals';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

// 默认目标：经真实探测（scout）确认可抽取信号的页。可用 argv 覆盖。
const DEFAULT_URLS = [
  'https://www.trumpf.com/en_US/company/principles/suppliers/', // sourcing：Register/Onboarding/Supplier portal + JAGGAER
  'https://www.trumpf.com/en_INT/products/', // products：全 server-rendered，产品名在锚点 URL/slug（无 Product JSON-LD）
  'https://www.trumpf.com/en_INT/newsroom/global-press-releases/', // news：dated 列表 + release 详情链接
  'https://flex.com/solutions-and-services/supply-chain/supplier-information', // sourcing：become suppliers to Flex
];

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
const fetcher = new Crawl4aiPageFetcher();

const snapshots: { url: string; signals: PageSignals }[] = [];
for (const url of urls) {
  const kind = classifyPageKind(url);
  console.log(`\n═══ [${kind}] ${url} ═══`);
  const t0 = Date.now();
  const page = await fetcher.fetch(url).catch((e) => {
    console.log('  fetch ERROR:', String(e).slice(0, 140));
    return null;
  });
  if (!page) {
    console.log('  miss（robots 禁 / 抓取失败 / 空内容）');
    continue;
  }
  const s = extractPageSignals(page.html, kind, url); // baseUrl 用于解析相对产品/新闻链接（同引擎路径）
  snapshots.push({ url, signals: s });
  console.log(`  抓取 ${(page.html.length / 1024).toFixed(0)}KB (${((Date.now() - t0) / 1000).toFixed(1)}s)  signalHash=${signalHash(s).slice(0, 12)}`);
  console.log('  招聘信号   :', s.hiring ? JSON.stringify(s.hiring) : '—');
  console.log('  上新产品(JSON-LD):', s.products ? s.products.slice(0, 6) : '—');
  console.log('  产品链接   :', s.product_links ? `${s.product_links.length} 条: ${s.product_links.slice(0, 4).join(' , ')}` : '—');
  console.log('  供应商招募 :', s.sourcing ? s.sourcing.terms : '—');
  console.log('  新闻条目   :', s.news ? `${s.news.items.length} 条: ${s.news.items.slice(0, 3).join(' / ')}` : '—');
  console.log('  正文指纹   :', s.textDigest ? s.textDigest.slice(0, 12) : '—');
}

// ── 端到端 diff 演示：对第一页模拟一次「网站变更」→ 产出 intent 事件 ──
if (snapshots.length) {
  const { url, signals: prev } = snapshots[0];
  const next: PageSignals = {
    ...prev,
    products: [...(prev.products ?? []), 'SIMULATED New Fiber Laser 9000'],
    sourcing: { terms: [...new Set([...(prev.sourcing?.terms ?? []), 'become_a_supplier'])] },
    hiring: prev.hiring
      ? { ...prev.hiring, open_roles: prev.hiring.open_roles + 2, titles: [...prev.hiring.titles, 'Procurement Manager'], has_buying_role: true }
      : { open_roles: 2, titles: ['Procurement Manager'], has_buying_role: true },
    textDigest: (prev.textDigest ?? 'x') + 'changed',
  };
  console.log(`\n═══ diff 演示（模拟 ${url} 一次变更）═══`);
  console.log(`  hash 变化: ${signalHash(prev).slice(0, 12)} → ${signalHash(next).slice(0, 12)}`);
  const deltas = diffPageSignals(prev, next);
  console.log(`  产出 ${deltas.length} 条 intent 事件：`);
  for (const d of deltas) {
    console.log(`   • ${d.changeType} (strength=${d.strength})  ${JSON.stringify(d.evidence).slice(0, 160)}`);
  }
}
console.log('\n完成。');
