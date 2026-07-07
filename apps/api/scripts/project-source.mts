/**
 * 把平台级采集源投影进某租户的 canonical_company（走 RLS + 身份去重 + 合规隔离）。
 *   node --import tsx scripts/project-source.mts <workspaceId> <sourceKey> [sourceKey2 ...]
 * 例：node --import tsx scripts/project-source.mts 11111111-1111-4111-8111-111111111111 interphex-2026 eats-2025
 * 人名邮箱(personalData)不投，留在平台层隔离；职能邮箱随 attributes.contact_email 走。
 */
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { TenantProjectionService } from '../src/acquisition/tenant-projection.service';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}

const [workspaceId, ...sourceKeys] = process.argv.slice(2);
if (!workspaceId || !sourceKeys.length) {
  console.error('usage: project-source.mts <workspaceId> <sourceKey> [sourceKey2 ...]');
  process.exit(1);
}

const prisma = new PrismaService();
await prisma.$connect();
const svc = new TenantProjectionService({ prisma });

const sources = await prisma.monitoredSource.findMany({ where: { sourceKey: { in: sourceKeys } }, select: { id: true, sourceKey: true } });
const found = new Set(sources.map((s) => s.sourceKey));
for (const k of sourceKeys) if (!found.has(k)) console.error(`⚠ 未找到源 sourceKey=${k}`);

for (const s of sources) {
  const r = await svc.projectSource(workspaceId, s.id);
  console.log(`[${s.sourceKey}] ${r.status} projected=${r.projected} suppressed=${r.suppressed} 人名邮箱隔离未投=${r.personalContactsWithheld}${r.reason ? ` (${r.reason})` : ''}`);
}

await prisma.$disconnect();
