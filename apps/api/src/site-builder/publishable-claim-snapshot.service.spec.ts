import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import {
  buildPublishableClaimSnapshot,
  type CurrentPublishableClaimState,
  type PublishableClaimCandidate,
  type PublishableClaimSnapshot,
} from './publishable-claim-snapshot';
import {
  PublishableClaimSnapshotService,
  type PublishableClaimSnapshotRepository,
} from './publishable-claim-snapshot.service';

const CTX: RequestContext = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: 'reviewer-1',
  roles: [],
};
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const BUILD_RUN_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-19T12:00:00.000Z');

function emptySnapshot(): PublishableClaimSnapshot {
  return buildPublishableClaimSnapshot({
    workspaceId: CTX.workspaceId,
    siteId: SITE_ID,
    companyProfileId: COMPANY_ID,
    buildRunId: BUILD_RUN_ID,
    capturedAt: NOW,
    candidates: [],
  });
}

function harness(options: {
  existing?: PublishableClaimSnapshot | null;
  companyProfileId?: string | null;
  candidates?: PublishableClaimCandidate[];
  current?: CurrentPublishableClaimState[];
} = {}) {
  const persisted: PublishableClaimSnapshot[] = [];
  const repository: PublishableClaimSnapshotRepository = {
    findByBuildRun: vi.fn(async () => options.existing ?? null),
    getSiteCompanyProfileId: vi.fn(async () =>
      options.companyProfileId === undefined
        ? COMPANY_ID
        : options.companyProfileId,
    ),
    listCandidates: vi.fn(async () => options.candidates ?? []),
    persist: vi.fn(async (snapshot) => {
      persisted.push(snapshot);
      return snapshot;
    }),
    listCurrentStates: vi.fn(async () => options.current ?? []),
  };
  return {
    repository,
    persisted,
    service: new PublishableClaimSnapshotService(repository, () => NOW),
  };
}

describe('PublishableClaimSnapshotService', () => {
  it('reuses the immutable BuildRun snapshot without querying mutable Claims', async () => {
    const existing = emptySnapshot();
    const { service, repository } = harness({ existing });

    await expect(
      service.capture(CTX, { siteId: SITE_ID, buildRunId: BUILD_RUN_ID }),
    ).resolves.toEqual(existing);
    expect(repository.listCandidates).not.toHaveBeenCalled();
    expect(repository.persist).not.toHaveBeenCalled();
  });

  it('persists an explicit empty snapshot for a linked Site', async () => {
    const { service, persisted } = harness();

    const snapshot = await service.capture(CTX, {
      siteId: SITE_ID,
      buildRunId: BUILD_RUN_ID,
    });

    expect(snapshot.items).toEqual([]);
    expect(persisted).toEqual([snapshot]);
  });

  it('fails closed when the Site has no exact CompanyProfile bridge', async () => {
    const { service, repository } = harness({ companyProfileId: null });

    await expect(
      service.capture(CTX, { siteId: SITE_ID, buildRunId: BUILD_RUN_ID }),
    ).rejects.toThrowError(/COPY_SITE_COMPANY_LINK_REQUIRED/);
    expect(repository.listCandidates).not.toHaveBeenCalled();
  });

  it('delegates activation-time current-state validation to the same repository', async () => {
    const snapshot = emptySnapshot();
    const { service, repository } = harness({ existing: snapshot, current: [] });

    await expect(service.assertCurrent(CTX, snapshot)).resolves.toBeUndefined();
    expect(repository.listCurrentStates).toHaveBeenCalledWith(
      CTX.workspaceId,
      SITE_ID,
      snapshot,
    );
  });
});
