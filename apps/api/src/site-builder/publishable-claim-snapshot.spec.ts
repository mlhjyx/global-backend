import { describe, expect, it } from 'vitest';
import { buildClaimApprovalProof } from '../claim/claim-verification';
import {
  PublishableClaimSnapshotError,
  assertPublishableClaimSnapshotCurrent,
  buildPublishableClaimSnapshot,
  type PublishableClaimCandidate,
} from './publishable-claim-snapshot';

const CAPTURED_AT = new Date('2026-07-19T12:00:00.000Z');
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';

function candidate(
  id: string,
  overrides: Partial<PublishableClaimCandidate> = {},
): PublishableClaimCandidate {
  const base = {
    claimId: id,
    workspaceId: WORKSPACE_ID,
    companyProfileId: COMPANY_ID,
    claimVersion: 2,
    factKey: 'main_products',
    claimType: 'capability',
    statement: 'Industrial pumps up to 400 bar',
    status: 'APPROVED' as const,
    validUntil: new Date('2026-08-19T12:00:00.000Z'),
    verifiedBy: 'reviewer-1',
    verifiedAt: new Date('2026-07-19T10:00:00.000Z'),
    verificationMethod: 'human_review',
    bridgeId: `bridge-${id}`,
    brandProfileId: `profile-${id}`,
    evidenceRefId: `ref-${id}`,
    evidenceId: `evidence-${id}`,
    sourceSnapshotId: `source-${id}`,
    sourceContentHash: 'a'.repeat(64),
    quote: 'Industrial pumps up to 400 bar',
    quoteStart: 0,
    quoteEnd: 33,
    quotePrefix: null,
    quoteSuffix: null,
    certAssetId: null,
    certificationProofValid: true,
  };
  const approved = { ...base, ...overrides };
  return {
    ...approved,
    verificationProof:
      overrides.verificationProof ??
      buildClaimApprovalProof(
        {
          id: approved.claimId,
          workspaceId: approved.workspaceId,
          companyId: approved.companyProfileId,
          sourceId: null,
          originKey: `origin-${approved.claimId}`,
          factKey: approved.factKey,
          type: approved.claimType,
          statement: approved.statement,
          validUntil: approved.validUntil,
        },
        approved.claimVersion,
        {
          verifiedBy: approved.verifiedBy,
          verifiedAt: approved.verifiedAt,
          verificationMethod: 'human_review',
        },
      ),
    sourceId: null,
    originKey: `origin-${approved.claimId}`,
  };
}

describe('PublishableClaimSnapshot', () => {
  it('freezes exact Site bridges in binary claim order with a stable digest', () => {
    const snapshot = buildPublishableClaimSnapshot({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      buildRunId: '44444444-4444-4444-8444-444444444444',
      capturedAt: CAPTURED_AT,
      candidates: [candidate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
    });

    expect(snapshot.schemaVersion).toBe('site-builder-publishable-claim-snapshot/v1');
    expect(snapshot.items.map((item) => item.claimId)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    expect(snapshot.items[0]).toMatchObject({
      bridgeId: 'bridge-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      claimVersion: 2,
      factKey: 'main_products',
      sourceContentHash: 'a'.repeat(64),
    });
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      buildPublishableClaimSnapshot({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        companyProfileId: COMPANY_ID,
        buildRunId: '44444444-4444-4444-8444-444444444444',
        capturedAt: CAPTURED_AT,
        candidates: [candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), candidate('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')],
      }).digest,
    ).toBe(snapshot.digest);
  });

  it.each([
    ['unbridged legacy/manual Claim', { bridgeId: null }],
    ['non-approved Claim', { status: 'NEEDS_REVIEW' }],
    ['expired Claim', { validUntil: CAPTURED_AT }],
    ['invalid approval proof', { verificationProof: { proofVersion: 3 } }],
    ['missing certification Asset', { claimType: 'certification', certificationProofValid: false }],
  ] as const)('rejects %s instead of silently publishing it', (_label, overrides) => {
    expect(() =>
      buildPublishableClaimSnapshot({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        companyProfileId: COMPANY_ID,
        buildRunId: '44444444-4444-4444-8444-444444444444',
        capturedAt: CAPTURED_AT,
        candidates: [candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', overrides as Partial<PublishableClaimCandidate>)],
      }),
    ).toThrow(PublishableClaimSnapshotError);
  });

  it('fails activation when a referenced Claim version/status drifts after capture', () => {
    const snapshot = buildPublishableClaimSnapshot({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      buildRunId: '44444444-4444-4444-8444-444444444444',
      capturedAt: CAPTURED_AT,
      candidates: [candidate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
    });

    expect(() =>
      assertPublishableClaimSnapshotCurrent(snapshot, [
        {
          claimId: snapshot.items[0].claimId,
          claimVersion: 3,
          status: 'REVOKED',
          validUntil: snapshot.items[0].validUntil,
          bridgeId: snapshot.items[0].bridgeId,
          certificationProofValid: true,
        },
      ], new Date('2026-07-19T12:01:00.000Z')),
    ).toThrowError(/COPY_CLAIM_SNAPSHOT_STALE/);
  });
});
