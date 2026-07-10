/**
 * 数字足迹富集 · 真实数据验证。对几个真实制造业公司官网跑 DigitalFootprintProvider，
 * 打印抽到的🟢信号（技术栈/在投广告/服务市场/招聘/邮件商/结构化事实）。
 *   node --import tsx scripts/verify-digital-footprint.mts [domain ...]
 */
import { readFileSync } from 'node:fs';
import { DigitalFootprintProvider } from '../src/discovery/providers/digital-footprint.provider';
import { PLATFORM_WORKSPACE } from '../src/discovery/provider-contract';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const domains = process.argv.slice(2);
const targets = domains.length ? domains : ['trumpf.com', 'bystronic.com', 'protolabs.com'];
// 收口②：原始出网统一经 ToolBroker（source_policy 读取需 postgres 在跑）
const prisma = new PrismaService();
await prisma.$connect();
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
const provider = new DigitalFootprintProvider({ broker });

for (const domain of targets) {
  console.log(`\n═══ ${domain} ═══`);
  const t0 = Date.now();
  try {
    const r = await provider.enrichCompany({ name: domain, domain }, { workspaceId: PLATFORM_WORKSPACE });
    console.log(`matched=${r.matched} conf=${r.confidence} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (r.matched) {
      const a = r.attributes as Record<string, unknown>;
      console.log('  技术栈平台  :', a.tech_platform ?? '—');
      console.log('  在投广告像素:', a.ad_pixels ?? '—', a.is_advertiser ? '  ★活跃投放' : '');
      console.log('  服务国家    :', a.served_markets ?? '—');
      console.log('  服务语言    :', a.served_langs ?? '—');
      console.log('  招聘信号    :', a.hiring_signal ? JSON.stringify(a.hiring_signal) : '—');
      console.log('  邮件商      :', a.email_provider ?? '—');
      console.log('  结构化事实  :', a.structured_org ? JSON.stringify(a.structured_org) : '—');
      console.log('  结构化产品  :', a.structured_products ?? '—');
    }
  } catch (err) {
    console.log('  ERROR:', String(err).slice(0, 160));
  }
}
await prisma.$disconnect();
