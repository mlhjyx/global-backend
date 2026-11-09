#!/usr/bin/env tsx
/**
 * 召回审计 run 产出池导出 CLI（ch03 §3.17.5 执行面：run → 审计 --pool 输入）。
 *
 * 给定 workspace + runId，把该 run 的物化结果导出成 recall-audit.mjs 的 `--pool`
 * 输入（`{schemaVersion:'recall-pool-export/v1', manifest, pool:[...]}`），
 * 注册身份按 registry_frame 提供者的 externalId 解析。只读；以 owner 连接运行并
 * 显式按 workspaceId 过滤（与 recall-frame-export.mts 同口径）。
 *
 * 用法：
 *   pnpm exec tsx scripts/frames/recall-pool-export.mts \
 *     --workspace <workspaceId> --run <runId> [--out /tmp/run-pool.json] [--database-url <url>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRegistryFramePrismaClient } from '../../apps/api/src/registry/frame-store.prisma';
import { buildRecallPoolExport } from '../../apps/api/src/registry/recall-pool-export';
import { loadRunPoolSourceRows } from '../../apps/api/src/registry/recall-pool-export.prisma';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(message: string): never {
  process.stderr.write(`recall-pool-export: ${message}\n`);
  process.exit(1);
}

function databaseUrlFromEnvFile(): string | null {
  for (const path of [join(HERE, '../../packages/db/.env'), join(HERE, '../../apps/api/.env')]) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const match = /^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?\s*$/u.exec(line);
      if (match) return match[1]!.trim();
    }
  }
  return null;
}

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    run: { type: 'string' },
    out: { type: 'string' },
    'database-url': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help || !values.workspace || !values.run) {
  process.stdout.write(
    'usage: pnpm exec tsx scripts/frames/recall-pool-export.mts --workspace <workspaceId> --run <runId> [--out file.json]\n',
  );
  process.exit(values.help ? 0 : 1);
}

const databaseUrl = values['database-url'] ?? process.env.DATABASE_URL ?? databaseUrlFromEnvFile();
if (!databaseUrl) {
  die('缺少 DATABASE_URL：用 --database-url 传入或配置 packages/db/.env');
}

const prisma = createRegistryFramePrismaClient(databaseUrl);
try {
  const rows = await loadRunPoolSourceRows(prisma, values.workspace, values.run);
  const exportPayload = buildRecallPoolExport({
    rows,
    runId: values.run,
    workspaceId: values.workspace,
    exportedAt: new Date().toISOString(),
  });
  const json = `${JSON.stringify(exportPayload, null, 2)}\n`;
  if (values.out) {
    writeFileSync(resolve(values.out), json, 'utf8');
    process.stdout.write(`${resolve(values.out)}\n`);
  } else {
    process.stdout.write(json);
  }
} finally {
  await prisma.$disconnect();
}
