/**
 * 待办3 · 专利发明人 **postgres scoped 缓存**（scale-safe #89）—— 真库真 BigQuery 端到端（无 sandbox，CLAUDE.md §5）。
 * 需 postgres 在跑；GOOGLE_PATENTS_SA_JSON + GOOGLE_PATENTS_PROJECT 在 .env。⚠️ 全脚本**只做 1 次真 BQ 扫描**（节制额度）。
 *
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-google-patents-cache.mts
 *
 * 七段证明（有界样本，全程 1 次 BQ 扫描）：
 *   A · Job User 跑一次刷新落 postgres（记 bytesScanned）——encryptPii 落盘 + 盲键 + CC BY license + assignee_country。
 *   B · cache 模式逐公司读=**零 BQ 字节**（纯 postgres）且发明人与刷新扫描源一致。
 *   C · DE/US 同名 T1 分流：注入合成 US 同名缓存行 → 读侧双键分组产两条各携己国别（不跨境并）。
 *   D · §8.8 SUSPENDED → 物化(refresh DENIED，不扫) + 直连回读(broker §8.8) 双停；cache 读按护栏⑧ 无 egress 不受此门。
 *   E · 幂等重跑：确定性密文 → 唯一键不产重复行；队列已 CACHED(nextRefresh 未到) → 二次刷新 SKIPPED_EMPTY（零再扫）。
 *   F · 空队列 → SKIPPED_EMPTY（零 BQ 成本），但保留期清理照跑。
 *   G · Art.17 擦除扫描面：按被擦除人盲键 deleteMany 命中删缓存行（真库盲键匹配）。
 *
 * ⚠️ 必须以 app_user（非 superuser）跑，否则证明无意义（开头硬 guard）。
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { GooglePatentsInventorProvider } from '../src/discovery/providers/bigquery-patents.provider';
import { bigqueryPatents } from '../src/adapters/bigquery-patents';
import {
  refreshPatentCache,
  readPatentCache,
  enqueuePatentLookup,
  inventorBlindKey,
  inventorErasureKeys,
  PATENT_CACHE_WINDOW_YEARS,
  type PatentRefreshDb,
} from '../src/adapters/patent-inventor-cache';
import { encryptPii, decryptPii } from '../src/compliance/pii-crypto';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const GP_DOMAIN = 'bigquery.googleapis.com';
const WS = 'ddddcccc-0000-4000-8000-0000000e0003';
const TARGET = { name: 'Siemens', domain: 'siemens.com', country: 'DE' };
const NORM = 'siemens'; // normForMatch('Siemens')

let failed = 0;
const ok = (cond: boolean, msg: string): void => {
  console.log(`   ${cond ? '✓' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const prisma = new PrismaService();
await prisma.$connect();
const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
await ownerDb.$connect();

const su = await prisma.$queryRaw<{ is_superuser: string; usr: string }[]>`
  SELECT current_setting('is_superuser') AS is_superuser, current_user AS usr`;
console.log(`app 连接：user=${su[0].usr} is_superuser=${su[0].is_superuser}`);
if (su[0].is_superuser !== 'off') {
  console.error('❌ app 连接是 superuser → 证明无意义。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}
if (!(process.env.GOOGLE_PATENTS_SA_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS) || !process.env.GOOGLE_PATENTS_PROJECT) {
  console.error('❌ GOOGLE_PATENTS_SA_JSON + GOOGLE_PATENTS_PROJECT 缺失（.env）——无 creds 无法真打 BigQuery。');
  process.exit(2);
}

const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });

async function cleanup(): Promise<void> {
  // '%SIEMENS%' 锚扫命中的 assignee 归一名很多（Siemens Energy/Healthineers…）→ 按 raw contains 清全（否则跨运行累积）。
  await ownerDb.patentInventorCache.deleteMany({ where: { assigneeNameRaw: { contains: 'Siemens', mode: 'insensitive' } } });
  await ownerDb.patentLookupRequest.deleteMany({ where: { assigneeNorm: NORM } });
}

async function main() {
  console.log('\n█ 待办3 · 专利发明人 postgres scoped 缓存（真库真 BigQuery）\n');
  await new DiscoveryProviderRegistry().seed(ownerDb); // google_patents data_provider + bigquery source_policy
  await ownerDb.sourcePolicy.update({ where: { domain: GP_DOMAIN }, data: { reviewStatus: 'APPROVED', allowedPurpose: ['discovery', 'enrichment'] } });
  await cleanup();

  // ══════════ A · 一次刷新落库（唯一 BQ 扫描）══════════
  console.log('\n══ A · Job User 一次刷新落 postgres（记 bytesScanned）══');
  await enqueuePatentLookup(ownerDb, { companyName: TARGET.name, country: TARGET.country });
  const refreshA = await refreshPatentCache({ db: ownerDb as unknown as PatentRefreshDb, bq: bigqueryPatents });
  console.log(`   status=${refreshA.status} rows=${refreshA.rowCount} cached=${refreshA.cached} bytesScanned=${refreshA.bytesScanned}`);
  ok(refreshA.status === 'OK', 'A：刷新 status=OK');
  ok(refreshA.rowCount > 0, `A：落 ${refreshA.rowCount} 行发明人`);
  // bytesScanned 经 job.getMetadata() 捕获（配额观测）。0=BQ 查询缓存命中（重复同查询）——生产新数据扫描报真实字节。
  ok(refreshA.bytesScanned != null, `A：bytesScanned 已捕获=${refreshA.bytesScanned}（0=BQ 查询缓存命中；生产新数据报真实字节）`);
  const rowsA = await ownerDb.patentInventorCache.findMany({ where: { assigneeNorm: NORM } });
  ok(rowsA.length > 0 && rowsA.every((r) => r.inventorName.startsWith('enc:v1:')), '🔴 inventorName 全列级加密落盘（enc:v1:）');
  ok(rowsA.every((r) => r.inventorNameKey.startsWith('bi:v1:')), '🔴 inventorNameKey 全盲索引（bi:v1:）');
  ok(rowsA.every((r) => r.license === 'CC-BY-4.0'), 'CC BY 4.0 license 派生溯源落盘');
  // '%SIEMENS%' 宽锚命中多国 assignee → 每行携己国别（护栏③进唯一键）；断言全为 alpha-2/'' 且含 de（provider 读时再精判）
  ok(rowsA.every((r) => /^[a-z]{2}$/.test(r.assigneeCountry) || r.assigneeCountry === '') && rowsA.some((r) => r.assigneeCountry === 'de'), 'assigneeCountry 全 alpha-2/""（护栏③ 进唯一键）且含 de');
  const serialized = JSON.stringify(rowsA.map((r) => ({ ...r, inventorName: '<enc>' })));
  ok(!/residence|nationality|country_code|address/i.test(serialized), '🔴 无 residence/国籍/country_code（数据最小化，只公司 country）');
  // 刷新扫描源 = 全部命中 '%SIEMENS%' 的落库行（不止 assigneeNorm='siemens'；含 Siemens Energy/Healthineers 等）
  const allSiemens = await ownerDb.patentInventorCache.findMany({ where: { assigneeNameRaw: { contains: 'Siemens', mode: 'insensitive' } }, select: { inventorName: true } });
  const scanInventors = new Set(allSiemens.map((r) => decryptPii(r.inventorName)));

  // ══════════ B · cache 模式读 = 零 BQ 字节 ══════════
  console.log('\n══ B · cache 模式逐公司读=零 BQ 字节，且与刷新源一致 ══');
  const toYear = new Date().getUTCFullYear();
  const fromYear = toYear - PATENT_CACHE_WINDOW_YEARS;
  const records = await readPatentCache(prisma, TARGET.name, { fromYear, toYear });
  const cacheInventors = records.flatMap((r) => r.inventors.map((i) => i.name));
  ok(records.length > 0 && cacheInventors.length > 0, `B：cache 读产 ${cacheInventors.length} 名发明人（纯 postgres，零 BQ 字节）`);
  ok(cacheInventors.every((n) => scanInventors.has(n)), 'B：cache 读发明人 ⊆ 刷新扫描源（一致，无捏造）');
  // cache 模式 provider 端到端（零 egress，不经 broker）
  const cacheProvider = new GooglePatentsInventorProvider({
    mode: 'cache',
    cacheReader: (n, o) => readPatentCache(prisma, n, o),
    enqueue: async (n, c) => { await enqueuePatentLookup(ownerDb, { companyName: n, country: c }); },
  });
  const cacheRes = await cacheProvider.discoverContacts(TARGET, { workspaceId: WS });
  ok(cacheRes.contacts.length > 0, `B：cache 模式 provider 产 ${cacheRes.contacts.length} 联系人（technical_buyer/CC BY）`);
  ok(cacheRes.contacts.every((c) => c.buyingRole === 'technical_buyer' && c.license === 'CC-BY-4.0' && c.personalData === true), 'B：联系人形状与直连全等（role/license/personalData）');

  // ══════════ C · DE/US 同名 T1 分流（注入合成 US 行，零 BQ）══════════
  console.log('\n══ C · DE/US 同名 T1 分流：注入合成 US 同名缓存行 → 读侧双键分组 ══');
  await ownerDb.patentInventorCache.create({
    data: {
      assigneeNameRaw: 'Siemens Inc', assigneeNorm: NORM, assigneeCountry: 'us',
      inventorName: encryptPii('US ONLY INVENTOR'), inventorNameKey: inventorBlindKey('US ONLY INVENTOR'),
      windowFromYear: fromYear, windowToYear: toYear, license: 'CC-BY-4.0', expiresAt: new Date(Date.now() + 180 * 86400000),
    },
  });
  const recordsC = await readPatentCache(prisma, TARGET.name, { fromYear, toYear });
  const countries = new Set(recordsC.map((r) => r.applicants[0].country));
  ok(recordsC.length >= 2 && countries.has('de') && countries.has('us'), `C：读侧产 ${recordsC.length} 条独立记录，含国别 de/us（各 (norm,country) 成独立组）`);
  // 🔴 T1 跨境防误并：合成 US 发明人只落 US 组，绝不并进任何 DE 组
  const usHasSynthetic = recordsC.some((r) => r.applicants[0].country === 'us' && r.inventors.some((i) => i.name === 'US ONLY INVENTOR'));
  const deHasSynthetic = recordsC.some((r) => r.applicants[0].country === 'de' && r.inventors.some((i) => i.name === 'US ONLY INVENTOR'));
  ok(usHasSynthetic && !deHasSynthetic, 'C：合成 US 发明人只落 US 组，绝不并进 DE 组（跨境防误并）');

  // ══════════ D · §8.8 SUSPENDED → 物化 + 直连回读 双停 ══════════
  console.log('\n══ D · §8.8 SUSPENDED：refresh DENIED（不扫）+ 直连 broker 被拒 ══');
  await ownerDb.patentLookupRequest.updateMany({ where: { assigneeNorm: NORM }, data: { status: 'PENDING', nextRefreshAt: null } });
  await ownerDb.sourcePolicy.update({ where: { domain: GP_DOMAIN }, data: { reviewStatus: 'SUSPENDED' } });
  const refreshD = await refreshPatentCache({ db: ownerDb as unknown as PatentRefreshDb, bq: bigqueryPatents });
  ok(refreshD.status === 'DENIED', `D：SUSPENDED → refresh DENIED（物化停，不扫 BQ；status=${refreshD.status}）`);
  const directDenied = await new GooglePatentsInventorProvider({ broker, mode: 'direct' }).discoverContacts(TARGET, { workspaceId: WS });
  ok(directDenied.contacts.length === 0, 'D：SUSPENDED → 直连 provider（broker §8.8）零发明人');
  await ownerDb.sourcePolicy.update({ where: { domain: GP_DOMAIN }, data: { reviewStatus: 'APPROVED' } });

  // ══════════ E · 幂等重跑 ══════════
  console.log('\n══ E · 幂等：确定性密文不产重复行 + 队列 CACHED → 二次刷新 SKIPPED_EMPTY ══');
  const beforeE = await ownerDb.patentInventorCache.count({ where: { assigneeNorm: NORM } });
  const anyRow = rowsA[0];
  ok(encryptPii(decryptPii(anyRow.inventorName)) === anyRow.inventorName, 'E：确定性密文（re-encrypt 同明文 === 存储密文）→ 唯一键幂等');
  await ownerDb.patentLookupRequest.updateMany({ where: { assigneeNorm: NORM }, data: { status: 'CACHED', nextRefreshAt: new Date(Date.now() + 180 * 86400000) } });
  const refreshE = await refreshPatentCache({ db: ownerDb as unknown as PatentRefreshDb, bq: bigqueryPatents });
  ok(refreshE.status === 'SKIPPED_EMPTY', `E：队列已 CACHED(未到期) → 二次刷新 SKIPPED_EMPTY（零再扫；status=${refreshE.status}）`);
  const afterE = await ownerDb.patentInventorCache.count({ where: { assigneeNorm: NORM } });
  ok(beforeE === afterE, `E：行数不变（${beforeE}→${afterE}，无重复）`);

  // ══════════ F · 空队列跳过扫描 ══════════
  console.log('\n══ F · 空队列 → SKIPPED_EMPTY（零 BQ 成本），保留期清理照跑 ══');
  await ownerDb.patentLookupRequest.deleteMany({ where: { assigneeNorm: NORM } });
  const refreshF = await refreshPatentCache({ db: ownerDb as unknown as PatentRefreshDb, bq: bigqueryPatents });
  ok(refreshF.status === 'SKIPPED_EMPTY' && refreshF.bytesScanned === null, `F：空队列 SKIPPED_EMPTY，bytesScanned=null（零 BQ 成本）`);

  // ══════════ G · Art.17 擦除扫描面 ══════════
  console.log('\n══ G · Art.17：按被擦除人盲键 deleteMany 命中删缓存行 ══');
  const victimReadable = records[0].inventors[0].name; // 一名真发明人的可读名（cache 读产的形态）
  const keys = inventorErasureKeys(victimReadable);
  const beforeG = await ownerDb.patentInventorCache.count({ where: { inventorNameKey: { in: keys } } });
  const del = await ownerDb.patentInventorCache.deleteMany({ where: { inventorNameKey: { in: keys } } });
  const afterG = await ownerDb.patentInventorCache.count({ where: { inventorNameKey: { in: keys } } });
  ok(beforeG > 0 && del.count === beforeG && afterG === 0, `G：擦除人「${victimReadable}」→ 盲键命中删 ${del.count} 行（真库盲键匹配，Art.17 扫描面）`);
}

try {
  await main();
} catch (err) {
  console.error('\n❌ main() 抛出：', err);
  failed++;
} finally {
  await ownerDb.sourcePolicy.update({ where: { domain: GP_DOMAIN }, data: { reviewStatus: 'APPROVED', allowedPurpose: ['discovery', 'enrichment'] } }).catch(() => {});
  await cleanup().catch(() => {});
  console.log(`\n██ ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`} ██`);
  await prisma.$disconnect();
  await ownerDb.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}
