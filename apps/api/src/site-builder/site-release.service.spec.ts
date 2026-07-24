import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  canonicalDesignEvaluationV2Json,
  designEvaluationV2Digest,
  qualityArtifactSetDigest,
  type DesignEvaluationV2,
  type QualityArtifactSetV1,
  type SiteSpec,
} from '@global/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildM1ebGoldenFixtures } from './design/m1eb-golden';
import {
  RELEASE_AESTHETIC_EVIDENCE_SCHEMA_VERSION,
  RELEASE_MANIFEST_V3_SCHEMA_VERSION,
  RELEASE_QUALITY_SCHEMA_VERSION,
  releaseAestheticEvidenceBytes,
  releaseAestheticEvidenceDigest,
  releaseScreenshotSetDigest,
  releaseSpecDigest,
  type BuildReleaseQualityInputV3,
  type ReleaseAestheticEvidenceV1,
} from './release-artifact';
import {
  resolveSiteRendererBuildIdentity,
  SiteReleaseService,
  type SiteReleaseMaterializationIdentity,
} from './site-release.service';

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
          content: [
            {
              type: 'HeroBanner',
              props: { id: 'hero', headlineKey: 'hero.headline' },
            },
          ],
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
                where.id !== '40000000-0000-0000-0000-000000000001' ||
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
                (where.leaseUntil?.gte && row.leaseUntil < where.leaseUntil.gte)
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

