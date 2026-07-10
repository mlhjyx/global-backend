/**
 * 网站变更 intent 引擎 · ops 工具：注册监控 / 投影 intent 到租户 canonical。
 *   注册：node --import tsx scripts/intent-watch.mts register <workspaceId> <canonicalCompanyId> [url ...]
 *   投影：node --import tsx scripts/intent-watch.mts project  <workspaceId>
 * register 不给 url 时用域名推常见页（首页/产品/招聘/供应商/新闻）。抓取由独立 intentSweep 驱动。
 */
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { IntentProjectionService } from '../src/intent/intent-projection.service';
import { classifyPageKind } from '../src/intent/page-signals';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const [cmd, workspaceId, arg, ...rest] = process.argv.slice(2);
const prisma = new PrismaService();
await prisma.$connect();
const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
const svc = new IntentProjectionService({ prisma, broker });

if (cmd === 'register' && workspaceId && arg) {
  const pages = rest.length ? rest.map((url) => ({ url, kind: classifyPageKind(url) })) : undefined;
  const r = await svc.registerWatch(workspaceId, arg, pages ? { pages } : undefined);
  console.log(`${r.created ? '✓ 新建' : '· 已存在(合并页集)'} web_watch 源 ${r.sourceKey} — ${r.pages} 页；由 intentSweep 到期抓取。`);
} else if (cmd === 'project' && workspaceId) {
  const r = await svc.projectIntent(workspaceId);
  console.log(`投影完成：命中公司 ${r.companiesTouched} 家，写入 intent 事件 ${r.eventsProjected} 条 → attributes.intent.*`);
} else {
  console.error('usage:\n  intent-watch.mts register <workspaceId> <canonicalCompanyId> [url ...]\n  intent-watch.mts project  <workspaceId>');
  process.exit(1);
}

await prisma.$disconnect();
