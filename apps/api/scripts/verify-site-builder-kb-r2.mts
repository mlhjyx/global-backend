/**
 * R2-A2 KB correctness verification against real Ubuntu development services.
 * PostgreSQL app_user/RLS + MinIO + Docling + BGE-M3 are real; timing gates only
 * pause workers to deterministically create concurrency/takeover windows.
 *
 * Run:
 *   ALLOW_DEV_DB_VERIFIER=true DOTENV_CONFIG_PATH=/global/backend/apps/api/.env \
 *   node --import tsx scripts/verify-site-builder-kb-r2.mts
 */
import "dotenv/config";
import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { AssetsService } from "../src/site-builder/assets.service";
import { DoclingClient } from "../src/site-builder/docling.client";
import { EmbeddingsClient } from "../src/site-builder/embeddings.client";
import { KbService } from "../src/site-builder/kb.service";
import { buildObjectKey, extForMime } from "../src/site-builder/object-key";
import { StorageService } from "../src/site-builder/storage.service";
import { createSiteBuilderActivities } from "../src/temporal/site-builder.activities";
import { KB_RECOVERY_SWEEP_SCHEDULE_ID } from "../src/temporal/understanding.constants";

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

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}

function requireExplicitDevelopmentTargets(): void {
  if (
    process.env.ALLOW_DEV_DB_VERIFIER !== "true" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "refusing KB verifier: require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV",
    );
  }
  const databaseUrls = [process.env.DATABASE_URL, process.env.APP_DATABASE_URL];
  for (const raw of databaseUrls) {
    if (!raw) throw new Error("DATABASE_URL and APP_DATABASE_URL are required");
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname) || url.pathname !== "/global_dev") {
      throw new Error(
        `refusing KB verifier database target: expected loopback/global_dev, got ${url.hostname}${url.pathname}`,
      );
    }
  }
  for (const [name, raw] of [
    ["S3_ENDPOINT", process.env.S3_ENDPOINT ?? "http://localhost:9000"],
    ["DOCLING_URL", process.env.DOCLING_URL ?? "http://localhost:5001"],
    [
      "EMBEDDINGS_URL",
      process.env.EMBEDDINGS_URL ??
        process.env.MODEL_GATEWAY_URL ??
        "http://localhost:3001/v1",
    ],
  ] as const) {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(
        `refusing KB verifier ${name}: endpoint must be loopback`,
      );
    }
  }
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const temporalUrl = new URL(
    temporalAddress.includes("://")
      ? temporalAddress
      : `grpc://${temporalAddress}`,
  );
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  if (
    !isLoopbackHost(temporalUrl.hostname) ||
    temporalUrl.port !== "7233" ||
    temporalNamespace !== "default"
  ) {
    throw new Error(
      "refusing KB verifier Temporal target: require loopback:7233 and default development namespace",
    );
  }
}

async function isolateRecoverySchedule(): Promise<() => Promise<void>> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });
  const handle = client.schedule.getHandle(KB_RECOVERY_SWEEP_SCHEDULE_ID);
  let pausedByVerifier = false;
  let originalNote: string | undefined;
  try {
    const before = await handle.describe();
    originalNote = before.state.note;
    if (!before.state.paused) {
      await handle.pause("temporarily paused by R2-A2 development verifier");
      pausedByVerifier = true;
    }
    const isolated = await handle.describe();
    if (isolated.info.runningActions.length > 0) {
      throw new Error(
        "KB recovery workflow is already running; wait for it before verifier",
      );
    }
    ok(
      "schedule isolation",
      pausedByVerifier
        ? "recovery paused temporarily"
        : "recovery already paused",
    );
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) {
      return async () => connection.close();
    }
    if (pausedByVerifier)
      await handle.unpause(originalNote).catch(() => undefined);
    await connection.close();
    throw err;
  }
  return async () => {
    try {
      if (pausedByVerifier) await handle.unpause(originalNote);
    } finally {
      await connection.close();
    }
  };
}

function makeProbePdf(text: string): Buffer {
  const stream = Buffer.from(`BT /F1 11 Tf 50 740 Td (${text}) Tj ET`);
  const objs = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
      stream,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  let buf = Buffer.from("%PDF-1.4\n");
  const offsets: number[] = [];
  objs.forEach((obj, index) => {
    offsets.push(buf.length);
    buf = Buffer.concat([
      buf,
      Buffer.from(`${index + 1} 0 obj\n`),
      obj,
      Buffer.from("\nendobj\n"),
    ]);
  });
  const xref = buf.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.concat([buf, Buffer.from(tail)]);
}

