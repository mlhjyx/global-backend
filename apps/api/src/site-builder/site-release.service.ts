import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SiteSpec } from '@global/contracts';

import type { PrismaService } from '../prisma/prisma.service';
import {
  buildReleaseArtifact,
  uploadReleaseArtifact,
  type ReleaseArtifactStorage,
} from './release-artifact';

const DEFAULT_RELEASE_LEASE_MS = 5 * 60_000;

export interface SiteReleaseServiceOptions {
  buildIdentity: string;
  now?: () => Date;
  randomUuid?: () => string;
  leaseMs?: number;
}

export interface MaterializeSiteReleaseInput {
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  root: string;
  spec: SiteSpec;
  storedSpecVersion: string;
  createdBy?: string;
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
  input: MaterializeSiteReleaseInput,
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
    input: MaterializeSiteReleaseInput,
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

      if (existing) {
        const release = existing as CandidateRelease;
        assertReleaseScope(release, input);
        if (release.status === 'ready') return release;
        if (release.status !== 'candidate') {
          throw new Error(`SITE_RELEASE_NOT_RETRYABLE: ${release.status}`);
        }
        if (run?.status !== 'running') {
          throw new Error('SITE_RELEASE_RUN_NOT_RUNNING');
        }

        const expired = release.leaseUntil <= now;
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
        return { ...release, producerToken, leaseUntil, error: null } as CandidateRelease;
      }

      if (run?.status !== 'running') {
        throw new Error('SITE_RELEASE_RUN_NOT_RUNNING');
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

  async materialize(
    input: MaterializeSiteReleaseInput,
  ): Promise<MaterializedSiteRelease> {
    const candidate = await this.claim(input);
    const artifact = await buildReleaseArtifact({
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
    });
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
