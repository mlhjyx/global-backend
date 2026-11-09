#!/usr/bin/env node
/**
 * ch08 §3.4 G5：RLS/租户目录门。
 *
 * 对一次性库（迁移链 deploy 后）做结构检查：
 *  1. 带 `workspace_id` 列的表必须 `ENABLE + FORCE ROW LEVEL SECURITY` 且至少一条策略；
 *     例外（历史 SQL-only / 平台白名单）必须登记在基线（owner + 到期日）；
 *  2. 不带 `workspace_id` 的表分三类，全部必须在目录基线里**被明确分类**：
 *     - `platform_table`：无 RLS 的平台参考/账本表；
 *     - `owner_only`：RLS 开且零策略（仅属主/SECURITY DEFINER 可访问的围栏/回执表）；
 *     - `rls_enforced`：RLS 开且有策略（非 workspace 键的租户表）——出现新表即要求登记；
 *  3. `app_user` 的默认表权限必须恰好是 SELECT（新表默认只读；写权限由建表迁移显式授予）。
 *
 * 基线 `docs/governance/ci-baselines/g5-rls-catalog.json` 只许收紧：新表未登记 → 红；
 * 登记项与库中状态不符/表已消失 → 红；条目过期 → 红。
 *
 * 用法：
 *   node packages/db/scripts/rls-catalog-gate.mjs
 *   node packages/db/scripts/rls-catalog-gate.mjs --write-baseline
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDisposableDatabase,
  baselinesDir,
  deployMigrations,
  fail,
  loadDatabaseUrl,
  todayIsoDate,
  withPrismaClient,
} from './lib/gate-runtime.mjs';

const GATE = 'g5-rls-catalog';
const BASELINE_PATH = join(baselinesDir, 'g5-rls-catalog.json');

const RELATIONS_SQL = `
  SELECT c.relname,
    EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
    ) AS has_workspace_id,
    c.relrowsecurity AS rls,
    c.relforcerowsecurity AS force_rls,
    (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
  ORDER BY c.relname
`;

const DEFAULT_ACL_SQL = `
  SELECT format('%s %s %s %s %s',
      pg_catalog.pg_get_userbyid(d.defaclrole),
      coalesce(nsp.nspname::text, '*'),
      CASE d.defaclobjtype WHEN 'r' THEN 'tables' ELSE 'sequences' END,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
      a.privilege_type || CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END) AS entry
  FROM pg_catalog.pg_default_acl AS d
  LEFT JOIN pg_catalog.pg_namespace AS nsp ON nsp.oid = d.defaclnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS a
  WHERE d.defaclobjtype IN ('r', 'S')
  ORDER BY 1
`;

/** 与迁移 20261010090000 的 default_expected 逐字一致。 */
const EXPECTED_DEFAULT_ACL = [
  'global public sequences app_user SELECT',
  'global public sequences app_user USAGE',
  'global public tables app_user SELECT',
];

function classify(table) {
  if (table.has_workspace_id) {
    return table.rls && table.force_rls && table.policies > 0
      ? 'workspace_rls'
      : 'workspace_rls_missing';
  }
  if (!table.rls) return 'platform_table';
  return table.policies > 0 ? 'rls_enforced' : 'owner_only';
}

function describeClass(class_) {
  switch (class_) {
    case 'platform_table':
      return '无 workspace_id 且无 RLS 的平台参考/账本表';
    case 'owner_only':
      return '无 workspace_id、RLS 开但零策略（仅属主/SECURITY DEFINER 访问）';
    case 'rls_enforced':
      return '无 workspace_id、RLS 开且有策略（非 workspace 键的租户表）';
    default:
      return class_;
  }
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { tables: {} };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (error) {
    fail(GATE, `baseline is not valid JSON: ${error.message}`);
  }
}

async function collect(databaseUrl) {
  const deploy = deployMigrations(databaseUrl);
  if (deploy.status !== 0) {
    fail(
      GATE,
      `prisma migrate deploy 失败：\n${deploy.stdout}\n${deploy.stderr}`.trim(),
    );
  }
  return withPrismaClient(databaseUrl, async (prisma) => {
    const relations = await prisma.$queryRawUnsafe(RELATIONS_SQL);
    const defaultAcl = await prisma.$queryRawUnsafe(DEFAULT_ACL_SQL);
    return {
      relations: relations.map((row) => ({
        name: row.relname,
        has_workspace_id: row.has_workspace_id === true,
        rls: row.rls === true,
        force_rls: row.force_rls === true,
        policies: Number(row.policies ?? 0),
      })),
      defaultAcl: defaultAcl.map((row) => row.entry),
    };
  });
}

