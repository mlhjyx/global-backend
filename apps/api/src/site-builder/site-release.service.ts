import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { DesignBriefV2, SiteSpec } from '@global/contracts';

import type { PrismaService } from '../prisma/prisma.service';
import {
  buildReleaseArtifact,
  releaseManifestDigest,
  releaseSpecDigest,
  uploadReleaseArtifact,
  validateReleaseManifest,
  validateReleaseManifestQuality,
  type BuildReleaseQualityInputV3,
  type PreparedReleaseArtifact,
  type ReleaseArtifactStorage,
} from './release-artifact';
import {
  assertRendererOutputMatches,
  rendererOutputTreeDigest,
} from './renderer-build';

const DEFAULT_RELEASE_LEASE_MS = 5 * 60_000;
const QUALITY_COLLECTION_MAX_WAIT_MS = 10_000;
const QUALITY_COLLECTION_TIMEOUT_MS = 30_000;
const BUILD_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._+@:/-]{0,127}$/;

export function resolveSiteRendererBuildIdentity(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.SITE_RENDERER_BUILD_ID?.trim();
  if (!configured) {
    if (env.NODE_ENV === 'production') {
      throw new Error('SITE_RENDERER_BUILD_ID is required in production');
    }
    return 'site-renderer@dev-unpinned';
  }
  if (!BUILD_IDENTITY.test(configured)) {
    throw new Error('SITE_RENDERER_BUILD_ID is invalid');
  }
  return configured;
}

export interface SiteReleaseServiceOptions {
  buildIdentity: string;
  now?: () => Date;
  randomUuid?: () => string;
  leaseMs?: number;
  /** Deterministic TOCTOU test seam; production wiring never supplies it. */
  beforeQualityCollectionForTest?: () => Promise<void>;
}

export interface ReserveSiteReleaseInput {
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  createdBy?: string;
  /** Optional P4 CAS; legacy v1/v2 callers omit it. */
  expectedSpecDigest?: string;
}

export interface SiteReleaseMaterializationIdentity {
  releaseId: string;
  artifactPrefix: string;
  producerToken: string;
  releaseCreatedAt: string;
}

export interface SiteReleaseCandidateFence {
  specDigest: string;
  rendererOutputDigest: string;
  basePath: string;
  siteOrigin: string;
}

export interface MaterializeSiteReleaseInput extends ReserveSiteReleaseInput {
  root: string;
  spec: SiteSpec;
  storedSpecVersion: string;
  designBrief?: DesignBriefV2;
  /** Omitted until the M1-f workflow writer is enabled; omission preserves v2. */
  quality?: BuildReleaseQualityInputV3;
  /**
   * Required for v3. Reserve after P4 passes, then copy canonical final
   * evidence into this fenced prefix before materialization.
   */
  releaseIdentity?: SiteReleaseMaterializationIdentity;
  /**
   * Mandatory v3 fence. The Release collector re-hashes the live renderer tree
   * under the same build advisory lock used for the SiteVersion digest check.
   */
  candidateFence?: SiteReleaseCandidateFence;
}

export interface MaterializedSiteRelease {
  releaseId: string;
  artifactKey: string;
  artifactPrefix: string;
  artifactDigest: string;
  manifestDigest: string;
  producerToken: string;
}

interface CandidateRelease {
  id: string;
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  releaseNumber: number;
  status: string;
  artifactPrefix: string;
  artifactDigest: string | null;
  manifest: Prisma.JsonValue | null;
  manifestDigest: string | null;
  producerToken: string;
  leaseUntil: Date;
  createdAt: Date;
  readyAt: Date | null;
}

function assertReleaseScope(
  release: CandidateRelease,
  input: ReserveSiteReleaseInput,
): void {
  if (
    release.workspaceId !== input.workspaceId ||
    release.siteId !== input.siteId ||
    release.siteVersionId !== input.siteVersionId ||
    release.buildRunId !== input.buildRunId
  ) {
    throw new Error('SITE_RELEASE_SCOPE_MISMATCH');
  }
}

function materializationIdentity(
  release: CandidateRelease,
): SiteReleaseMaterializationIdentity {
  return {
    releaseId: release.id,
    artifactPrefix: release.artifactPrefix,
    producerToken: release.producerToken,
    releaseCreatedAt: release.createdAt.toISOString(),
  };
}

