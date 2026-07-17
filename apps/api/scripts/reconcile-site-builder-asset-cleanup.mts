import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SiteSpecAssetReferenceScanner } from '../src/site-builder/site-spec-asset-reference-scanner';
import { reconcileParkedCanonicalCleanups } from '../src/temporal/asset-cleanup.reconcile';

const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const cursorArg = process.argv.find((arg) => arg.startsWith('--after-id='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 100;
const afterId = cursorArg ? BigInt(cursorArg.slice('--after-id='.length)) : undefined;
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  throw new Error('--limit must be an integer from 1 to 500');
}

const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const prisma = new PrismaService();
await Promise.all([ownerDb.$connect(), prisma.$connect()]);
try {
  const result = await reconcileParkedCanonicalCleanups(
    { ownerDb, prisma, scanner: new SiteSpecAssetReferenceScanner() },
    { apply, limit, afterId },
  );
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry_run', ...result }, null, 2));
} finally {
  await Promise.all([ownerDb.$disconnect(), prisma.$disconnect()]);
}