function check({ relations, defaultAcl }) {
  const baseline = loadBaseline();
  const catalog = baseline.tables ?? {};
  const today = todayIsoDate();
  const problems = [];
  const seen = new Set();

  for (const table of relations) {
    const class_ = classify(table);
    if (class_ === 'workspace_rls') continue;
    seen.add(table.name);
    const entry = catalog[table.name];
    if (!entry) {
      problems.push(
        `${table.name}（${describeClass(class_)}）未在 docs/governance/ci-baselines/g5-rls-catalog.json 登记。` +
          (class_ === 'workspace_rls_missing'
            ? ' 带 workspace_id 的新表必须 ENABLE + FORCE RLS 并定义策略；平台表则登记为 platform_table（owner + 到期日）。'
            : ' 新表必须明确分类（platform_table / owner_only / rls_enforced）后才能合入。'),
      );
      continue;
    }
    if (entry.class !== class_) {
      problems.push(
        `${table.name} 的登记分类 ${entry.class} 与库中状态 ${class_} 不符` +
          '（结构变化后请更新分类或修好 RLS——ratchet：登记必须反映真实状态）。',
      );
    }
    if (typeof entry.owner !== 'string' || typeof entry.expiresAt !== 'string') {
      problems.push(`基线条目 ${table.name} 缺少 owner/expiresAt`);
    } else if (entry.expiresAt < today) {
      problems.push(`基线条目 ${table.name} 已过期（${entry.expiresAt}，owner ${entry.owner}）`);
    }
  }
  for (const name of Object.keys(catalog)) {
    if (!seen.has(name)) {
      problems.push(
        `基线条目 ${name} 已不适用（表不存在或已具备 workspace RLS）——ratchet：必须删除该条目。`,
      );
    }
  }

  const actualAcl = [...defaultAcl].sort();
  const expected = [...EXPECTED_DEFAULT_ACL].sort();
  if (JSON.stringify(actualAcl) !== JSON.stringify(expected)) {
    problems.push(
      'app_user 默认表/序列权限不符合「新表默认只读」：' +
        `实际 [${actualAcl.join(' | ')}]，期望 [${expected.join(' | ')}]。` +
        ' 新表的写权限必须由建表迁移显式 GRANT，而不是默认权限。',
    );
  }
  return problems;
}

function writeBaseline({ relations }) {
  const tables = {};
  for (const table of relations) {
    const class_ = classify(table);
    if (class_ === 'workspace_rls') continue;
    tables[table.name] = {
      class: class_,
      owner: table.name === 'discovery_company_materialization_tx_fence' ? 'P5c-BE-30' : 'backend-platform',
      expiresAt: '2027-01-31',
      reason: describeClass(class_),
    };
  }
  const payload = {
    $comment:
      'G5 RLS/租户目录基线（ch08 §3.4）：带 workspace_id 的表必须 RLS+FORCE+策略；其余表必须在此明确分类。只许收紧。',
    tables,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  const counts = Object.values(tables).reduce((acc, entry) => {
    acc[entry.class] = (acc[entry.class] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[${GATE}] wrote ${Object.keys(tables).length} catalog entries (${JSON.stringify(counts)}) → ${BASELINE_PATH}`,
  );
}

async function main() {
  const databaseUrl = assertDisposableDatabase(GATE, loadDatabaseUrl(GATE));
  const collected = await collect(databaseUrl);
  if (process.argv.includes('--write-baseline')) {
    writeBaseline(collected);
    return;
  }
  const problems = check(collected);
  if (problems.length > 0) {
    console.error(`[${GATE}] FAILED`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const tenants = collected.relations.filter((table) => classify(table) === 'workspace_rls').length;
  console.log(
    `[${GATE}] OK — ${collected.relations.length} 张表：${tenants} 张 workspace RLS 强制，其余均在目录基线内；app_user 默认权限为只读。`,
  );
}

main().catch((error) => {
  fail(GATE, error instanceof Error ? error.message : String(error));
});

export { classify, EXPECTED_DEFAULT_ACL };
