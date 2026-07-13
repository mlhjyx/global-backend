/**
 * Codex PR #93 复审 7 findings 真库回归（无 sandbox，CLAUDE.md §5）——**零 BigQuery 成本**：
 * 注入确定性 mock scanner 到 refreshPatentCache（实现 searchInventorsForAnchorsWithStats），
 * 证明 DB 层修复（真 prisma client + 真 grants + 真 dataProvider kill-switch + 真墓碑 upsert/skip），BQ 一次不打。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-patent-cache-codex-p93.mts
 *
 * 五段（合成隔离数据，norm 前缀 codex*，不碰真 Siemens 缓存）：
 *   A · P1-1 kill-switch：provider DISABLED → refreshPatentCache status=DISABLED，mock scanner **未被调用**、零落库。
 *   B · P2-5 墓碑 GRANT+skip：app_user 写 patent_inventor_tombstone（证 INSERT grant）→ 刷新时被擦除人（墓碑命中）不重物化，同 assignee 其余照落。
 *   C · P1-2 过滤 + P2-6 cap：宽锚溜进的无关 assignee 不落 + 每 (norm,country) cap 到 25（真库唯一键+批量 upsert）。
 *   D · P2-3 TTL 夹顶：PATENT_CACHE_TTL_DAYS=365 → 缓存行 expiresAt ≈ now+180d（真库落值核）。
 *   E · P2-4 未扫：mock scanner scanned:false → status=SKIPPED_NOSCAN，队列留 PENDING（真库队列态核）。
 *
 * ⚠️ 必须以 app_user（非 superuser）跑 tombstone GRANT 段，否则证明无意义（开头硬 guard）。
 * 🔴 全程不改 google_patents seed 的**持久**态（末尾复位 DISABLED）、不启用功能（PATENT_SOURCE_MODE 不设）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import {
  refreshPatentCache,
  enqueuePatentLookup,
  inventorBlindKey,
  inventorErasureKeys,
  PATENT_PROVIDER_KEY,
  PATENT_POLICY_DOMAIN,
  type PatentRefreshDb,
  type PatentRefreshScanner,
} from '../src/adapters/patent-inventor-cache';
import { MAX_INVENTORS_PER_ASSIGNEE, type RefreshScanResult } from '../src/adapters/bigquery-patents';
import { decryptPii } from '../src/compliance/pii-crypto';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'ddddcccc-0000-4000-8000-0000000e0093'; // 测试 workspace（tombstone 无 RLS，仅令 withWorkspace 有合法 UUID）
const ERASED_FULLNAME = 'Anna Müller'; // 被擦除人可读名（如 contact.fullName）——umlaut，测跨拼写盲键收敛

let failed = 0;
const ok = (cond: boolean, msg: string): void => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

/** 确定性 mock scanner：记录是否被调用；返回固定行 + scanned 标（零 BQ）。 */
function mockScanner(rows: RefreshScanResult['rows'], scanned = true): PatentRefreshScanner & { calls: number } {
  const s = {
    calls: 0,
    searchInventorsForAnchorsWithStats: async (): Promise<RefreshScanResult> => {
      s.calls += 1;
      return { rows, bytesScanned: scanned ? 123 : null, scanned };
    },
  };
  return s;
}

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();

const su = await prisma.$queryRaw<{ is_superuser: string; usr: string }[]>`
  SELECT current_setting('is_superuser') AS is_superuser, current_user AS usr`;
