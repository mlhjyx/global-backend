/** MF0-B true PostgreSQL concurrency/RLS verifier. Ubuntu development database only. */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { AssetsService } from '../src/site-builder/assets.service';
import {
  AssetReferenceGateError,
  lockLiveAssetsForReference,
  lockSiteSpecAssetsForActivation,
} from '../src/site-builder/asset-reference-gate';
import { buildVariantObjectKey } from '../src/site-builder/object-key';
import { SiteSpecAssetReferenceScanner } from '../src/site-builder/site-spec-asset-reference-scanner';

const PREFIX = '__codex_mf0b_verifier__:';
const checks: string[] = [];

function requireDev() {
  if (process.env.ALLOW_DEV_DB_VERIFIER !== 'true' || process.env.NODE_ENV === 'production') {
    throw new Error('require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV');
  }
  for (const name of ['DATABASE_URL', 'APP_DATABASE_URL'] as const) {
    const raw = process.env[name];
    if (!raw) throw new Error(`${name} is required`);
    const url = new URL(raw);
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) || url.pathname !== '/global_dev') {
      throw new Error(`${name} must target loopback/global_dev`);
    }
  }
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`assertion failed: ${message}`);
  checks.push(message);
  console.log(`  ✅ ${message}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function readyAsset(workspaceId: string, siteId: string): Prisma.AssetUncheckedCreateInput {
  const id = randomUUID();
  const hash = randomUUID().replaceAll('-', '').repeat(2);
  return {
    id,
    workspaceId,
    siteId,
    kind: 'product_image',
    filename: `${id}.jpg`,
    mime: 'image/jpeg',
    sizeBytes: 128,
    objectKey: `ws/${workspaceId}/${siteId}/product_image/${hash}.jpg`,
    contentHash: hash,
    processingStatus: 'ready',
  };
}

function siteSpec(assetId: string, hash: string) {
  return {
    specVersion: '1.0.0',
    site: {
      defaultLocale: 'en',
      locales: ['en'],
      theme: { preset: 'test' },
      nav: [],
      seoGlobal: { siteName: 'Verifier' },
    },
    pages: [],
    assets: { [assetId]: { kind: 'product_image', hash } },
    copyBundles: { en: {} },
  };
}

async function main() {
  requireDev();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const appA = new PrismaService();
  const appB = new PrismaService();
  const scanner = new SiteSpecAssetReferenceScanner();
  const assetsService = new AssetsService(
    appB,
    { delete: async () => undefined, head: async () => null } as never,
    scanner,
  );
  const wsA = randomUUID();
  const wsB = randomUUID();
  const siteA = randomUUID();
  const assetProfile = readyAsset(wsA, siteA);
  const assetSpec = readyAsset(wsA, siteA);
  const assetVariant = readyAsset(wsA, siteA);
  const assetDeleteFirst = readyAsset(wsA, siteA);
  const assetPropsOnly = readyAsset(wsA, siteA);
  try {
    await Promise.all([owner.$connect(), appA.$connect(), appB.$connect()]);
    const abandoned = await owner.workspace.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true },
    });
    await owner.workspace.deleteMany({ where: { id: { in: abandoned.map((row) => row.id) } } });
    await owner.workspace.createMany({
      data: [
        { id: wsA, name: `${PREFIX}${wsA}` },
        { id: wsB, name: `${PREFIX}${wsB}` },
      ],
    });
    await owner.site.create({
      data: {
        id: siteA,
        workspaceId: wsA,
        name: 'MF0-B verifier',
        slug: `mf0b-${siteA}`,
        intake: {},
      },
    });
    await owner.asset.createMany({
      data: [assetProfile, assetSpec, assetVariant, assetDeleteFirst, assetPropsOnly],
    });

    const foreign = await appA.withWorkspace(wsB, (tx) =>
      scanner.scan(tx, { siteId: siteA, assetId: assetProfile.id! }),
    );
    check(foreign.length === 0, 'workspace B cannot scan workspace A Site/Profile');

    const writerLocked = deferred();
    const releaseWriter = deferred();
    const profileWriter = appA.withWorkspace(wsA, async (tx) => {
      await lockLiveAssetsForReference(tx, {
        workspaceId: wsA,
        siteId: siteA,
        assetIds: [assetProfile.id!],
      });
      writerLocked.resolve();
      await releaseWriter.promise;
      await tx.site.update({
        where: { id: siteA },
        data: { profile: { brand: { logoAssetId: assetProfile.id } } },
      });
    });
    await writerLocked.promise;
    const profileDelete = assetsService.remove({ workspaceId: wsA, userId: 'verifier', roles: [] }, assetProfile.id!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseWriter.resolve();
    await profileWriter;
    const profileError = await profileDelete.catch((error) => error);
    check(
      profileError instanceof HttpException &&
        (profileError.getResponse() as { error?: { code?: string } }).error?.code === 'ASSET_IN_USE',
      'Profile writer-first serializes and DELETE returns ASSET_IN_USE',
    );

    await owner.site.update({ where: { id: siteA }, data: { profile: null } });
    const version = await owner.siteVersion.create({
      data: {
        workspaceId: wsA,
        siteId: siteA,
        version: 1,
        source: 'manual',
        spec: siteSpec(assetSpec.id!, assetSpec.contentHash!) as Prisma.InputJsonValue,
        specVersion: '1.0.0',
        buildStatus: 'succeeded',
      },
    });
    const activationLocked = deferred();
    const releaseActivation = deferred();
    const activation = appA.withWorkspace(wsA, async (tx) => {
      await lockSiteSpecAssetsForActivation(tx, {
        workspaceId: wsA,
        siteId: siteA,
        spec: siteSpec(assetSpec.id!, assetSpec.contentHash!),
      });
      activationLocked.resolve();
      await releaseActivation.promise;
      await tx.site.update({ where: { id: siteA }, data: { activeVersionId: version.id } });
    });
    await activationLocked.promise;
    const specDelete = assetsService.remove({ workspaceId: wsA, userId: 'verifier', roles: [] }, assetSpec.id!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseActivation.resolve();
    await activation;
    const specError = await specDelete.catch((error) => error);
    check(
      specError instanceof HttpException &&
        (specError.getResponse() as { error?: { code?: string } }).error?.code === 'ASSET_IN_USE',
      'activeVersion activation-first serializes and DELETE returns ASSET_IN_USE',
    );

    await owner.site.update({ where: { id: siteA }, data: { activeVersionId: null } });
    const variantLocked = deferred();
    const releaseVariant = deferred();
    const recipe = 'b'.repeat(64);
    const variantWriter = appA.withWorkspace(wsA, async (tx) => {
      await tx.assetVariant.create({
        data: {
          workspaceId: wsA,
          siteId: siteA,
          assetId: assetVariant.id!,
          variantType: 'hero',
          mime: 'image/webp',
          objectKey: buildVariantObjectKey(wsA, siteA, assetVariant.id!, recipe, 'webp'),
          pipelineVersion: 'verify',
          recipeHash: recipe,
          status: 'processing',
        },
      });
      variantLocked.resolve();
      await releaseVariant.promise;
    });
    await variantLocked.promise;
    const variantDelete = assetsService.remove({ workspaceId: wsA, userId: 'verifier', roles: [] }, assetVariant.id!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseVariant.resolve();
    await variantWriter;
    const variantError = await variantDelete.catch((error) => error);
    check(
      variantError instanceof HttpException &&
        (variantError.getResponse() as { error?: { code?: string } }).error?.code === 'ASSET_BUSY',
      'Variant writer-first serializes and DELETE returns ASSET_BUSY',
    );

    await assetsService.remove({ workspaceId: wsA, userId: 'verifier', roles: [] }, assetDeleteFirst.id!);
    const deleteFirst = await appA
      .withWorkspace(wsA, (tx) =>
        lockLiveAssetsForReference(tx, {
          workspaceId: wsA,
          siteId: siteA,
          assetIds: [assetDeleteFirst.id!],
        }),
      )
      .catch((error) => error);
    check(deleteFirst instanceof AssetReferenceGateError, 'DELETE-first prevents a later reference write');

    const propsOnlySpec = {
      ...siteSpec(assetPropsOnly.id!, assetPropsOnly.contentHash!),
      assets: {},
      pages: [
        {
          id: 'home',
          puck: {
            root: {},
            content: [{ type: 'Hero', props: { imageAssetId: assetPropsOnly.id } }],
          },
        },
      ],
    };
    const propsOnlyRejected = await appA
      .withWorkspace(wsA, (tx) =>
        lockSiteSpecAssetsForActivation(tx, {
          workspaceId: wsA,
          siteId: siteA,
          spec: propsOnlySpec,
        }),
      )
      .catch((error) => error);
    check(propsOnlyRejected instanceof Error, 'props-only Asset reference is rejected before activeVersion activation');

    const rejectedVariant = await appA
      .withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: {
            workspaceId: wsA,
            siteId: siteA,
            assetId: assetDeleteFirst.id!,
            variantType: 'hero',
            mime: 'image/webp',
            objectKey: buildVariantObjectKey(wsA, siteA, assetDeleteFirst.id!, 'c'.repeat(64), 'webp'),
            pipelineVersion: 'verify',
            recipeHash: 'c'.repeat(64),
            status: 'processing',
          },
        }),
      )
      .catch((error) => error);
    check(rejectedVariant instanceof Error, 'DB trigger rejects a Variant for a tombstoned parent');

    console.log(JSON.stringify({ verified: true, checks: checks.length }));
  } finally {
    await owner.assetVariant.deleteMany({ where: { workspaceId: wsA } }).catch(() => undefined);
    await owner.outboxEvent.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }).catch(() => undefined);
    await owner.site.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }).catch(() => undefined);
    await owner.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } }).catch(() => undefined);
    await Promise.all([owner.$disconnect(), appA.$disconnect(), appB.$disconnect()]);
  }
}

await main();
