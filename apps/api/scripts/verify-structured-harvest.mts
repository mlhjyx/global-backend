/**
 * 结构化收割 · 真实数据验证。对真实制造业官网跑 StructuredHarvestProvider，
 * 打印 sitemap 盘点 + careers 页 + JobPosting 招聘信号（含采购岗判定）。
 *   node --import tsx scripts/verify-structured-harvest.mts [domain ...]
 */
import { readFileSync } from 'node:fs';
import { StructuredHarvestProvider } from '../src/discovery/providers/structured-harvest.provider';
import { PLATFORM_WORKSPACE } from '../src/discovery/provider-contract';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['trumpf.com', 'bystronic.com', 'protolabs.com'];
// 收口②：原始出网统一经 ToolBroker（source_policy 读取需 postgres 在跑）
const prisma = new PrismaService();
await prisma.$connect();
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
const provider = new StructuredHarvestProvider({ broker });

for (const domain of targets) {
  console.log(`\n═══ ${domain} ═══`);
  const t0 = Date.now();
  try {
    const r = await provider.enrichCompany({ name: domain, domain }, { workspaceId: PLATFORM_WORKSPACE });
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
await prisma.$disconnect();