async function main(): Promise<void> {
  requireExplicitDevelopmentTargets();
  const restoreRecoverySchedule = await isolateRecoverySchedule();
  const appDb = new PrismaService();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const storage = new StorageService();
  const embeddings = new EmbeddingsClient();
  const docling = new DoclingClient();
  const wsA = randomUUID();
  const wsB = randomUUID();
  const siteA = randomUUID();
  const siteB = randomUUID();
  const ctxA = { userId: "verify-kb-r2", workspaceId: wsA, roles: [] };
  const ctxB = { userId: "verify-kb-r2-other", workspaceId: wsB, roles: [] };
  const touchedKeys = new Set<string>();
  const baseKb = new KbService(appDb, embeddings, docling, storage);
  const assets = new AssetsService(appDb, storage);
  let verificationError: unknown;

  async function uploadDoc(
    filename: string,
    mime: string,
    body: Buffer,
  ): Promise<{ id: string; objectKey: string }> {
    const signed = await assets.presign(ctxA, siteA, {
      kind: "doc",
      filename,
      size: body.length,
      mime,
    });
    const staging = await appDb.withWorkspace(wsA, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: signed.assetId } }),
    );
    touchedKeys.add(staging.objectKey);
    const ext = extForMime(mime);
    if (!ext) throw new Error(`unsupported verifier mime: ${mime}`);
    // commit 的 canonical key 由 body hash 确定；在 copy 之前预登记，覆盖
    // “copy 已成功但 DB fenced 回写/返回前失败”的对象清理窗口。
    touchedKeys.add(
      buildObjectKey(
        wsA,
        siteA,
        "doc",
        createHash("sha256").update(body).digest("hex"),
        ext,
      ),
    );
    const put = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "content-type": mime },
      body,
    });
    if (!put.ok)
      throw new Error(`presigned PUT ${filename}: HTTP ${put.status}`);
    const committed = await assets.commit(ctxA, signed.assetId);
    if (committed.processingStatus !== "queued" || !committed.contentHash) {
      throw new Error(`${filename} did not commit to KB queue`);
    }
    touchedKeys.add(committed.objectKey);
    return { id: committed.id, objectKey: committed.objectKey };
  }

  try {
    await Promise.all([appDb.$connect(), owner.$connect()]);
    await storage.onModuleInit();
    const role = await appDb.$queryRaw<
      { current_user: string; is_superuser: string }[]
    >`
      SELECT current_user, current_setting('is_superuser') AS is_superuser`;
    if (role[0]?.is_superuser === "on")
      throw new Error("app connection is superuser");
    ok("RLS guard", `${role[0]?.current_user} is non-superuser`);

    await owner.workspace.createMany({
      data: [
        { id: wsA, name: "R2-A2 KB verify A" },
        { id: wsB, name: "R2-A2 KB verify B" },
      ],
    });
    await appDb.withWorkspace(wsA, (tx) =>
      tx.site.create({
        data: {
          id: siteA,
          workspaceId: wsA,
          name: "KB Verify A",
          slug: `kb-a-${randomUUID()}`,
          intake: {},
        },
      }),
    );
    await appDb.withWorkspace(wsB, (tx) =>
      tx.site.create({
        data: {
          id: siteB,
          workspaceId: wsB,
          name: "KB Verify B",
          slug: `kb-b-${randomUUID()}`,
          intake: {},
        },
      }),
    );

    console.log("① 真 PDF → MinIO → Docling → BGE-M3 → PostgreSQL");
    const pdf = await uploadDoc(
      "pump-catalog.pdf",
      "application/pdf",
      makeProbePdf(
        "Industrial centrifugal pump catalog for chemical and water applications",
      ),
    );
    const pdfResult = await baseKb.processAsset(ctxA, siteA, pdf.id);
    if (pdfResult.outcome !== "ready")
      throw new Error(`PDF outcome ${pdfResult.outcome}`);
    const pdfRows = await appDb.withWorkspace(wsA, async (tx) => {
      const doc = await tx.kbDocument.findUniqueOrThrow({
        where: { assetId: pdf.id },
      });
      return {
        doc,
        chunks: await tx.kbChunk.count({ where: { documentId: doc.id } }),
      };
    });
    if (
      pdfRows.doc.chunkCount < 1 ||
      pdfRows.chunks !== pdfRows.doc.chunkCount
    ) {
      throw new Error(`PDF chunk mismatch: ${JSON.stringify(pdfRows)}`);
    }
    const hits = await baseKb.search(ctxA, siteA, "centrifugal pump", 3);
    if (hits.length < 1) throw new Error("semantic search returned no hit");
    const otherSurface = await Promise.all([
      appDb.withWorkspace(wsB, (tx) =>
        tx.asset.count({ where: { id: pdf.id } }),
      ),
      appDb.withWorkspace(wsB, (tx) =>
        tx.kbDocument.count({ where: { assetId: pdf.id } }),
      ),
      baseKb.search(ctxB, siteB, "centrifugal pump", 3),
    ]);
    if (
      otherSurface[0] !== 0 ||
      otherSurface[1] !== 0 ||
      otherSurface[2].length !== 0
    ) {
      throw new Error("cross-workspace KB visibility detected");
    }
    ok(
      "real chain",
      `${pdfRows.chunks} chunks, semantic hit, cross-workspace surface=0`,
    );

    console.log("② 双 worker claim + active delete 409");
    const concurrent = await uploadDoc(
      "concurrent.md",
      "text/markdown",
      Buffer.from(
        "# Pump\n\nConcurrent fenced ingestion for an industrial pump catalog.",
      ),
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
    if (loser.outcome !== "not_due" || getCalls !== 1)
      throw new Error("claim loser reached storage");
    try {
      await assets.remove(ctxA, concurrent.id);
      throw new Error("delete during active KB lease succeeded");
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
    }
    releaseGet.resolve();
    if ((await first).outcome !== "ready")
      throw new Error("claim winner did not finish ready");
    ok(
      "claim",
      "one storage reader; concurrent worker skipped; active delete rejected",
    );

    console.log("③ expired takeover + old worker zombie fence");
    const zombie = await uploadDoc(
      "zombie.md",
      "text/markdown",
      Buffer.from(
        "# Valve\n\nLease takeover proof for industrial valve documentation.",
      ),
    );
    const committedAttempt = await appDb.withWorkspace(
      wsA,
      async (tx) =>
        (await tx.asset.findUniqueOrThrow({ where: { id: zombie.id } }))
          .processingAttempt,
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
      tx.asset.update({
        where: { id: zombie.id },
        data: { leaseUntil: new Date(0) },
      }),
    );
    const takeover = await baseKb.processAsset(ctxA, siteA, zombie.id);
    releaseOld.resolve();
    const stale = await oldWorker;
    const zombieRows = await appDb.withWorkspace(wsA, async (tx) => ({
      asset: await tx.asset.findUniqueOrThrow({ where: { id: zombie.id } }),
      docs: await tx.kbDocument.count({ where: { assetId: zombie.id } }),
    }));
    if (
      takeover.outcome !== "ready" ||
      stale.outcome !== "superseded" ||
      zombieRows.asset.processingAttempt !== committedAttempt + 2 ||
      zombieRows.docs !== 1
    ) {
      throw new Error(
        `takeover/zombie failure: ${JSON.stringify({ takeover, stale, zombieRows })}`,
      );
    }
    ok(
      "fencing",
      "attempt 2 won; attempt 1 could not rewrite document or Asset",
    );

    console.log("④ typed transient → due queue → manual redrive");
    const retry = await uploadDoc(
      "retry.md",
      "text/markdown",
      Buffer.from(
        "# Retry\n\nCanonical object remains available across retry.",
      ),
    );
    const unavailableStorage = Object.create(storage) as StorageService;
    unavailableStorage.getBuffer = async () => {
      throw new Error("injected MinIO transport outage with arbitrary wording");
    };
    const retryKb = new KbService(
      appDb,
      embeddings,
      docling,
      unavailableStorage,
    );
    const failed = await retryKb.processAsset(ctxA, siteA, retry.id);
    const retryRow = await appDb.withWorkspace(wsA, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: retry.id } }),
    );
    if (
      failed.outcome !== "retry_scheduled" ||
      retryRow.processingStatus !== "queued" ||
      retryRow.processingErrorCode !== "KB_STORAGE_UNAVAILABLE" ||
      !retryRow.retryAt ||
      !(await storage.head(retry.objectKey))
    ) {
      throw new Error(
        `typed retry truth invalid: ${JSON.stringify({ failed, retryRow })}`,
      );
    }
    if (!(await baseKb.redriveAsset(ctxA, siteA, retry.id)))
      throw new Error("manual redrive rejected");
    if (
      (await baseKb.processAsset(ctxA, siteA, retry.id)).outcome !== "ready"
    ) {
      throw new Error("redriven asset did not recover");
    }
    ok(
      "retry/redrive",
      "typed code persisted, canonical retained, second attempt ready",
    );

    console.log("⑤ 真损坏 PDF → failed_terminal（无 retry）");
    const corrupt = await uploadDoc(
      "corrupt.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.4\nbroken"),
    );
    const corruptResult = await baseKb.processAsset(ctxA, siteA, corrupt.id);
    const corruptRows = await appDb.withWorkspace(wsA, async (tx) => ({
      asset: await tx.asset.findUniqueOrThrow({ where: { id: corrupt.id } }),
      docs: await tx.kbDocument.count({ where: { assetId: corrupt.id } }),
    }));
    if (
      corruptResult.outcome !== "failed_terminal" ||
      corruptResult.errorCode !== "KB_DOCUMENT_INVALID" ||
      corruptRows.asset.processingStatus !== "failed_terminal" ||
      corruptRows.asset.retryAt !== null ||
      corruptRows.docs !== 0
    ) {
      throw new Error(
        `corrupt PDF classification invalid: ${JSON.stringify({ corruptResult, corruptRows })}`,
      );
    }
    ok(
      "terminal",
      "Docling failure status became KB_DOCUMENT_INVALID; no retry/doc rows",
    );

    console.log("⑥ recovery scan without launch + uniqueness/FK");
    const stranded = await uploadDoc(
      "stranded.md",
      "text/markdown",
      Buffer.from(
        "# Stranded\n\nNo launch: recovery scanner must find this canonical doc.",
      ),
    );
    const recoveryActivities = createSiteBuilderActivities({
      prisma: appDb,
      ownerDb: owner,
      kb: baseKb,
    });
    const candidates = await recoveryActivities.listKbRecoveryCandidates({
      limit: 100,
    });
    if (!candidates.some((candidate) => candidate.assetId === stranded.id)) {
      throw new Error("stranded queued asset not found by recovery scan");
    }
    if (
      (
        await recoveryActivities.processKbAsset({
          workspaceId: wsA,
          siteId: siteA,
          assetId: stranded.id,
        })
      ).outcome !== "ready"
    ) {
      throw new Error("recovery candidate did not finish");
    }
    try {
      await appDb.withWorkspace(wsA, (tx) =>
        tx.kbDocument.create({
          data: {
            workspaceId: wsA,
            siteId: siteA,
            assetId: stranded.id,
            source: "upload",
            title: "duplicate",
            status: "ready",
          },
        }),
      );
      throw new Error("duplicate KbDocument unexpectedly inserted");
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
    const foreignAsset = await appDb.withWorkspace(wsB, (tx) =>
      tx.asset.create({
        data: {
          id: randomUUID(),
          workspaceId: wsB,
          siteId: siteB,
          kind: "doc",
          filename: "foreign.md",
          mime: "text/markdown",
          sizeBytes: 10,
          objectKey: `ws/${wsB}/${siteB}/doc/foreign.md`,
          contentHash: "f".repeat(64),
          processingStatus: "queued",
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
            source: "upload",
            title: "cross scope",
            status: "ready",
          },
        }),
      );
      throw new Error("cross-scope Asset provenance unexpectedly inserted");
    } catch (err) {
      if ((err as { code?: string }).code !== "P2003") throw err;
    }
    ok(
      "recovery/constraints",
      "stranded row recovered; nullable unique and composite FK enforced",
    );

    console.log("⑦ tombstone deletes KB search surface in one transaction");
    await assets.remove(ctxA, pdf.id);
    const deletedSurface = await appDb.withWorkspace(wsA, async (tx) => ({
      docs: await tx.kbDocument.count({ where: { assetId: pdf.id } }),
      chunks: await tx.kbChunk.count({ where: { documentId: pdfRows.doc.id } }),
    }));
    if (deletedSurface.docs !== 0 || deletedSurface.chunks !== 0) {
      throw new Error(`KB cascade failed: ${JSON.stringify(deletedSurface)}`);
    }
    ok(
      "delete",
      "document and chunks removed; canonical object queued for MF0-B async cleanup",
    );
  } catch (err) {
    verificationError = err;
  } finally {
    const cleanupErrors: unknown[] = [];
    const workspaceIds = [wsA, wsB];

    // 先删除数据库真值，确认引用面归零后，才允许删除对象；反向顺序会制造 DB→对象悬空。
    try {
      await owner.site.deleteMany({ where: { id: { in: [siteA, siteB] } } });
      await owner.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    } catch (err) {
      cleanupErrors.push(
        new Error(`database cleanup failed: ${String(err)}`, { cause: err }),
      );
    }

    let ownerCounts:
      | {
          workspaces: number;
          sites: number;
          assets: number;
          documents: number;
          chunks: number;
        }
      | undefined;
    try {
      const [workspaces, sites, assetsCount, documents, chunks] =
        await Promise.all([
          owner.workspace.count({ where: { id: { in: workspaceIds } } }),
          owner.site.count({ where: { workspaceId: { in: workspaceIds } } }),
          owner.asset.count({ where: { workspaceId: { in: workspaceIds } } }),
          owner.kbDocument.count({
            where: { workspaceId: { in: workspaceIds } },
          }),
          owner.kbChunk.count({ where: { workspaceId: { in: workspaceIds } } }),
        ]);
      ownerCounts = {
        workspaces,
        sites,
        assets: assetsCount,
        documents,
        chunks,
      };
      if (Object.values(ownerCounts).some((count) => count !== 0)) {
        cleanupErrors.push(
          new Error(
            `database fixture residue remains: ${JSON.stringify(ownerCounts)}`,
          ),
        );
      }
    } catch (err) {
      cleanupErrors.push(
        new Error(`database residue verification failed: ${String(err)}`, {
          cause: err,
        }),
      );
    }

    // 若数据库未清干净，保留对象比删除对象更安全，且验证必须失败为非零退出。
    const databaseCleanupSucceeded = cleanupErrors.length === 0;
    if (databaseCleanupSucceeded) {
      for (const key of touchedKeys) {
        try {
          await storage.delete(key);
        } catch (err) {
          cleanupErrors.push(
            new Error(`object cleanup failed for ${key}: ${String(err)}`, {
              cause: err,
            }),
          );
        }
      }
    }
    // 无论前面的清理是否成功，都实际探测对象面；失败时保留对象但仍明确报残留。
    for (const key of touchedKeys) {
      try {
        if (await storage.head(key)) {
          cleanupErrors.push(
            new Error(
              databaseCleanupSucceeded
                ? `object residue remains after cleanup: ${key}`
                : `object deliberately preserved because database cleanup failed: ${key}`,
            ),
          );
        }
      } catch (err) {
        cleanupErrors.push(
          new Error(
            `object residue verification failed for ${key}: ${String(err)}`,
            { cause: err },
          ),
        );
      }
    }

    try {
      await Promise.all([appDb.$disconnect(), owner.$disconnect()]);
    } catch (err) {
      cleanupErrors.push(
        new Error(`database disconnect failed: ${String(err)}`, { cause: err }),
      );
    }

    try {
      await restoreRecoverySchedule();
    } catch (err) {
      cleanupErrors.push(
        new Error(`recovery Schedule restore failed: ${String(err)}`, {
          cause: err,
        }),
      );
    }

    const failures = [verificationError, ...cleanupErrors].filter(
      (failure): failure is NonNullable<typeof failure> =>
        failure !== undefined,
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "R2-A2 verification and/or cleanup failed",
      );
    }
    ok(
      "cleanup",
      `owner residue=${JSON.stringify(ownerCounts)}; object residue=0/${touchedKeys.size}`,
    );
  }
}

main().catch((err) => {
  console.error("💥 R2-A2 KB verification failed:", err);
  process.exitCode = 1;
});
