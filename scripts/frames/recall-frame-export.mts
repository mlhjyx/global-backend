#!/usr/bin/env tsx
/**
 * 召回审计 frame 导出 CLI（ch03 §3.17.5 T3-20 骨架：冻结 frame → 审计输入）。
 *
 * 选定一个 registry frame 的已发布快照（默认取最近一个 PARSED），把该快照冻结集合
 * （last_snapshot_id = snapshot.id 且未退出的实体）导出为 recall-audit.mjs 的
 * `--frame` 输入。只读；app_user 即可查平台表。
 *
 * 用法：
 *   pnpm exec tsx scripts/frames/recall-frame-export.mts \
 *     --frame fr_sirene [--snapshot <snapshotId>] [--out /tmp/fr-frame.json] [--database-url <url>]
 *
 * 产物：{schemaVersion:'recall-frame-export/v1', manifest:{frameKey,snapshotId,sha256,rowCount,exportedAt}, entities:[...]}
 * 报告里记录 manifest.snapshotId 与 sha256 + 审计 seed，即可完整复算。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRegistryFramePrismaClient } from '../../apps/api/src/registry/frame-store.prisma';
import { buildRecallFrameExport, RecallFrameExportError } from '../../apps/api/src/registry/recall-frame-export';
import { loadRecallFrameExport } from '../../apps/api/src/registry/recall-frame-export.prisma';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(message: string): never {
  process.stderr.write(`recall-frame-export: ${message}\n`);
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
    frame: { type: 'string' },
    snapshot: { type: 'string' },
    out: { type: 'string' },
    'database-url': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help || !values.frame) {
  process.stdout.write(
    'usage: pnpm exec tsx scripts/frames/recall-frame-export.mts --frame <frameKey> [--snapshot <snapshotId>] [--out file.json]\n',
  );
  process.exit(values.help ? 0 : 1);
}

const databaseUrl = values['database-url'] ?? process.env.DATABASE_URL ?? databaseUrlFromEnvFile();
if (!databaseUrl) {
  die('缺少 DATABASE_URL：用 --database-url 传入或配置 packages/db/.env');
}

const prisma = createRegistryFramePrismaClient(databaseUrl);
try {
  // 取数语义与 Temporal 活动共用同一实现（frame 快照解析与冻结实体口径不分叉）。
  let exportPayload: ReturnType<typeof buildRecallFrameExport>;
  try {
    exportPayload = await loadRecallFrameExport(prisma, {
      frameKey: values.frame,
      snapshotId: values.snapshot ?? null,
      exportedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof RecallFrameExportError) die(error.message);
    throw error;
  }
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
