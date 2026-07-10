/**
 * 收口① CandidateAssessment · 真库真 RLS 验收（无 sandbox）。
 * 证明：fit_verdict 迁到 Lead 后，同 workspace 两个 ICP 对同一家公司的判定**各自独立、互不覆盖**
 * （旧代码 fit 挂 canonical_company，后判 ICP 会覆盖前判）。不依赖 LLM/new-api——直接构造 judgment
 * 调共享 upsertLeadFit，专验数据库层（新 schema + FK + (ws,icp,company) 唯一键 + 幂等）在真 PG 下正确。
 *
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-candidate-assessment-fit.mts
 *
 * ⚠️ 必须以 app_user（非 superuser）跑，否则 RLS 被绕、证明失效（开头硬 guard）。
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { upsertLeadFit } from '../src/discovery/fit-judge';

process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const WS = 'caf1caf1-caf1-4caf-8caf-caf1caf1caf1';
const ICP_A = 'aaaa1111-aaaa-4aaa-8aaa-aaaa1111aaaa';
const ICP_B = 'bbbb2222-bbbb-4bbb-8bbb-bbbb2222bbbb';
const DEDUPE = '__CAFIT__acme-metalworks';
let failed = 0;
const ok = (cond: boolean, msg: string) => {
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
  console.error('❌ app 连接是 superuser → RLS 被绕，证明无意义。请用 APP_DATABASE_URL=app_user 跑。');
  process.exit(2);
}

// 清理旧测试数据（owner 绕 RLS 删净：先 lead（FK 子）后 company）
async function cleanup(): Promise<void> {
  await ownerDb.lead.deleteMany({ where: { workspaceId: WS } });
  await ownerDb.canonicalCompany.deleteMany({ where: { workspaceId: WS } });
}
await cleanup();

try {
  // 1) 建一家真实 canonical 公司（满足 Lead 新 FK + RLS）
  const companyId = await prisma.withWorkspace(WS, async (tx) => {
    const c = await tx.canonicalCompany.create({
      data: { workspaceId: WS, name: '__CAFIT__ ACME Metalworks', domain: 'acme-metalworks.example', country: 'DE', dedupeKey: DEDUPE },
    });
    return c.id;
  });
  console.log(`\n① 建 canonical 公司 ${companyId.slice(0, 8)}… (DE)`);

  // 2) 同一公司：ICP-A 判 match、ICP-B 判 mismatch（真库，经 upsertLeadFit）
  await prisma.withWorkspace(WS, (tx) =>
    upsertLeadFit(tx, WS, ICP_A, companyId, { verdict: 'match', fitReasons: { note: 'ICP-A 材质/工艺吻合' } } as never),
  );
  await prisma.withWorkspace(WS, (tx) =>
    upsertLeadFit(tx, WS, ICP_B, companyId, { verdict: 'mismatch', fitReasons: { note: 'ICP-B 品类不符' } } as never),
  );

  // 3) 断言：两条独立 Lead，各自 fitVerdict 正确，A 未被 B 覆盖
  const leads = await prisma.withWorkspace(WS, (tx) =>
    tx.lead.findMany({ where: { canonicalCompanyId: companyId }, orderBy: { icpId: 'asc' } }),
  );
  console.log('\n② 判定后 Lead 快照：');
  for (const l of leads) console.log(`   icp=${l.icpId.slice(0, 8)}… fitVerdict=${l.fitVerdict} version=${l.version} queue=${l.queue}`);
  ok(leads.length === 2, `两条独立 Lead（实得 ${leads.length}）`);
  const a = leads.find((l) => l.icpId === ICP_A);
  const b = leads.find((l) => l.icpId === ICP_B);
  ok(a?.fitVerdict === 'match', `ICP-A.fitVerdict = match（实得 ${a?.fitVerdict}）`);
  ok(b?.fitVerdict === 'mismatch', `ICP-B.fitVerdict = mismatch（实得 ${b?.fitVerdict}）—— 后判 ICP-B 未覆盖 ICP-A`);

  // 4) 幂等：重判 ICP-A → 仍 2 条，version 增，不新建
  await prisma.withWorkspace(WS, (tx) =>
    upsertLeadFit(tx, WS, ICP_A, companyId, { verdict: 'match', fitReasons: { note: '重判' } } as never),
  );
  const after = await prisma.withWorkspace(WS, (tx) => tx.lead.findMany({ where: { canonicalCompanyId: companyId } }));
  const a2 = after.find((l) => l.icpId === ICP_A);
  ok(after.length === 2, `重判 ICP-A 后仍 2 条（幂等，实得 ${after.length}）`);
  ok((a2?.version ?? 0) > (a?.version ?? 0), `ICP-A version 递增（${a?.version}→${a2?.version}）`);

  // 5) 证明 canonical_company 已无 fit_verdict 列（schema 迁移生效）
  const cols = await ownerDb.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'canonical_company' AND column_name IN ('fit_verdict', 'fit_reasons')`;
  ok(cols.length === 0, `canonical_company 已无 fit_verdict/fit_reasons 列（实得残留 ${cols.length}）`);
  const leadCols = await ownerDb.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'lead' AND column_name IN ('fit_verdict', 'fit_reasons')`;
  ok(leadCols.length === 2, `lead 表有 fit_verdict + fit_reasons 列（实得 ${leadCols.length}/2）`);

  // 6) 水位列仍在 canonical（未被误迁）
  const wm = await ownerDb.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'canonical_company'
    AND column_name IN ('last_enriched_at','last_signal_at','last_watch_at','contact_discovery_attempted_at')`;
  ok(wm.length === 4, `四个水位列仍在 canonical_company（公司级，实得 ${wm.length}/4）`);
} finally {
  await cleanup();
  await prisma.$disconnect();
  await ownerDb.$disconnect();
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`}`);
process.exit(failed === 0 ? 0 : 1);
