import 'dotenv/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { DoclingClient } from '../src/site-builder/docling.client';
import { EmbeddingsClient } from '../src/site-builder/embeddings.client';
import { KbService } from '../src/site-builder/kb.service';
import { StorageService } from '../src/site-builder/storage.service';

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const [workspaceId, siteId, assetId] = positional;
if (!workspaceId || !siteId || !assetId) {
  throw new Error(
    'usage: node --import tsx scripts/redrive-site-builder-kb.mts <workspaceId> <siteId> <assetId> [--include-terminal] [--process-now]',
  );
}

const prisma = new PrismaService();
await prisma.$connect();
try {
  const kb = new KbService(
    prisma,
    new EmbeddingsClient(),
    new DoclingClient(),
    new StorageService(),
  );
  const ctx = { userId: 'kb-redrive', workspaceId, roles: ['system'] };
  const moved = await kb.redriveAsset(ctx, siteId, assetId, {
    includeTerminal: process.argv.includes('--include-terminal'),
  });
  if (!moved) throw new Error('asset is not eligible for KB redrive in this workspace/site');
  if (process.argv.includes('--process-now')) {
    console.log(JSON.stringify(await kb.processAsset(ctx, siteId, assetId), null, 2));
  } else {
    console.log(JSON.stringify({ assetId, redriven: true, dueForSweep: true }, null, 2));
  }
} finally {
  await prisma.$disconnect();
}
