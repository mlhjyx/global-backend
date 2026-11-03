/**
 * 一次性联系人行清理（M5 Golden Set 第三轮 §9：存量误报与重复行）。
 *
 * 背景：`docs/evidence/2026-11-03-contact-golden-set-m5.md` §9 记录了两类存量脏行——同名异公司的
 * 社媒误报（abendi/bts 共 9 条，守卫只防新增）与德语学位串导致的同一人重复行（trik-pumpen 1 对）。
 * 本脚本给它们一条**显式、可核对、可审计**的删除路径：id 由操作者逐个给出，默认 dry-run 只打印，
 * `--apply` 才在单个事务里删除。
 *
 * 删除语义：先按 entity 删 `field_evidence`（无 FK 级联），再删 `canonical_contact`（`contact_point`
 * 随外键级联）。与 `deletion.activities.ts` 的擦除语义一致，但**不**写 person-level suppression——
 * 误报行不是数据主体擦除请求，不该永久禁联同名真实联系人。
 *
 * 安全栏：
 *  - 连接必须是运行时同款受限 app_user（`isAuthorizedAppDatabasePrincipal`：非 superuser、无 BYPASSRLS、
 *    无角色成员关系），否则 RLS 隔离不成立，拒绝运行；
 *  - `--expect-companies` 校验每行所属公司域，防把 id 抄错到别的公司；
 *  - 任一目标行带 VALID 联系方式即拒绝（除非显式 `--allow-valid`）——VALID 只由人工给出，
 *    误删代价高；误报行的邮箱猜测是 RISKY，不会被误伤。`--apply` 事务内会锁住 contact_point 并**重检**
 *    VALID（防 dry-run 后被人工验成 VALID 的点被连带删除），计数也在同一事务里取；
 *  - `--audit-out` 写 PII-free JSON（只有 opaque id、公司域、字段/联系点类型与计数，无姓名/值/去重键），
 *    便于事后对账。
 *
 * 运行（在 apps/api 下）：
 *   1) dry-run（默认）：
 *      node --import tsx scripts/cleanup-contact-false-positives.mts \
 *        --workspace <workspace-uuid> \
 *        --delete <contact-id[,contact-id...]> \
 *        --expect-companies abendi.de,bts-engineering.de
 *   2) 核对输出后执行（产线动作，需用户确认）：
 *      node --import tsx scripts/cleanup-contact-false-positives.mts \
 *        --workspace <workspace-uuid> --delete <ids> --expect-companies <domains> \
 *        --reason "M5 round-3 false positives" \
 *        --audit-out /root/DbBackup/contact-cleanup-<date>.json --apply
 *
 * ⚠️ dry-run 输出含解密后的姓名（本机 PII），只在本机终端核对，不要贴进仓库或工单。
 */
import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  PrismaService,
  isAuthorizedAppDatabasePrincipal,
  type DatabasePrincipalEvidence,
} from '../src/prisma/prisma.service';
import { DATABASE_PRINCIPAL_QUERY } from '../src/compliance/pii-crypto.extension';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Args {
  workspace: string;
  deleteIds: string[];
  expectCompanies: string[];
  reason?: string;
  auditOut?: string;
  apply: boolean;
  allowValid: boolean;
}

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) fail(`无法解析参数：${arg}`);
    const eq = arg.indexOf('=');
    if (eq > 0) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      values.set(name, next);
      i += 1;
    } else {
      flags.add(name);
    }
  }
  const workspace = values.get('workspace');
  if (!workspace || !UUID_RE.test(workspace)) fail('必须提供 --workspace <uuid>');
  const rawIds = (values.get('delete') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!rawIds.length) fail('必须提供 --delete <contact-id[,contact-id...]>（不接受批量条件，只接受显式 id）');
  const badId = rawIds.find((id) => !UUID_RE.test(id));
  if (badId) fail(`--delete 中有非法 uuid：${badId}`);
  const deleteIds = [...new Set(rawIds.map((id) => id.toLowerCase()))];
  const expectCompanies = (values.get('expect-companies') ?? '')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const apply = flags.has('apply');
  const reason = values.get('reason')?.trim();
  if (apply && !reason) fail('--apply 必须带 --reason（写进审计输出，说明这批行为什么该删）');
  const auditOut = values.get('audit-out');
  if (apply && !auditOut) fail('--apply 必须带 --audit-out <path>（留下删除对账）');
  if (apply && auditOut) {
    // 删除已提交后才发现审计目录不可写，会留下“删了但无对账”的状态——动手前先验目录。
    try {
      accessSync(dirname(auditOut), constants.W_OK);
    } catch {
      fail(`--audit-out 的目录不可写：${dirname(auditOut)}`);
    }
  }
  return { workspace, deleteIds, expectCompanies, reason, auditOut, apply, allowValid: flags.has('allow-valid') };
}

