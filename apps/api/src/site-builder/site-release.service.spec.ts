import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SiteSpec } from '@global/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SiteReleaseService } from './site-release.service';

interface ReleaseRow {
  id: string;
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  releaseNumber: number;
  status: string;
  artifactPrefix: string;
  artifactDigest: string | null;
  manifest: unknown;
  manifestDigest: string | null;
  producerToken: string;
  leaseUntil: Date;
  createdAt: Date;
  readyAt: Date | null;
}

interface State {
  runStatus: string;
  versionStatus: string;
  artifactKey: string | null;
  release: ReleaseRow | null;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function siteSpec(): SiteSpec {
  return {
    specVersion: '1.0.0',
    site: {
      defaultLocale: 'en',
      locales: ['en'],
      theme: { preset: 'precision-light' },
      nav: [],
      seoGlobal: { siteName: 'Acme' },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        puck: {
          root: {},
          content: [{ type: 'HeroBanner', props: { id: 'hero' } }],
        },
        seo: { titleKey: 'title', descriptionKey: 'description' },
      },
    ],
    assets: {},
    copyBundles: { en: { title: 'Acme', description: 'Acme site' } },
  };
}

function fakePrisma(initial?: Partial<State>) {
  const state: State = {
    runStatus: 'running',
    versionStatus: 'building',
    artifactKey: null,
    release: null,
    ...initial,
  };
  let failFinalizeOnce = false;

  const client = {
    state,
    failNextFinalize: () => {
      failFinalizeOnce = true;
    },
    withWorkspace: vi.fn(
      async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => {
        const draft = structuredClone(state);
        const tx = {
          $executeRaw: vi.fn(async () => 1),
          siteBuildRun: {
            findUnique: vi.fn(async () => ({ status: draft.runStatus })),
          },
          siteVersion: {
            findUnique: vi.fn(async () => ({
              id: '40000000-0000-0000-0000-000000000001',
              siteId: '20000000-0000-0000-0000-000000000001',
              workspaceId: '10000000-0000-0000-0000-000000000001',
              buildRunId: '30000000-0000-0000-0000-000000000001',
              buildStatus: draft.versionStatus,
            })),
            updateMany: vi.fn(async ({ where, data }) => {
              if (
                where.id !==
                  '40000000-0000-0000-0000-000000000001' ||
                !where.buildStatus.in.includes(draft.versionStatus)
              ) {
                return { count: 0 };
              }
              draft.versionStatus = data.buildStatus;
              draft.artifactKey = data.artifactKey;
              return { count: 1 };
            }),
          },
          siteRelease: {
            findUnique: vi.fn(async () => draft.release),
            aggregate: vi.fn(async () => ({
              _max: { releaseNumber: draft.release?.releaseNumber ?? null },
            })),
            create: vi.fn(async ({ data }) => {
              draft.release = {
                ...data,
                artifactDigest: null,
                manifest: null,
                manifestDigest: null,
                readyAt: null,
                createdAt: data.createdAt ?? new Date('2026-07-20T00:00:00Z'),
              } as ReleaseRow;
              return draft.release;
            }),
            updateMany: vi.fn(async ({ where, data }) => {
              if (failFinalizeOnce && data.status === 'ready') {
                failFinalizeOnce = false;
                throw new Error('forced database finalize failure');
              }
              const row = draft.release;
              if (
                !row ||
                row.id !== where.id ||
                (where.status && row.status !== where.status) ||
                (where.producerToken &&
                  row.producerToken !== where.producerToken) ||
                (where.leaseUntil?.gte &&
                  row.leaseUntil < where.leaseUntil.gte)
              ) {
                return { count: 0 };
              }
              Object.assign(row, data);
              return { count: 1 };
            }),
          },
        };
        const result = await fn(tx);
        Object.assign(state, draft);
        return result;
      },
    ),
  };
  return client;
}

function fakeStorage(onPut?: () => void) {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putBufferImmutable: vi.fn(
      async (key: string, data: Buffer): Promise<'created' | 'exists'> => {
        onPut?.();
        if (objects.has(key)) return 'exists';
        objects.set(key, Buffer.from(data));
        return 'created';
      },
    ),
    hashObject: vi.fn(async (key: string) => {
      const data = objects.get(key);
      if (!data) throw new Error(`missing ${key}`);
      return {
        sha256: createHash('sha256').update(data).digest('hex'),
        head: data.subarray(0, 16),
        size: data.length,
      };
    }),
  };
}

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'r1-release-service-'));
  roots.push(root);
  await writeFile(path.join(root, 'index.html'), '<h1>Acme</h1>');
  return root;
}

