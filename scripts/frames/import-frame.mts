#!/usr/bin/env tsx
/**
 * Frame 装载 CLI（GainOS v3.0 ch03 P2 · T3-03 的 v0 形态）。
 *
 * 用法（在 backend worktree 内，owner 连接平台表）：
 *   pnpm exec tsx scripts/frames/import-frame.mts \
 *     --frame scripts/frames/frames/gb-companies-house.json \
 *     --file  scripts/frames/fixtures/gb-companies-house.sample.csv \
 *     [--allow-partial] [--propose-links] [--dry-run] [--database-url <owner url>]
 *
 * 连接：默认取 DATABASE_URL；未设置时读 packages/db/.env（owner 连接）。平台表
 * 没有 RLS，写入只允许平台 ops（app_user 只读，见迁移里的 GRANT）。
 *
 * --dry-run：不出网不写库，只做解析 + 逐行归一 + 计划统计，用于接入前核对映射。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { importFrame, readFrameFile } from '../../apps/api/src/registry/frame-importer';
import {
  createRegistryFramePrismaClient,
  PrismaRegistryFrameStore,
} from '../../apps/api/src/registry/frame-store.prisma';
import { parseFrameConfig } from '../../apps/api/src/registry/frame-types';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(message: string): never {
  process.stderr.write(`import-frame: ${message}\n`);
  process.exit(1);
}

function databaseUrlFromEnvFile(): string | null {
  const candidates = [
    join(HERE, '../../packages/db/.env'),
    join(HERE, '../../apps/api/.env'),
  ];
  for (const path of candidates) {
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
    file: { type: 'string' },
    'allow-partial': { type: 'boolean', default: false },
    'propose-links': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'database-url': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
    'usage: pnpm exec tsx scripts/frames/import-frame.mts --frame <frame.json> --file <data.csv|data.json> [--allow-partial] [--propose-links] [--dry-run]\n',
  );
  process.exit(0);
}
if (!values.frame || !values.file) {
  die('必须同时提供 --frame 与 --file（--help 查看用法）');
}

let configJson: unknown;
let bytes: Buffer;
try {
  configJson = JSON.parse(readFileSync(resolve(values.frame), 'utf8'));
  bytes = readFileSync(resolve(values.file));
} catch (error) {
  die(`读取 --frame/--file 失败：${(error as Error).message}`);
}

if (values['dry-run']) {
  const config = parseFrameConfig(configJson);
  const contents = readFrameFile(config, bytes);
  process.stdout.write(
    `${JSON.stringify(
      {
        dryRun: true,
        frameKey: config.frame.frameKey,
        format: config.mapping.format,
        rowCount: contents.rowCount,
        validRows: contents.entities.length,
        invalidRows: contents.invalid.length,
        warnings: contents.warnings.slice(0, 20),
        sample: contents.entities.slice(0, 3),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(contents.invalid.length === 0 ? 0 : 1);
}

const databaseUrl = values['database-url'] ?? process.env.DATABASE_URL ?? databaseUrlFromEnvFile();
if (!databaseUrl) {
  die('缺少 DATABASE_URL（owner 连接）：用 --database-url 传入或配置 packages/db/.env');
}

const prisma = createRegistryFramePrismaClient(databaseUrl);
try {
  const result = await importFrame({
    store: new PrismaRegistryFrameStore(prisma),
    config: configJson,
    file: { name: values.file, bytes },
    allowPartial: values['allow-partial'],
    proposeLinks: values['propose-links'],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await prisma.$disconnect();
}
