/**
 * R2-A2 KB correctness verification against real Ubuntu development services.
 * PostgreSQL app_user/RLS + MinIO + Docling + BGE-M3 are real; timing gates only
 * pause workers to deterministically create concurrency/takeover windows.
 *
 * Run:
 *   DOTENV_CONFIG_PATH=/global/backend/apps/api/.env \
 *   node --import tsx scripts/verify-site-builder-kb-r2.mts
 */
import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AssetsService } from '../src/site-builder/assets.service';
import { DoclingClient } from '../src/site-builder/docling.client';
import { EmbeddingsClient } from '../src/site-builder/embeddings.client';
import { KbService } from '../src/site-builder/kb.service';
import { StorageService } from '../src/site-builder/storage.service';
import { createSiteBuilderActivities } from '../src/temporal/site-builder.activities';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ok(section: string, message: string): void {
  console.log(`  ✅ ${section} ${message}`);
}

function makeProbePdf(text: string): Buffer {
  const stream = Buffer.from(`BT /F1 11 Tf 50 740 Td (${text}) Tj ET`);
  const objs = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  let buf = Buffer.from('%PDF-1.4\n');
  const offsets: number[] = [];
  objs.forEach((obj, index) => {
    offsets.push(buf.length);
    buf = Buffer.concat([
      buf,
      Buffer.from(`${index + 1} 0 obj\n`),
      obj,
      Buffer.from('\nendobj\n'),
    ]);
  });
  const xref = buf.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.concat([buf, Buffer.from(tail)]);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL are required');
  }
  const appDb = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const storage = new StorageService();
  const embeddings = new EmbeddingsClient();
  const docling = new DoclingClient();
  await Promise.all([appDb.$connect(), owner.$connect()]);
  await storage.onModuleInit();

  const wsA = randomUUID();
  const wsB = randomUUID();
  const siteA = randomUUID();
  const siteB = randomUUID();
  const ctxA = { userId: 'verify-kb-r2', workspaceId: wsA, roles: [] };
  const ctxB = { userId: 'verify-kb-r2-other', workspaceId: wsB, roles: [] };
  const touchedKeys = new Set<string>();
  const baseKb = new KbService(appDb, embeddings, docling, storage);
  const assets = new AssetsService(appDb, storage);

  async function uploadDoc(
    filename: string,
    mime: string,
    body: Buffer,
  ): Promise<{ id: string; objectKey: string }> {
    const signed = await assets.presign(ctxA, siteA, {
      kind: 'doc',
      filename,
      size: body.length,
      mime,
    });
    const staging = await appDb.withWorkspace(wsA, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: signed.assetId } }),
    );
    touchedKeys.add(staging.objectKey);
    const put = await fetch(signed.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': mime },
      body,
    });
    if (!put.ok) throw new Error(`presigned PUT ${filename}: HTTP ${put.status}`);
    const committed = await assets.commit(ctxA, signed.assetId);
    if (committed.processingStatus !== 'queued' || !committed.contentHash) {
      throw new Error(`${filename} did not commit to KB queue`);
    }
    touchedKeys.add(committed.objectKey);
    return { id: committed.id, objectKey: committed.objectKey };
  }

  try {
    const role = await appDb.$queryRaw<{ current_user: string; is_superuser: string }[]>`
      SELECT current_user, current_setting('is_superuser') AS is_superuser`;
    if (role[0]?.is_superuser === 'on') throw new Error('app connection is superuser');
    ok('RLS guard', `${role[0]?.current_user} is non-superuser`);

    await owner.workspace.createMany({
      data: [
        { id: wsA, name: 'R2-A2 KB verify A' },
        { id: wsB, name: 'R2-A2 KB verify B' },
      ],
    });
    await appDb.withWorkspace(wsA, (tx) =>
      tx.site.create({
        data: { id: siteA, workspaceId: wsA, name: 'KB Verify A', slug: `kb-a-${randomUUID()}`, intake: {} },
      }),
    );
    await appDb.withWorkspace(wsB, (tx) =>
      tx.site.create({
        data: { id: siteB, workspaceId: wsB, name: 'KB Verify B', slug: `kb-b-${randomUUID()}`, intake: {} },
      }),
    );

    console.log('① 真 PDF → MinIO → Docling → BGE-M3 → PostgreSQL');
    const pdf = await uploadDoc(
      'pump-catalog.pdf',
      'application/pdf',
      makeProbePdf('Industrial centrifugal pump catalog for chemical and water applications'),
    );
    const pdfResult = await baseKb.processAsset(ctxA, siteA, pdf.id);
    if (pdfResult.outcome !== 'ready') throw new Error(`PDF outcome ${pdfResult.outcome}`);
    const pdfRows = await appDb.withWorkspace(wsA, async (tx) => {
      const doc = await tx.kbDocument.findUniqueOrThrow({ where: { assetId: pdf.id } });
      return { doc, chunks: await tx.kbChunk.count({ where: { documentId: doc.id } }) };
    });
    if (pdfRows.doc.chunkCount < 1 || pdfRows.chunks !== pdfRows.doc.chunkCount) {
      throw new Error(`PDF chunk mismatch: ${JSON.stringify(pdfRows)}`);
    }
    const hits = await baseKb.search(ctxA, siteA, 'centrifugal pump', 3);
    if (hits.length < 1) throw new Error('semantic search returned no hit');
    const otherSurface = await Promise.all([
      appDb.withWorkspace(wsB, (tx) => tx.asset.count({ where: { id: pdf.id } })),
      appDb.withWorkspace(wsB, (tx) => tx.kbDocument.count({ where: { assetId: pdf.id } })),
      baseKb.search(ctxB, siteB, 'centrifugal pump', 3),
    ]);
    if (otherSurface[0] !== 0 || otherSurface[1] !== 0 || otherSurface[2].length !== 0) {
      throw new Error('cross-workspace KB visibility detected');
    }
    ok('real chain', `${pdfRows.chunks} chunks, semantic hit, cross-workspace surface=0`);

    console.log('② 双 worker claim + active delete 409');
    const concurrent = await uploadDoc(
      'concurrent.md',
      'text/markdown',
      Buffer.from('# Pump\n\nConcurrent fenced ingestion for an industrial pump catalog.'),
    );
    const atGet = deferred<void>();
    const releaseGet = deferred<void>();
    let getCalls = 0;
    const gatedStorage = Object.create(storage) as StorageService;
    gatedStorage.getBuffer = async (key: string) => {
      getCalls += 1;
      atGet.resolve();
      await releaseGet.promise;
      return storage.getBuffer(key);
    };
    const gatedKb = new KbService(appDb, embeddings, docling, gatedStorage);
    const first = gatedKb.processAsset(ctxA, siteA, concurrent.id);
    await atGet.promise;
    const loser = await baseKb.processAsset(ctxA, siteA, concurrent.id);
    if (loser.outcome !== 'not_due' || getCalls !== 1) throw new Error('claim loser reached storage');
    try {
      await assets.remove(ctxA, concurrent.id);
      throw new Error('delete during active KB lease succeeded');
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
    }
    releaseGet.resolve();
    if ((await first).outcome !== 'ready') throw new Error('claim winner did not finish ready');
    ok('claim', 'one storage reader; concurrent worker skipped; active delete rejected');

    console.log('③ expired takeover + old worker zombie fence');
    const zombie = await uploadDoc(
      'zombie.md',
      'text/markdown',
      Buffer.from('# Valve\n\nLease takeover proof for industrial valve documentation.'),
    );
    const committedAttempt = await appDb.withWorkspace(wsA, async (tx) =>
      (await tx.asset.findUniqueOrThrow({ where: { id: zombie.id } })).processingAttempt,
    );
    const oldEmbedded = deferred<void>();
    const releaseOld = deferred<void>();
    const gatedEmbeddings = Object.create(embeddings) as EmbeddingsClient;
    gatedEmbeddings.embed = async (texts: string[]) => {
      const vectors = await embeddings.embed(texts);
      oldEmbedded.resolve();
      await releaseOld.promise;
      return vectors;
    };
    const oldKb = new KbService(appDb, gatedEmbeddings, docling, storage);
    const oldWorker = oldKb.processAsset(ctxA, siteA, zombie.id);
    await oldEmbedded.promise;
    await appDb.withWorkspace(wsA, (tx) =>
      tx.asset.update({ where: { id: zombie.id }, data: { leaseUntil: new Date(0) } }),
    );
    const takeover = await baseKb.processAsset(ctxA, siteA, zombie.id);
    releaseOld.resolve();
    const stale = await oldWorker;
    const zombieRows = await appDb.withWorkspace(wsA, async (tx) => ({
      asset: await tx.asset.findUniqueOrThrow({ where: { id: zombie.id } }),
      docs: await tx.kbDocument.count({ where: { assetId: zombie.id } }),
    }));
    if (
      takeover.outcome !== 'ready' ||
      stale.outcome !== 'superseded' ||
      zombieRows.asset.processingAttempt !== committedAttempt + 2 ||
      zombieRows.docs !== 1
    ) {
      throw new Error(`takeover/zombie failure: ${JSON.stringify({ takeover, stale, zombieRows })}`);
    }
    ok('fencing', 'attempt 2 won; attempt 1 could not rewrite document or Asset');

    console.log('④ typed transient → due queue → manual redrive');
    const retry = await uploadDoc(
      'retry.md',
      'text/markdown',
      Buffer.from('# Retry\n\nCanonical object remains available across retry.'),
    );
    const unavailableStorage = Object.create(storage) as StorageService;
    unavailableStorage.getBuffer = async () => {
      throw new Error('injected MinIO transport outage with arbitrary wording');
    };
    const retryKb = new KbService(appDb, embeddings, docling, unavailableStorage);
    const failed = await retryKb.processAsset(ctxA, siteA, retry.id);
    const retryRow = await appDb.withWorkspace(wsA, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: retry.id } }),
    );
    if (
      failed.outcome !== 'retry_scheduled' ||
      retryRow.processingStatus !== 'queued' ||
      retryRow.processingErrorCode !== 'KB_STORAGE_UNAVAILABLE' ||
      !retryRow.retryAt ||
      !(await storage.head(retry.objectKey))
    ) {
      throw new Error(`typed retry truth invalid: ${JSON.stringify({ failed, retryRow })}`);
    }
    if (!(await baseKb.redriveAsset(ctxA, siteA, retry.id))) throw new Error('manual redrive rejected');
    if ((await baseKb.processAsset(ctxA, siteA, retry.id)).outcome !== 'ready') {
      throw new Error('redriven asset did not recover');
    }
    ok('retry/redrive', 'typed code persisted, canonical retained, second attempt ready');

    console.log('⑤ 真损坏 PDF → failed_terminal（无 retry）');
    const corrupt = await uploadDoc(
      'corrupt.pdf',
      'application/pdf',
      Buffer.from('%PDF-1.4\nbroken'),
    );
    const corruptResult = await baseKb.processAsset(ctxA, siteA, corrupt.id);
    const corruptRows = await appDb.withWorkspace(wsA, async (tx) => ({
      asset: await tx.asset.findUniqueOrThrow({ where: { id: corrupt.id } }),
      docs: await tx.kbDocument.count({ where: { assetId: corrupt.id } }),
    }));
    if (
      corruptResult.outcome !== 'failed_terminal' ||
      corruptResult.errorCode !== 'KB_DOCUMENT_INVALID' ||
      corruptRows.asset.processingStatus !== 'failed_terminal' ||
      corruptRows.asset.retryAt !== null ||
      corruptRows.docs !== 0
    ) {
      throw new Error(`corrupt PDF classification invalid: ${JSON.stringify({ corruptResult, corruptRows })}`);
    }
    ok('terminal', 'Docling failure status became KB_DOCUMENT_INVALID; no retry/doc rows');

    console.log('⑥ recovery scan without launch + uniqueness/FK');
    const stranded = await uploadDoc(
      'stranded.md',
      'text/markdown',
      Buffer.from('# Stranded\n\nNo launch: recovery scanner must find this canonical doc.'),
    );
    const recoveryActivities = createSiteBuilderActivities({ prisma: appDb, ownerDb: owner, kb: baseKb });
    const candidates = await recoveryActivities.listKbRecoveryCandidates({ limit: 100 });
    if (!candidates.some((candidate) => candidate.assetId === stranded.id)) {
      throw new Error('stranded queued asset not found by recovery scan');
    }
    if (
      (await recoveryActivities.processKbAsset({ workspaceId: wsA, siteId: siteA, assetId: stranded.id }))
        .outcome !== 'ready'
    ) {
      throw new Error('recovery candidate did not finish');
    }
    try {
      await appDb.withWorkspace(wsA, (tx) =>
        tx.kbDocument.create({
          data: {
            workspaceId: wsA,
            siteId: siteA,
            assetId: stranded.id,
            source: 'upload',
            title: 'duplicate',
            status: 'ready',
          },
        }),
      );
      throw new Error('duplicate KbDocument unexpectedly inserted');
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
    const foreignAsset = await appDb.withWorkspace(wsB, (tx) =>
      tx.asset.create({
        data: {
          id: randomUUID(),
          workspaceId: wsB,
          siteId: siteB,
          kind: 'doc',
          filename: 'foreign.md',
          mime: 'text/markdown',
          sizeBytes: 10,
          objectKey: `ws/${wsB}/${siteB}/doc/foreign.md`,
          contentHash: 'f'.repeat(64),
          processingStatus: 'queued',
        },
      }),
    );
    try {
      await appDb.withWorkspace(wsA, (tx) =>
        tx.kbDocument.create({
          data: {
            workspaceId: wsA,
            siteId: siteA,
            assetId: foreignAsset.id,
            source: 'upload',
            title: 'cross scope',
            status: 'ready',
          },
        }),
      );
      throw new Error('cross-scope Asset provenance unexpectedly inserted');
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2003') throw err;
    }
    ok('recovery/constraints', 'stranded row recovered; nullable unique and composite FK enforced');

    console.log('⑦ tombstone deletes KB search surface in one transaction');
    await assets.remove(ctxA, pdf.id);
    const deletedSurface = await appDb.withWorkspace(wsA, async (tx) => ({
      docs: await tx.kbDocument.count({ where: { assetId: pdf.id } }),
      chunks: await tx.kbChunk.count({ where: { documentId: pdfRows.doc.id } }),
    }));
    if (deletedSurface.docs !== 0 || deletedSurface.chunks !== 0) {
      throw new Error(`KB cascade failed: ${JSON.stringify(deletedSurface)}`);
    }
    ok('delete', 'document and chunks removed; canonical object remains parked for A4/MF-0');
  } finally {
    for (const key of touchedKeys) await storage.delete(key).catch(() => undefined);
    await owner.site.deleteMany({ where: { id: { in: [siteA, siteB] } } }).catch(() => undefined);
    await owner.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } }).catch(() => undefined);
    await Promise.all([appDb.$disconnect(), owner.$disconnect()]);
  }
}

main().catch((err) => {
  console.error('💥 R2-A2 KB verification failed:', err);
  process.exitCode = 1;
});
