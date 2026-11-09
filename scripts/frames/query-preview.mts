#!/usr/bin/env tsx
/**
 * registry_frame 查询预览 CLI（ch03 §3.9.12 契约的可运行入口）。
 *
 * 只读：任何角色的连接都能查平台表（app_user 只读）。默认取 DATABASE_URL，
 * 未设置时读 packages/db/.env。输出 plan filters → rationale → ProviderCompanyRecord[]，
 * 用于核对 ICP→NACE/规模带过滤是否命中预期实体（T3-09 接进 discovery 计划前的人工预览）。
 *
 * 用法：
 *   pnpm exec tsx scripts/frames/query-preview.mts \
 *     --country DE [--scheme de_hrb] [--nace 28,2813] [--band 10-49,50-249] \
 *     [--legal-form gmbh,ag] [--status ACTIVE] [--postal 8] [--limit 20] [--database-url <url>]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRegistryFramePrismaClient } from '../../apps/api/src/registry/frame-store.prisma';
import {
  parseRegistryQueryFilters,
  queryRegistryEntities,
  registryQueryRationale,
} from '../../apps/api/src/registry/query';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(message: string): never {
  process.stderr.write(`query-preview: ${message}\n`);
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

const splitList = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

const { values } = parseArgs({
  options: {
    country: { type: 'string' },
    scheme: { type: 'string' },
    nace: { type: 'string' },
    band: { type: 'string' },
    'legal-form': { type: 'string' },
    status: { type: 'string' },
    postal: { type: 'string' },
    limit: { type: 'string' },
    'database-url': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help || !values.country) {
  process.stdout.write(
    'usage: pnpm exec tsx scripts/frames/query-preview.mts --country DE [--scheme de_hrb] [--nace 28,2813] [--band 10-49] [--legal-form gmbh] [--status ACTIVE] [--postal 8] [--limit 20]\n',
  );
  process.exit(values.help ? 0 : 1);
}

const rawFilters: Record<string, unknown> = {
  country: values.country,
  ...(values.scheme !== undefined ? { scheme: values.scheme } : {}),
  ...(values.nace !== undefined ? { nace_prefix: splitList(values.nace) } : {}),
  ...(values.band !== undefined ? { employee_band: splitList(values.band) } : {}),
  ...(values['legal-form'] !== undefined ? { legal_form: splitList(values['legal-form']) } : {}),
  ...(values.status !== undefined ? { status: values.status } : {}),
  ...(values.postal !== undefined ? { postal_prefix: values.postal } : {}),
  ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
};

const filters = parseRegistryQueryFilters(rawFilters);
const databaseUrl = values['database-url'] ?? process.env.DATABASE_URL ?? databaseUrlFromEnvFile();
if (!databaseUrl) {
  die('缺少 DATABASE_URL：用 --database-url 传入或配置 packages/db/.env');
}

const prisma = createRegistryFramePrismaClient(databaseUrl);
try {
  const records = await queryRegistryEntities(prisma, filters);
  process.stdout.write(
    `${JSON.stringify(
      {
        rationale: registryQueryRationale(filters),
        filters,
        count: records.length,
        records,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await prisma.$disconnect();
}