function assertMaterializationIdentity(
  release: CandidateRelease,
  expected: SiteReleaseMaterializationIdentity,
): void {
  const actual = materializationIdentity(release);
  if (
    actual.releaseId !== expected.releaseId ||
    actual.artifactPrefix !== expected.artifactPrefix ||
    actual.producerToken !== expected.producerToken ||
    actual.releaseCreatedAt !== expected.releaseCreatedAt
  ) {
    throw new Error('SITE_RELEASE_MATERIALIZATION_IDENTITY_FENCED');
  }
}

export class SiteReleaseService {
  private readonly now: () => Date;
  private readonly randomUuid: () => string;
  private readonly leaseMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ReleaseArtifactStorage,
    private readonly options: SiteReleaseServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.leaseMs = options.leaseMs ?? DEFAULT_RELEASE_LEASE_MS;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 30_000 ||
      this.leaseMs > 30 * 60_000
    ) {
      throw new Error('SITE_RELEASE_INVALID_LEASE');
    }
  }

  private leaseUntil(now: Date): Date {
    return new Date(now.getTime() + this.leaseMs);
  }

  private async claim(
    input: ReserveSiteReleaseInput,
    expectedIdentity?: SiteReleaseMaterializationIdentity,
  ): Promise<CandidateRelease> {
    const now = this.now();
    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-build-${input.buildRunId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-number-${input.siteId}`}))`;

      const [run, version, existing] = await Promise.all([
        tx.siteBuildRun.findUnique({
          where: { id: input.buildRunId },
          select: { status: true },
        }),
        tx.siteVersion.findUnique({
          where: { id: input.siteVersionId },
          select: {
            id: true,
            workspaceId: true,
            siteId: true,
            buildRunId: true,
            buildStatus: true,
            spec: true,
          },
        }),
        tx.siteRelease.findUnique({ where: { buildRunId: input.buildRunId } }),
      ]);
      if (
        !version ||
        version.workspaceId !== input.workspaceId ||
        version.siteId !== input.siteId ||
        version.buildRunId !== input.buildRunId ||
        !['building', 'succeeded'].includes(version.buildStatus)
      ) {
        throw new Error('SITE_RELEASE_VERSION_NOT_BUILDABLE');
      }
      if (
        input.expectedSpecDigest &&
        releaseSpecDigest(version.spec) !== input.expectedSpecDigest
      ) {
        throw new Error('QUALITY_CANDIDATE_FENCE_LOST');
      }

      if (existing) {
        const release = existing as CandidateRelease;
        assertReleaseScope(release, input);
        if (expectedIdentity) {
          assertMaterializationIdentity(release, expectedIdentity);
        }
        if (release.status === 'ready') return release;
        if (release.status !== 'candidate') {
          throw new Error(`SITE_RELEASE_NOT_RETRYABLE: ${release.status}`);
        }
        if (run?.status !== 'running') {
          throw new Error('SITE_RELEASE_RUN_NOT_RUNNING');
        }

        const expired = release.leaseUntil <= now;
        if (expectedIdentity && expired) {
          throw new Error('SITE_RELEASE_MATERIALIZATION_IDENTITY_FENCED');
        }
        const producerToken = expired
          ? this.randomUuid()
          : release.producerToken;
        const leaseUntil = this.leaseUntil(now);
        const renewed = await tx.siteRelease.updateMany({
          where: {
            id: release.id,
            status: 'candidate',
            producerToken: release.producerToken,
          },
          data: { producerToken, leaseUntil, error: null },
        });
        if (renewed.count !== 1) throw new Error('SITE_RELEASE_CLAIM_FENCED');
        return {
          ...release,
          producerToken,
          leaseUntil,
          error: null,
        } as CandidateRelease;
      }

      if (run?.status !== 'running') {
        throw new Error('SITE_RELEASE_RUN_NOT_RUNNING');
      }
      if (expectedIdentity) {
        throw new Error('SITE_RELEASE_MATERIALIZATION_IDENTITY_FENCED');
      }
      const releaseId = this.randomUuid();
      const producerToken = this.randomUuid();
      const aggregate = await tx.siteRelease.aggregate({
        where: { siteId: input.siteId },
        _max: { releaseNumber: true },
      });
      const releaseNumber = (aggregate._max.releaseNumber ?? 0) + 1;
      return tx.siteRelease.create({
        data: {
          id: releaseId,
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          siteVersionId: input.siteVersionId,
          buildRunId: input.buildRunId,
          releaseNumber,
          status: 'candidate',
          artifactPrefix: `sites/${input.siteId}/releases/${releaseId}`,
          producerToken,
          leaseUntil: this.leaseUntil(now),
          createdBy: input.createdBy,
          createdAt: now,
        },
      }) as unknown as CandidateRelease;
    });
  }

  /**
   * Called only after P4 passes. This allocates the sole candidate Release
   * identity so the caller can copy canonical final quality evidence into its
   * private fenced prefix. Repeating the call renews or fences the lease.
   */
  async reserveMaterialization(
    input: ReserveSiteReleaseInput,
  ): Promise<SiteReleaseMaterializationIdentity> {
    return materializationIdentity(await this.claim(input));
  }

  async materialize(
    input: MaterializeSiteReleaseInput,
  ): Promise<MaterializedSiteRelease> {
    if (
      input.quality &&
      (!input.releaseIdentity || !input.candidateFence || !input.designBrief)
    ) {
      throw new Error('SITE_RELEASE_QUALITY_IDENTITY_REQUIRED');
    }
    const candidate = await this.claim(input, input.releaseIdentity);
    if (input.quality && candidate.status === 'ready') {
      const manifest = validateReleaseManifest(candidate.manifest);
      if (
        manifest.schemaVersion !== 'site-builder-release-manifest/v3' ||
        !candidate.artifactDigest ||
        !candidate.manifestDigest ||
        releaseManifestDigest(manifest) !== candidate.manifestDigest ||
        manifest.artifactDigest !== candidate.artifactDigest ||
        manifest.specDigest !== input.candidateFence!.specDigest ||
        manifest.specDigest !== releaseSpecDigest(input.spec) ||
        manifest.producerToken !== candidate.producerToken ||
        releaseSpecDigest(manifest.quality) !==
          releaseSpecDigest(
            validateReleaseManifestQuality(input.quality.manifest, {
              artifactPrefix: candidate.artifactPrefix,
              producerToken: candidate.producerToken,
              specDigest: input.candidateFence!.specDigest,
              designBriefDigest: input.designBrief!.digest,
            }),
          )
      ) {
        throw new Error('SITE_RELEASE_READY_METADATA_MISMATCH');
      }
      return {
        releaseId: candidate.id,
        artifactKey: `release:${candidate.id}`,
        artifactPrefix: candidate.artifactPrefix,
        artifactDigest: candidate.artifactDigest,
        manifestDigest: candidate.manifestDigest,
        producerToken: candidate.producerToken,
      };
    }
    const buildArtifact = (): Promise<PreparedReleaseArtifact> =>
      buildReleaseArtifact({
        root: input.root,
        spec: input.spec,
        storedSpecVersion: input.storedSpecVersion,
        releaseId: candidate.id,
        workspaceId: candidate.workspaceId,
        siteId: candidate.siteId,
        siteVersionId: candidate.siteVersionId,
        buildRunId: candidate.buildRunId,
        producerToken: candidate.producerToken,
        artifactPrefix: candidate.artifactPrefix,
        releaseCreatedAt: candidate.createdAt,
        buildIdentity: this.options.buildIdentity,
        designBrief: input.designBrief,
        quality: input.quality,
      });
    const artifact = input.quality
      ? await this.prisma.withWorkspace(
          input.workspaceId,
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-build-${input.buildRunId}`}))`;
            const [run, version, release] = await Promise.all([
              tx.siteBuildRun.findUnique({
                where: { id: input.buildRunId },
                select: { status: true },
              }),
              tx.siteVersion.findUnique({
                where: { id: input.siteVersionId },
                select: {
                  workspaceId: true,
                  siteId: true,
                  buildRunId: true,
                  buildStatus: true,
                  spec: true,
                  specVersion: true,
                },
              }),
              tx.siteRelease.findUnique({
                where: { id: candidate.id },
              }),
            ]);
            if (
              run?.status !== 'running' ||
              !version ||
              version.workspaceId !== input.workspaceId ||
              version.siteId !== input.siteId ||
              version.buildRunId !== input.buildRunId ||
              version.buildStatus !== 'building' ||
              version.specVersion !== input.storedSpecVersion ||
              !release
            ) {
              throw new Error('QUALITY_CANDIDATE_FENCE_LOST');
            }
            assertReleaseScope(release as CandidateRelease, input);
            assertMaterializationIdentity(
              release as CandidateRelease,
              input.releaseIdentity!,
            );
            const persistedDigest = releaseSpecDigest(version.spec);
            const inputDigest = releaseSpecDigest(input.spec);
            if (
              persistedDigest !== input.candidateFence!.specDigest ||
              inputDigest !== input.candidateFence!.specDigest
            ) {
              throw new Error('QUALITY_CANDIDATE_FENCE_LOST');
            }
            await assertRendererOutputMatches({
              root: input.root,
              candidateSpecDigest: input.candidateFence!.specDigest,
              basePath: input.candidateFence!.basePath,
              siteOrigin: input.candidateFence!.siteOrigin,
              treeDigest: input.candidateFence!.rendererOutputDigest,
            });
            await this.options.beforeQualityCollectionForTest?.();
            // Collection is deliberately inside the same candidate fence. It
            // is bounded by renderer-build's 4k files / 64 MiB limits.
            const collected = await buildArtifact();
            if (
              rendererOutputTreeDigest(collected.files) !==
              input.candidateFence!.rendererOutputDigest
            ) {
              throw new Error('RENDERER_OUTPUT_TREE_MISMATCH');
            }
            return collected;
          },
          {
            maxWait: QUALITY_COLLECTION_MAX_WAIT_MS,
            timeout: QUALITY_COLLECTION_TIMEOUT_MS,
          },
        )
      : await buildArtifact();
    if (
      candidate.status === 'ready' &&
      (candidate.artifactDigest !== artifact.artifactDigest ||
        candidate.manifestDigest !== artifact.manifestDigest)
    ) {
      throw new Error('SITE_RELEASE_READY_METADATA_MISMATCH');
    }

    await uploadReleaseArtifact(artifact, this.storage);

    if (candidate.status !== 'ready') {
      const now = this.now();
      await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-build-${input.buildRunId}`}))`;
        const run = await tx.siteBuildRun.findUnique({
          where: { id: input.buildRunId },
          select: { status: true },
        });
        if (run?.status !== 'running') {
          throw new Error('SITE_RELEASE_RUN_NOT_RUNNING');
        }
        if (input.candidateFence) {
          const version = await tx.siteVersion.findUnique({
            where: { id: input.siteVersionId },
            select: { spec: true, buildStatus: true },
          });
          const digest = version ? releaseSpecDigest(version.spec) : null;
          if (
            version?.buildStatus !== 'building' ||
            digest !== input.candidateFence.specDigest
          ) {
            throw new Error('QUALITY_CANDIDATE_FENCE_LOST');
          }
        }
        const finalized = await tx.siteRelease.updateMany({
          where: {
            id: candidate.id,
            status: 'candidate',
            producerToken: candidate.producerToken,
            leaseUntil: { gte: now },
          },
          data: {
            status: 'ready',
            artifactDigest: artifact.artifactDigest,
            manifest: artifact.manifest as unknown as Prisma.InputJsonObject,
            manifestDigest: artifact.manifestDigest,
            readyAt: now,
            error: null,
          },
        });
        if (finalized.count !== 1) {
          throw new Error('SITE_RELEASE_FINALIZE_FENCED');
        }
        const completed = await tx.siteVersion.updateMany({
          where: {
            id: input.siteVersionId,
            buildRunId: input.buildRunId,
            buildStatus: { in: ['building', 'succeeded'] },
          },
          data: {
            buildStatus: 'succeeded',
            artifactKey: `release:${candidate.id}`,
          },
        });
        if (completed.count !== 1) {
          throw new Error('SITE_RELEASE_VERSION_FINALIZE_FENCED');
        }
      });
    }

    return {
      releaseId: candidate.id,
      artifactKey: `release:${candidate.id}`,
      artifactPrefix: candidate.artifactPrefix,
      artifactDigest: artifact.artifactDigest,
      manifestDigest: artifact.manifestDigest,
      producerToken: candidate.producerToken,
    };
  }
}
