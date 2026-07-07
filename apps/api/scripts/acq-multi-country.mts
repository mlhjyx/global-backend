/**
 * 多国采集验证（真实数据）：证明采集层不锁德国。
 * 把一个**非德国**展会（INTERPHEX 2026 · 纽约 · 制药/生物制造）种为 MonitoredSource，
 * 跑 AcquisitionService.acquire（抓取→清洗→落库→增量），打印真实的国家/行业分布。
 * 现有 TradeFairSourceAdapter 一行代码不改——只换 Algolia index/edition。
 *
 *   node --import tsx scripts/acq-multi-country.mts
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { AcquisitionService } from '../src/acquisition/acquisition.service';
import { SourceAdapterRegistry } from '../src/acquisition/source-adapter';
import { TradeFairSourceAdapter } from '../src/acquisition/adapters/trade-fair.source';

// 手动载入 .env（DATABASE_URL 用 owner 连接，平台级表无 RLS）
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';

const prisma = new PrismaClient();
const registry = new SourceAdapterRegistry().register(new TradeFairSourceAdapter());
const svc = new AcquisitionService({ prisma: prisma as any, registry });

const INTERPHEX = {
  sourceKey: 'interphex-2026',
  label: 'INTERPHEX 2026 (NYC) — Pharmaceutical & Biotech Manufacturing',
  region: 'North America',
  sectorTags: ['pharmaceutical', 'biotech', 'life sciences manufacturing', 'aseptic processing'],
  seriesKey: 'interphex',
  config: {
    fairSlug: 'interphex-2026',
    algolia: {
      appId: 'XD0U5M6Y4R',
      apiKey: 'd5cd7d4ec26134ff4a34d736a7f9ad47',
      indexName: 'evt-e00ae0db-ed1e-4a16-a406-5144035f9376-index',
      eventEditionId: 'eve-4247addc-b843-4b9e-adcf-2acb2d6c56a0',
      locale: 'en-us',
    },
  },
};

const src = await prisma.monitoredSource.upsert({
  where: { sourceKey: INTERPHEX.sourceKey },
  create: {
    providerKey: 'trade_fair',
    sourceKey: INTERPHEX.sourceKey,
    label: INTERPHEX.label,
    region: INTERPHEX.region,
    sectorTags: INTERPHEX.sectorTags,
    seriesKey: INTERPHEX.seriesKey,
    status: 'ACTIVE',
    config: INTERPHEX.config,
  },
  update: { status: 'ACTIVE', config: INTERPHEX.config, region: INTERPHEX.region, sectorTags: INTERPHEX.sectorTags },
});
console.log(`源已种: ${src.label}\n  region=${src.region} sectors=${JSON.stringify(src.sectorTags)}\n`);

console.time('acquire');
const r = await svc.acquire(src.id);
console.timeEnd('acquire');
console.log('acquire 结果:', r, '\n');

// ── 落库后真实分布 ──
const ents = await prisma.sourceEntity.findMany({
  where: { sourceId: src.id, withdrawnAt: null },
  select: { name: true, domain: true, country: true, cleaned: true, firstSeenAt: true },
});
const byCountry = new Map<string, number>();
let withEmail = 0, roleEmail = 0, personalEmail = 0, withPhone = 0, withDomain = 0, withProducts = 0;
for (const e of ents) {
  byCountry.set(e.country ?? '(未知)', (byCountry.get(e.country ?? '(未知)') ?? 0) + 1);
  const c = (e.cleaned ?? {}) as Record<string, unknown>;
  if (c.email) { withEmail++; c.email_kind === 'personal' ? personalEmail++ : roleEmail++; }
  if (c.phone) withPhone++;
  if (e.domain) withDomain++;
  if (Array.isArray(c.products) && c.products.length) withProducts++;
}
const topCountries = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

console.log(`═══ INTERPHEX（美国·制药）真实落库 ═══`);
console.log(`实体总数        : ${ents.length}`);
console.log(`有官网域名      : ${withDomain}`);
console.log(`有邮箱          : ${withEmail}（职能 ${roleEmail} / 人名 ${personalEmail}🔴GDPR）`);
console.log(`有电话          : ${withPhone}`);
console.log(`有产品标签      : ${withProducts}`);
console.log(`\n参展商来源国 Top12（证明跨国，非只美国本土）:`);
for (const [country, n] of topCountries) console.log(`  ${String(n).padStart(4)}  ${country}`);
console.log(`\n样本 8 家:`);
for (const e of ents.slice(0, 8)) console.log(`  · ${e.name}  [${e.country ?? '?'}]  ${e.domain ?? '—'}`);

// ── 对比：全库有几个源、各是哪国 ──
const allSources = await prisma.monitoredSource.findMany({ select: { sourceKey: true, region: true, sectorTags: true, status: true } });
console.log(`\n═══ 当前 monitored_source 全部源 ═══`);
for (const s of allSources) console.log(`  ${s.status.padEnd(8)} ${s.sourceKey.padEnd(20)} region=${s.region ?? '?'}  sectors=${JSON.stringify(s.sectorTags)}`);

await prisma.$disconnect();