const args = parseArgs(process.argv.slice(2));
const prisma = new PrismaService();
await prisma.$connect();

// 与运行时启动自检同一把尺：不只查 superuser，也拒绝 BYPASSRLS / 角色成员关系（后者会让 withWorkspace
// 的 RLS 隔离失效，而 --expect-companies 只校验域、跨 workspace 同行可能被误删）。
const principal = (
  await prisma.$queryRawUnsafe<DatabasePrincipalEvidence[]>(DATABASE_PRINCIPAL_QUERY)
)[0];
if (!isAuthorizedAppDatabasePrincipal(principal)) {
  fail(
    `app 连接不是受限的 app_user（session=${principal?.sessionUser} current=${principal?.currentUser} ` +
      `super=${principal?.rolSuper} bypassRls=${principal?.rolBypassRls}）→ 拒绝运行。请用 APP_DATABASE_URL=app_user。`,
  );
}

type TargetRow = Prisma.CanonicalContactGetPayload<{
  include: {
    company: { select: { id: true; name: true; domain: true } };
    contactPoints: { select: { type: true; value: true; status: true } };
  };
}>;

const rows: TargetRow[] = await (async () => {
  try {
    return await prisma.withWorkspace(args.workspace, (tx) =>
      tx.canonicalContact.findMany({
        where: { id: { in: args.deleteIds } },
        include: {
          company: { select: { id: true, name: true, domain: true } },
          contactPoints: { select: { type: true, value: true, status: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  } catch (error) {
    if (error instanceof Error && /authenticate/i.test(error.message)) {
      fail(
        'PII 解密失败：进程里的 PII_ENCRYPTION_KEY 与写库时用的运行时密钥不一致。' +
          '先导出运行中 API 容器的密钥再跑：export PII_ENCRYPTION_KEY=$(docker exec global-api printenv PII_ENCRYPTION_KEY)',
      );
    }
    throw error;
  }
})();

const found = new Set(rows.map((row) => row.id.toLowerCase()));
const missing = args.deleteIds.filter((id) => !found.has(id));
if (missing.length) fail(`以下 id 在 workspace ${args.workspace} 下不存在（或 RLS 不可见）：${missing.join(', ')}`);

if (args.expectCompanies.length) {
  const allowed = new Set(args.expectCompanies);
  const unexpected = rows.filter((row) => !allowed.has((row.company.domain ?? '').toLowerCase()));
  if (unexpected.length) {
    fail(
      `以下行不属于 --expect-companies（${[...allowed].join(',')}）：` +
        unexpected.map((row) => `${row.id}@${row.company.domain ?? row.company.id}`).join(', '),
    );
  }
}

const validRows = rows.filter((row) => row.contactPoints.some((point) => point.status === 'VALID'));
if (validRows.length && !args.allowValid) {
  fail(`以下行带 VALID 联系方式（人工确认过），默认拒绝删除；确需删除请显式 --allow-valid：${validRows.map((r) => r.id).join(', ')}`);
}

const evidenceRows = await prisma.withWorkspace(args.workspace, (tx) =>
  tx.fieldEvidence.findMany({
    where: { entityType: 'contact', entityId: { in: args.deleteIds } },
    select: { entityId: true, field: true, dataClass: true },
    orderBy: [{ entityId: 'asc' }, { field: 'asc' }],
  }),
);
const evidenceByContact = new Map<string, { field: string; dataClass: string }[]>();
for (const row of evidenceRows) {
  const list = evidenceByContact.get(row.entityId) ?? [];
  list.push({ field: row.field, dataClass: row.dataClass });
  evidenceByContact.set(row.entityId, list);
}

const pointCount = rows.reduce((sum, row) => sum + row.contactPoints.length, 0);
console.log(
  `联系人行清理 —— workspace ${args.workspace}，模式：${args.apply ? 'APPLY（将删除）' : 'dry-run（不删除任何数据）'}`,
);
console.log('⚠️ 以下输出含解密后的个人姓名，仅限本机核对；不要粘贴进仓库、工单或证据文档。\n');
for (const row of rows) {
  const points = row.contactPoints.map((point) => `${point.type}:${point.status}`).join(', ') || '—';
  const fields = (evidenceByContact.get(row.id) ?? []).map((entry) => entry.field).join(', ') || '—';
  console.log(`· ${row.id}`);
  console.log(`  company=${row.company.domain ?? row.company.id} (${row.company.name})`);
  console.log(`  created=${row.createdAt.toISOString()} name="${row.fullName}" title="${row.title ?? ''}"`);
  console.log(`  dedupe=${row.dedupeKey}`);
  console.log(`  points=[${points}] evidence=[${fields}]`);
  for (const point of row.contactPoints) {
    if (point.type === 'email' || point.type === 'phone' || point.type === 'linkedin') {
      console.log(`  ${point.type}=${point.value} (${point.status})`);
    }
  }
}
console.log(
  `\n共 ${rows.length} 行 contact、${pointCount} 个 contact_point（随外键级联）、${evidenceRows.length} 条 field_evidence。`,
);

if (!args.apply) {
  console.log('\n未做任何改动。核对无误后加 --apply --reason <text> --audit-out <path> 执行（产线动作，需用户确认）。');
  await prisma.$disconnect();
  process.exit(0);
}

const ids = rows.map((row) => row.id);
const deleted = await prisma.withWorkspace(args.workspace, async (tx) => {
  const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM canonical_contact
    WHERE id::text IN (${Prisma.join(ids)})
    ORDER BY id
    FOR UPDATE`);
  if (locked.length !== ids.length) {
    throw new Error(`行在核对与删除之间消失（locked=${locked.length}/${ids.length}），已回滚`);
  }
  // contact_point 行也锁住（contact 锁拦不住点更新）：dry-run 与 --apply 之间若有人把某点验成 VALID，
  // 不重检就会把脚本承诺「默认拒删」的行连点删掉（TOCTOU）。锁后重检，任何 VALID 点都让整批回滚。
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM contact_point
    WHERE contact_id::text IN (${Prisma.join(ids)})
    ORDER BY id
    FOR UPDATE`);
  const validLeft = await tx.contactPoint.count({
    where: { contactId: { in: ids }, status: 'VALID' },
  });
  if (validLeft > 0 && !args.allowValid) {
    throw new Error(`apply 事务内重检出 ${validLeft} 个 VALID 联系方式（核对后被人工验证？），已回滚；确需删除请显式 --allow-valid`);
  }
  // 计数在**同一事务**内取：核对快照与删除之间新增的点/证据也要如实进审计，不能只报快照数。
  const pointCountInTx = await tx.contactPoint.count({ where: { contactId: { in: ids } } });
  const evidence = await tx.fieldEvidence.deleteMany({
    where: { entityType: 'contact', entityId: { in: ids } },
  });
  const contacts = await tx.canonicalContact.deleteMany({ where: { id: { in: ids } } });
  return { evidence: evidence.count, contacts: contacts.count, contactPoints: pointCountInTx };
});

const audit = {
  kind: 'contact-row-cleanup/v1',
  workspaceId: args.workspace,
  at: new Date().toISOString(),
  reason: args.reason,
  deleted: {
    contacts: deleted.contacts,
    contactPoints: deleted.contactPoints,
    fieldEvidence: deleted.evidence,
  },
  rows: rows.map((row) => ({
    id: row.id,
    companyId: row.company.id,
    companyDomain: row.company.domain ?? null,
    createdAt: row.createdAt.toISOString(),
    contactPoints: row.contactPoints.map((point) => ({ type: point.type, status: point.status })),
    evidenceFields: (evidenceByContact.get(row.id) ?? []).map((entry) => entry.field),
  })),
};
if (args.auditOut) {
  writeFileSync(args.auditOut, `${JSON.stringify(audit, null, 2)}\n`, { mode: 0o600 });
  console.log(`\n审计已写入 ${args.auditOut}（0600，无 PII 明文）。`);
}

console.log(
  `✅ 已删除 ${deleted.contacts} 行 contact、${deleted.contactPoints} 个 contact_point（级联）、${deleted.evidence} 条 field_evidence。`,
);
await prisma.$disconnect();