console.log(`app 连接：user=${su[0].usr} is_superuser=${su[0].is_superuser}`);
if (su[0].is_superuser !== 'off') {
  console.error('❌ app 连接是 superuser → tombstone GRANT 证明无意义。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}

async function setProvider(status: 'ENABLED' | 'DISABLED'): Promise<void> {
  await ownerDb.dataProvider.update({ where: { key: PATENT_PROVIDER_KEY }, data: { status } });
}
async function cleanup(): Promise<void> {
  await ownerDb.patentInventorCache.deleteMany({ where: { assigneeNorm: { startsWith: 'codex' } } });
  await ownerDb.patentLookupRequest.deleteMany({ where: { assigneeNorm: { startsWith: 'codex' } } });
  await ownerDb.patentInventorTombstone.deleteMany({ where: { inventorNameKey: { in: inventorErasureKeys(ERASED_FULLNAME) } } });
  await ownerDb.patentCacheRefreshAudit.deleteMany({ where: { detail: { contains: 'codex' } } });
}

async function main() {
  console.log('\n█ Codex PR #93 复审 7 findings · 真库回归（零 BQ，mock scanner）\n');
  await new DiscoveryProviderRegistry().seed(ownerDb); // google_patents(DISABLED) + bigquery source_policy
  await ownerDb.sourcePolicy.update({
    where: { domain: PATENT_POLICY_DOMAIN },
    data: { reviewStatus: 'APPROVED', allowedPurpose: ['discovery', 'enrichment'] },
  });
  await cleanup();
  const db = ownerDb as unknown as PatentRefreshDb;

  // ══════════ A · P1-1 kill-switch：DISABLED → 不扫、不物化 ══════════
  console.log('\n══ A · P1-1 kill-switch（provider DISABLED）══');
  await setProvider('DISABLED');
  await enqueuePatentLookup(ownerDb, { companyName: 'Codexkill GmbH', country: 'DE' });
  const scanA = mockScanner([{ assigneeName: 'Codexkill GmbH', assigneeCountry: 'de', inventorName: 'SHOULD, NOTLAND' }]);
  const rA = await refreshPatentCache({ db, bq: scanA });
  ok(rA.status === 'DISABLED', `A：status=DISABLED（实得 ${rA.status}）`);
  ok(scanA.calls === 0, `A：mock scanner 未被调用（BQ 零打，calls=${scanA.calls}）`);
  const aRows = await ownerDb.patentInventorCache.count({ where: { assigneeNorm: 'codexkill' } });
  ok(aRows === 0, `A：零落库（cache rows=${aRows}）`);
  const aQueue = await ownerDb.patentLookupRequest.findFirst({ where: { assigneeNorm: 'codexkill' } });
  ok(aQueue?.status === 'PENDING', `A：队列留 PENDING（实得 ${aQueue?.status}）`);

  // 之后各段需 provider ENABLED（模拟已签 LIA/DPIA 的生产态；末尾复位 DISABLED）
  await setProvider('ENABLED');

  // ══════════ B · P2-5 墓碑（eraseSubject 同款写 + 跨拼写 skip）══════════
  console.log('\n══ B · P2-5 Art.17 墓碑（eraseSubject 同款 app_user createMany + 跨拼写刷新跳过）══');
  // 🔴 复刻 eraseSubject 的**确切**写墓碑调用：app_user withWorkspace 事务 + createMany(inventorErasureKeys(fullName)) +
  //   skipDuplicates——证 patent_inventor_tombstone 的 INSERT grant + no-RLS 平台表在 withWorkspace 事务内 createMany 可行（复审 Q5）。
  const erasureKeys = inventorErasureKeys(ERASED_FULLNAME); // = eraseSubject 的 erasureKeys 派生（over-suppress 变体集）
  await prisma.withWorkspace(WS, (tx) =>
    tx.patentInventorTombstone.createMany({ data: erasureKeys.map((inventorNameKey) => ({ inventorNameKey })), skipDuplicates: true }),
  );
  const tombCount = await ownerDb.patentInventorTombstone.count({ where: { inventorNameKey: { in: erasureKeys } } });
  ok(tombCount === erasureKeys.length && tombCount > 0, `B：app_user withWorkspace createMany 写 ${tombCount}/${erasureKeys.length} 墓碑（INSERT grant + no-RLS tx 生效）`);
  await enqueuePatentLookup(ownerDb, { companyName: 'Codextomb GmbH', country: 'DE' });
  // 🔴 扫描行用**不同拼写**（surname-comma + umlaut 展开 "MUELLER, ANNA"）——证跨格式盲键收敛：inventorErasureKeys('Anna Müller') ∋ inventorBlindKey('MUELLER, ANNA')。
  const scanB = mockScanner([
    { assigneeName: 'Codextomb GmbH', assigneeCountry: 'de', inventorName: 'MUELLER, ANNA' }, // 被擦除（异拼写）→ 跳过
    { assigneeName: 'Codextomb GmbH', assigneeCountry: 'de', inventorName: 'SCHMIDT, HANS' }, // 正常 → 落
  ]);
  const rB = await refreshPatentCache({ db, bq: scanB });
  ok(rB.status === 'OK' && rB.rowCount === 1, `B：status=OK rowCount=1（实得 ${rB.status}/${rB.rowCount}）`);
  const bRows = await ownerDb.patentInventorCache.findMany({ where: { assigneeNorm: 'codextomb' } });
  const bNames = bRows.map((r) => decryptPii(r.inventorName)).sort();
  ok(bNames.length === 1 && bNames[0] === 'SCHMIDT, HANS', `B：只 SCHMIDT 落库，被擦除人（跨拼写 MUELLER,ANNA）不重物化（实得 ${JSON.stringify(bNames)}）`);
  ok(!bRows.some((r) => r.inventorNameKey === inventorBlindKey('MUELLER, ANNA')), 'B：无被擦除盲键落库（跨格式命中墓碑）');

  // ══════════ C · P1-2 过滤 + P2-6 cap ══════════
  console.log('\n══ C · P1-2 无关 assignee 过滤 + P2-6 每 assignee cap 25 ══');
  await enqueuePatentLookup(ownerDb, { companyName: 'Codexfilter GmbH', country: 'DE' });
  const many = Array.from({ length: MAX_INVENTORS_PER_ASSIGNEE + 8 }, (_, i) => ({
    assigneeName: 'Codexfilter GmbH',
    assigneeCountry: 'de',
    inventorName: `CX, NR${String(i).padStart(3, '0')}`,
  }));
  const scanC = mockScanner([
    ...many,
    { assigneeName: 'Codexunrelated Ltd', assigneeCountry: 'de', inventorName: 'OFF, TARGET' }, // 未排队 → 过滤
  ]);
  const rC = await refreshPatentCache({ db, bq: scanC });
  ok(rC.status === 'OK', `C：status=OK（实得 ${rC.status}）`);
  const cFilter = await ownerDb.patentInventorCache.count({ where: { assigneeNorm: 'codexfilter' } });
  const cUnrelated = await ownerDb.patentInventorCache.count({ where: { assigneeNorm: 'codexunrelated' } });
  ok(cFilter === MAX_INVENTORS_PER_ASSIGNEE, `C：codexfilter cap 到 ${MAX_INVENTORS_PER_ASSIGNEE}（实得 ${cFilter}）`);
  ok(cUnrelated === 0, `C：无关 assignee codexunrelated 零落库（P1-2 过滤，实得 ${cUnrelated}）`);

  // ══════════ D · P2-3 TTL 夹到 180d ══════════
  console.log('\n══ D · P2-3 TTL 夹顶 180d（env=365）══');
  await enqueuePatentLookup(ownerDb, { companyName: 'Codexttl GmbH', country: 'DE' });
  process.env.PATENT_CACHE_TTL_DAYS = '365';
  const before = Date.now();
  const rD = await refreshPatentCache({ db, bq: mockScanner([{ assigneeName: 'Codexttl GmbH', assigneeCountry: 'de', inventorName: 'TTL, TEST' }]) });
  delete process.env.PATENT_CACHE_TTL_DAYS;
  const dRow = await ownerDb.patentInventorCache.findFirst({ where: { assigneeNorm: 'codexttl' } });
  ok(rD.status === 'OK' && !!dRow, `D：status=OK 且落库（实得 ${rD.status}）`);
  if (dRow) {
    const days = (dRow.expiresAt.getTime() - before) / 86400000;
    ok(days > 179 && days < 181, `D：expiresAt ≈ now+180d（夹顶，非 365d；实得 ${days.toFixed(1)}d）`);
  }

  // ══════════ E · P2-4 未扫 → SKIPPED_NOSCAN ══════════
  console.log('\n══ E · P2-4 BQ 未扫 → 队列留 PENDING ══');
  await enqueuePatentLookup(ownerDb, { companyName: 'Codexnoscan GmbH', country: 'DE' });
  const rE = await refreshPatentCache({ db, bq: mockScanner([], false) });
  ok(rE.status === 'SKIPPED_NOSCAN', `E：status=SKIPPED_NOSCAN（实得 ${rE.status}）`);
  const eQueue = await ownerDb.patentLookupRequest.findFirst({ where: { assigneeNorm: 'codexnoscan' } });
  ok(eQueue?.status === 'PENDING', `E：队列留 PENDING 不误标 EMPTY（实得 ${eQueue?.status}）`);

  // ── 复位 + 清理 ──
  await setProvider('DISABLED'); // 🔴 复位 seed 默认 DISABLED（不启用功能）
  await cleanup();
  const finalStatus = await ownerDb.dataProvider.findUnique({ where: { key: PATENT_PROVIDER_KEY }, select: { status: true } });
  ok(finalStatus?.status === 'DISABLED', `复位：google_patents 回 DISABLED（实得 ${finalStatus?.status}）`);

  console.log(`\n${failed === 0 ? '✅ 全绿' : `❌ ${failed} 处失败`}\n`);
}

try {
  await main();
} catch (e) {
  console.error('脚本异常：', e);
  failed = 99;
} finally {
  await prisma.$disconnect();
  await ownerDb.$disconnect();
}
process.exit(failed === 0 ? 0 : 1);
