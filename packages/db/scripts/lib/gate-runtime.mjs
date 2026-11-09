/**
 * CI 检查器共享运行时（ch08 §3.4 G2/G5）：一次性库解析、disposable 护栏、Prisma CLI 与查询客户端。
 *
 * 安全边界：所有门都会向目标库 apply 迁移链（migrate deploy），因此只接受
 * 「一次性库名」（`*_test` / `*_scratch` / `prisma_drift_*`），拒绝落到共享 global_dev / gain_saas。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const dbPackageDir = resolve(repoRoot, 'packages/db');
export const baselinesDir = resolve(repoRoot, 'docs/governance/ci-baselines');

const DISPOSABLE_DATABASE = /(?:^prisma_drift_|_test$|_scratch$)/;

export function fail(gate, message) {
  console.error(`[${gate}] ${message}`);
  process.exit(1);
}

/** PRISMA_CIGATE_FROM_URL / DATABASE_URL，回退 packages/db/.env。 */
export function loadDatabaseUrl(gate) {
  if (process.env.PRISMA_CIGATE_FROM_URL) return process.env.PRISMA_CIGATE_FROM_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = resolve(dbPackageDir, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  fail(gate, 'PRISMA_CIGATE_FROM_URL / DATABASE_URL is required (env or packages/db/.env)');
}

export function assertDisposableDatabase(gate, databaseUrl) {
  let name;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    fail(gate, 'target database URL is not a valid URL');
  }
  if (!DISPOSABLE_DATABASE.test(name)) {
    fail(
      gate,
      `refusing to deploy migrations to non-disposable database "${name}"。` +
        ' 本门会向目标库 apply 迁移链；请把 PRISMA_CIGATE_FROM_URL 指向一次性库' +
        '（库名以 _scratch / _test 结尾或 prisma_drift_ 前缀）。',
    );
  }
  return databaseUrl;
}

export function prismaCli(args, { env = process.env } = {}) {
  const result = spawnSync('pnpm', ['--filter', '@global/db', 'exec', 'prisma', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail('ci-gate', `failed to run prisma: ${result.error.message}`);
  return result;
}

/** 把迁移链 apply 到目标库（幂等）。失败时返回输出由调用方判定。 */
export function deployMigrations(databaseUrl) {
  return prismaCli(['migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: databaseUrl } });
}

/** 用 @prisma/client（datasourceUrl 覆盖）跑只读 catalog 查询。 */
export async function withPrismaClient(databaseUrl, fn) {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    return await fn(client);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
