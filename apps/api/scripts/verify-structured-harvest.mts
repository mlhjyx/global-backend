/**
 * 结构化收割 · 真实数据验证。对真实制造业官网跑 StructuredHarvestProvider，
 * 打印 sitemap 盘点 + careers 页 + JobPosting 招聘信号（含采购岗判定）。
 *   node --import tsx scripts/verify-structured-harvest.mts [domain ...]
 */
import { readFileSync } from 'node:fs';
import { StructuredHarvestProvider } from '../src/discovery/providers/structured-harvest.provider';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['trumpf.com', 'bystronic.com', 'protolabs.com'];
const provider = new StructuredHarvestProvider();

for (const domain of targets) {
  console.log(`\n═══ ${domain} ═══`);
  const t0 = Date.now();
  try {
    const r = await provider.enrichCompany({ name: domain, domain });
    console.log(`matched=${r.matched} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (r.matched) {
      const a = r.attributes as Record<string, unknown>;
      console.log('  sitemap URL 数:', a.sitemap_url_count ?? '—');
      console.log('  站点区块      :', a.site_sections ? JSON.stringify(a.site_sections) : '—');
      console.log('  careers 页    :', a.careers_url ?? '—');
      console.log('  招聘信号      :', a.hiring_signal ? JSON.stringify(a.hiring_signal) : '—（首页/JSON-LD 无 JobPosting）');
    }
  } catch (err) {
    console.log('  ERROR:', String(err).slice(0, 160));
  }
}
