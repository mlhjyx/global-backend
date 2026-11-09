/**
 * 金标晋升/退役 CLI（P3 J18；设计 §4.3.8.3）。
 *
 * 用法：
 *   pnpm exec tsx scripts/judgment/promote-golden-labels.mts --workspace <uuid> --to test [--limit 50] [--ids a,b] [--dry-run]
 *   pnpm exec tsx scripts/judgment/promote-golden-labels.mts --workspace <uuid> --retire-keep 300 --from-split test [--dry-run]
 *
 * append-only：晋升/退役都追加新 split 的行，原行不改；重复执行幂等（按内容去重）。
 * 连接：优先 APP_DATABASE_URL（app_user，RLS 生效），否则 DATABASE_URL（owner）。
 */

import { PrismaClient } from '@prisma/client';
import { parseArgs } from 'node:util';

import {
  GOLDEN_LABEL_SPLITS,
  goldenLabelSummary,
  promoteGoldenLabels,
  retireGoldenLabels,
  type GoldenLabelSplit,
} from '../../src/discovery/judgment/golden-label';

const { values } = parseArgs({
  options: {
    workspace: { type: 'string' },
    to: { type: 'string' },
    limit: { type: 'string' },
    ids: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'retire-keep': { type: 'string' },
    'from-split': { type: 'string' },
    summary: { type: 'boolean', default: false },
  },
});

const workspaceId = values.workspace;
if (!workspaceId) {
  console.error('--workspace <uuid> is required');
  process.exit(2);
}

const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('APP_DATABASE_URL or DATABASE_URL is required');
  process.exit(2);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

function parseSplit(value: string | undefined, flag: string): GoldenLabelSplit {
  if (!value || !(GOLDEN_LABEL_SPLITS as readonly string[]).includes(value)) {
    console.error(`${flag} must be one of ${GOLDEN_LABEL_SPLITS.join('|')}`);
    process.exit(2);
  }
  return value as GoldenLabelSplit;
}

async function main(): Promise<void> {
  if (values.summary) {
    const rows = await goldenLabelSummary(prisma, workspaceId!);
    console.log(JSON.stringify({ workspace: workspaceId, summary: rows }, null, 2));
    return;
  }

  if (values['retire-keep'] !== undefined) {
    const keep = Number(values['retire-keep']);
    if (!Number.isInteger(keep) || keep < 0) {
      console.error('--retire-keep must be a non-negative integer');
      process.exit(2);
    }
    const fromSplit = parseSplit(values['from-split'] ?? 'test', '--from-split');
    if (fromSplit === 'candidate' || fromSplit === 'retired') {
      console.error('--from-split must be calib or test');
      process.exit(2);
    }
    const result = await retireGoldenLabels(prisma, {
      workspaceId: workspaceId!,
      split: fromSplit as 'calib' | 'test',
      keep,
      dryRun: values['dry-run'],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const to = parseSplit(values.to, '--to');
  if (to === 'candidate') {
    console.error('--to must be calib|test|retired');
    process.exit(2);
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error('--limit must be a positive integer');
    process.exit(2);
  }
  const result = await promoteGoldenLabels(prisma, {
    workspaceId: workspaceId!,
    to,
    limit,
    ids: values.ids ? values.ids.split(',').map((id) => id.trim()).filter(Boolean) : undefined,
    dryRun: values['dry-run'],
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