async function releaseQualityFixture(
  golden: Awaited<ReturnType<typeof buildM1ebGoldenFixtures>>[number],
  identity: SiteReleaseMaterializationIdentity,
  storage: ReturnType<typeof fakeStorage>,
): Promise<BuildReleaseQualityInputV3> {
  const evidence: ReleaseAestheticEvidenceV1 = {
    schemaVersion: RELEASE_AESTHETIC_EVIDENCE_SCHEMA_VERSION,
    status: 'unavailable',
    requestedModel: 'gemini-3.5-flash',
    reportedModel: null,
    resolvedModel: null,
    transport: 'openai.responses',
    routePolicyVersion: 'site-builder-aesthetic@target',
    errorClassification: 'rate_limited',
  };
  const evidenceBytes = releaseAestheticEvidenceBytes(evidence);
  const evidenceRef = {
    objectKey: `${identity.artifactPrefix}/attempts/${identity.producerToken}/quality/round-0/aesthetic-evidence.json`,
    sha256: releaseAestheticEvidenceDigest(evidence),
    sizeBytes: evidenceBytes.length,
    mimeType: 'application/json' as const,
    kind: 'aesthetic_response' as const,
  };
  storage.objects.set(evidenceRef.objectKey, evidenceBytes);
  const expectedTargets = golden.spec.site.locales.flatMap((locale) =>
    golden.spec.pages.map((page) => ({ locale, pageId: page.id })),
  );
  const screenshots = expectedTargets.flatMap((target) =>
    ([375, 768, 1440] as const).map((breakpoint) => {
      const bytes = Buffer.from(
        `screenshot:${target.locale}:${target.pageId}:${breakpoint}`,
      );
      const objectKey = `${identity.artifactPrefix}/attempts/${identity.producerToken}/quality/round-0/${target.locale}-${target.pageId}-${breakpoint}.png`;
      storage.objects.set(objectKey, bytes);
      return {
        artifactId: `${target.locale}-${target.pageId}-${breakpoint}`,
        objectKey,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        mimeType: 'image/png' as const,
        kind: 'screenshot' as const,
        target: { ...target, breakpoint },
      };
    }),
  );
  const artifactDraft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: releaseSpecDigest(golden.spec),
    designBriefDigest: golden.designBrief.digest,
    round: 0 as const,
    expectedTargets,
    artifacts: [
      ...screenshots,
      { artifactId: 'aesthetic-evidence', ...evidenceRef },
    ],
  };
  const artifactSet: QualityArtifactSetV1 = {
    ...artifactDraft,
    artifactSetDigest: qualityArtifactSetDigest(artifactDraft),
  };
  const evaluation: DesignEvaluationV2 = {
    schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
    candidateSpecDigest: artifactSet.candidateSpecDigest,
    designBriefDigest: artifactSet.designBriefDigest,
    artifactSetDigest: artifactSet.artifactSetDigest,
    round: 0,
    evaluatorVersion: 'p4-deterministic@1.0.0',
    deterministic: { status: 'passed', hardFailures: [], findings: [] },
    aesthetic: {
      status: 'unavailable',
      overallScore: null,
      dimensions: null,
      unavailableReason: 'rate_limited',
      findings: [],
    },
  };
  const evaluationBytes = Buffer.from(
    canonicalDesignEvaluationV2Json(evaluation, artifactSet),
  );
  const evaluationRef = {
    objectKey: `${identity.artifactPrefix}/attempts/${identity.producerToken}/quality/round-0/design-evaluation.json`,
    sha256: designEvaluationV2Digest(evaluation, artifactSet),
    sizeBytes: evaluationBytes.length,
    mimeType: 'application/json' as const,
    kind: 'design_evaluation' as const,
  };
  storage.objects.set(evaluationRef.objectKey, evaluationBytes);
  return {
    designEvaluation: evaluation,
    aestheticEvidence: evidence,
    manifest: {
      schemaVersion: RELEASE_QUALITY_SCHEMA_VERSION,
      status: 'passed_deterministic_aesthetic_unavailable',
      deterministicEvaluatorVersion: evaluation.evaluatorVersion,
      finalRound: 0,
      artifactSet,
      screenshotSetDigest: releaseScreenshotSetDigest(artifactSet),
      designEvaluationDigest: evaluationRef.sha256,
      designEvaluationRef: evaluationRef,
      rounds: [
        {
          round: 0,
          candidateSpecDigest: artifactSet.candidateSpecDigest,
          artifactSetDigest: artifactSet.artifactSetDigest,
          designEvaluationDigest: evaluationRef.sha256,
          repairCatalogDigest: null,
          selectedRepairOptionId: null,
          repairSelectionMode: null,
        },
      ],
      aesthetic: {
        status: evidence.status,
        requestedModel: evidence.requestedModel,
        reportedModel: evidence.reportedModel,
        resolvedModel: evidence.resolvedModel,
        transport: evidence.transport,
        routePolicyVersion: evidence.routePolicyVersion,
        errorClassification: evidence.errorClassification,
        evidenceDigest: evidenceRef.sha256,
        evidenceRef,
      },
    },
  };
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
  it('reserves a fenced identity after P4 so a new v3 Release can copy evidence and finalize', async () => {
    const prisma = fakePrisma();
    const storage = fakeStorage();
    const ids = [
      '50000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
    ];
    const service = new SiteReleaseService(prisma as never, storage, {
      buildIdentity: 'site-renderer@test',
      now: () => new Date('2026-07-24T00:00:00Z'),
      randomUuid: () => ids.shift()!,
    });
    const golden = (
      await buildM1ebGoldenFixtures(
        new URL('../../../../', import.meta.url).pathname,
      )
    )[0]!;
    const scope = {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      siteVersionId: input.siteVersionId,
      buildRunId: input.buildRunId,
    };

    const releaseIdentity = await service.reserveMaterialization(scope);
    expect(prisma.state.release).toMatchObject({
      id: releaseIdentity.releaseId,
      status: 'candidate',
      producerToken: releaseIdentity.producerToken,
    });
    const quality = await releaseQualityFixture(
      golden,
      releaseIdentity,
      storage,
    );
    await expect(
      service.materialize({
        ...scope,
        root: await outputRoot(),
        spec: golden.spec,
        storedSpecVersion: golden.spec.specVersion,
        designBrief: golden.designBrief,
        releaseIdentity,
        quality,
      }),
    ).resolves.toMatchObject({ releaseId: releaseIdentity.releaseId });

    expect(prisma.state.release?.status).toBe('ready');
    expect(prisma.state.release?.manifest).toMatchObject({
      schemaVersion: RELEASE_MANIFEST_V3_SCHEMA_VERSION,
      quality: {
        status: 'passed_deterministic_aesthetic_unavailable',
      },
    });
  });

  it('requires the fenced identity before accepting any v3 quality input', async () => {
    const prisma = fakePrisma();
    const storage = fakeStorage();
    const service = new SiteReleaseService(prisma as never, storage, {
      buildIdentity: 'site-renderer@test',
      randomUuid: vi.fn(),
    });
    await expect(
      service.materialize({
        ...input,
        root: await outputRoot(),
        quality: {} as BuildReleaseQualityInputV3,
      }),
    ).rejects.toThrow('SITE_RELEASE_QUALITY_IDENTITY_REQUIRED');
    expect(prisma.state.release).toBeNull();
  });

  it('does not let a late T1 identity renew or rotate T2 and T2 can still finalize', async () => {
    const prisma = fakePrisma();
    const storage = fakeStorage();
    const ids = [
      '50000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000001',
      '60000000-0000-0000-0000-000000000002',
    ];
    let now = new Date('2026-07-24T00:00:00Z');
    const service = new SiteReleaseService(prisma as never, storage, {
      buildIdentity: 'site-renderer@test',
      now: () => now,
      randomUuid: () => ids.shift()!,
    });
    const scope = {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      siteVersionId: input.siteVersionId,
      buildRunId: input.buildRunId,
    };
    const t1 = await service.reserveMaterialization(scope);
    now = new Date('2026-07-24T00:06:00Z');
    const t2 = await service.reserveMaterialization(scope);
    expect(t2.producerToken).not.toBe(t1.producerToken);
    const t2Lease = prisma.state.release!.leaseUntil.getTime();
    const golden = (
      await buildM1ebGoldenFixtures(
        new URL('../../../../', import.meta.url).pathname,
      )
    )[0]!;
    const quality = await releaseQualityFixture(golden, t2, storage);
    const root = await outputRoot();

    await expect(
      service.materialize({
        ...scope,
        root,
        spec: golden.spec,
        storedSpecVersion: golden.spec.specVersion,
        designBrief: golden.designBrief,
        releaseIdentity: t1,
        quality,
      }),
    ).rejects.toThrow('SITE_RELEASE_MATERIALIZATION_IDENTITY_FENCED');
    expect(prisma.state.release).toMatchObject({
      producerToken: t2.producerToken,
      status: 'candidate',
    });
    expect(prisma.state.release!.leaseUntil.getTime()).toBe(t2Lease);

    await expect(
      service.materialize({
        ...scope,
        root,
        spec: golden.spec,
        storedSpecVersion: golden.spec.specVersion,
        designBrief: golden.designBrief,
        releaseIdentity: t2,
        quality,
      }),
    ).resolves.toMatchObject({ releaseId: t2.releaseId });
    expect(prisma.state.release?.status).toBe('ready');
  });

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

    await expect(
      service.materialize({ ...input, root }),
    ).resolves.toMatchObject({
      releaseId: '50000000-0000-0000-0000-000000000001',
      artifactKey: 'release:50000000-0000-0000-0000-000000000001',
    });
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

describe('Site renderer build fencing', () => {
  it('requires an explicit immutable build identity in production', () => {
    expect(() =>
      resolveSiteRendererBuildIdentity({ NODE_ENV: 'production' }),
    ).toThrow('SITE_RENDERER_BUILD_ID is required in production');
    expect(
      resolveSiteRendererBuildIdentity({
        NODE_ENV: 'production',
        SITE_RENDERER_BUILD_ID: 'site-renderer@1.0.0+sha.abc123',
      }),
    ).toBe('site-renderer@1.0.0+sha.abc123');
  });

  it('marks an unpinned development build honestly instead of calling it production', () => {
    expect(resolveSiteRendererBuildIdentity({ NODE_ENV: 'development' })).toBe(
      'site-renderer@dev-unpinned',
    );
  });
});