const input = {
  workspaceId: '10000000-0000-0000-0000-000000000001',
  siteId: '20000000-0000-0000-0000-000000000001',
  siteVersionId: '40000000-0000-0000-0000-000000000001',
  buildRunId: '30000000-0000-0000-0000-000000000001',
  spec: siteSpec(),
  storedSpecVersion: '1.0.0',
};

describe('SiteReleaseService cross-system commit protocol', () => {
  it('keeps an uploaded candidate retryable when database finalize fails', async () => {
    const prisma = fakePrisma();
    prisma.failNextFinalize();
    const storage = fakeStorage();
    const ids = [
      '50000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
    ];
    const service = new SiteReleaseService(prisma as never, storage, {
      buildIdentity: 'site-renderer@test',
      now: () => new Date('2026-07-20T00:00:00Z'),
      randomUuid: () => ids.shift()!,
    });
    const root = await outputRoot();

    await expect(service.materialize({ ...input, root })).rejects.toThrow(
      'forced database finalize failure',
    );
    expect(prisma.state.release?.status).toBe('candidate');
    expect(prisma.state.versionStatus).toBe('building');
    expect(storage.objects.size).toBe(2);

    await expect(service.materialize({ ...input, root })).resolves.toMatchObject(
      {
        releaseId: '50000000-0000-0000-0000-000000000001',
        artifactKey: 'release:50000000-0000-0000-0000-000000000001',
      },
    );
    expect(prisma.state.release?.status).toBe('ready');
    expect(prisma.state.versionStatus).toBe('succeeded');
    expect(storage.objects.size).toBe(2);
  });

  it('rotates an expired producer fence and writes to a disjoint attempt prefix', async () => {
    const prisma = fakePrisma({
      release: {
        id: '50000000-0000-0000-0000-000000000001',
        workspaceId: input.workspaceId,
        siteId: input.siteId,
        siteVersionId: input.siteVersionId,
        buildRunId: input.buildRunId,
        releaseNumber: 1,
        status: 'candidate',
        artifactPrefix: `${`sites/${input.siteId}/releases/`}50000000-0000-0000-0000-000000000001`,
        artifactDigest: null,
        manifest: null,
        manifestDigest: null,
        producerToken: '60000000-0000-0000-0000-000000000001',
        leaseUntil: new Date('2026-07-19T23:59:00Z'),
        createdAt: new Date('2026-07-19T23:50:00Z'),
        readyAt: null,
      },
    });
    const storage = fakeStorage();
    const service = new SiteReleaseService(prisma as never, storage, {
      buildIdentity: 'site-renderer@test',
      now: () => new Date('2026-07-20T00:00:00Z'),
      randomUuid: () => '60000000-0000-0000-0000-000000000002',
    });

    await service.materialize({ ...input, root: await outputRoot() });

    expect(prisma.state.release?.producerToken).toBe(
      '60000000-0000-0000-0000-000000000002',
    );
    expect([...storage.objects.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '/attempts/60000000-0000-0000-0000-000000000002/',
        ),
      ]),
    );
  });

  it('does not finalize after cancellation wins before the database commit point', async () => {
    const prisma = fakePrisma();
    let cancelled = false;
    const storage = fakeStorage(() => {
      if (!cancelled) {
        prisma.state.runStatus = 'cancelled';
        cancelled = true;
      }
    });
    const ids = [
      '50000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
    ];
    const service = new SiteReleaseService(prisma as never, storage, {
      buildIdentity: 'site-renderer@test',
      now: () => new Date('2026-07-20T00:00:00Z'),
      randomUuid: () => ids.shift()!,
    });

    await expect(
      service.materialize({ ...input, root: await outputRoot() }),
    ).rejects.toThrow('SITE_RELEASE_RUN_NOT_RUNNING');
    expect(prisma.state.release?.status).toBe('candidate');
    expect(prisma.state.versionStatus).toBe('building');
  });

  it('reconciles a READY row after acknowledgement loss without changing its producer', async () => {
    const prisma = fakePrisma();
    const storage = fakeStorage();
    const ids = [
      '50000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
    ];
    const randomUuid = vi.fn(() => ids.shift()!);
    const service = new SiteReleaseService(prisma as never, storage, {
      buildIdentity: 'site-renderer@test',
      now: () => new Date('2026-07-20T00:00:00Z'),
      randomUuid,
    });
    const root = await outputRoot();
    const first = await service.materialize({ ...input, root });
    const producer = prisma.state.release?.producerToken;
    const replay = await service.materialize({ ...input, root });

    expect(replay).toEqual(first);
    expect(prisma.state.release?.producerToken).toBe(producer);
    expect(randomUuid).toHaveBeenCalledTimes(2);
    expect(storage.objects.size).toBe(2);
  });
});
