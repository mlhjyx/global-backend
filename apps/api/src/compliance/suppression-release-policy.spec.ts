import { describe, expect, it } from 'vitest';
import {
  evaluateSuppressionReleaseRequest,
  LEGAL_SUPPRESSION_REASONS,
  type SuppressionReleaseRequest,
} from './suppression-release-policy';

function request(
  overrides: Partial<SuppressionReleaseRequest> = {},
): SuppressionReleaseRequest {
  return {
    storedReason: 'manual',
    requestKind: 'USER_PREFERENCE',
    justification: 'The preference was recorded in error.',
    evidenceRef: null,
    ...overrides,
  };
}

describe('suppression release policy', () => {
  it('only creates a pending review request and never releases directly', () => {
    expect(evaluateSuppressionReleaseRequest(request())).toEqual({
      requestAccepted: true,
      decisionStatus: 'PENDING_REVIEW',
      mayAutoRelease: false,
      reviewClass: 'PREFERENCE',
    });
  });

  it.each(LEGAL_SUPPRESSION_REASONS)(
    'fails closed for ordinary preference release of legal suppression %s',
    (storedReason) => {
      expect(() =>
        evaluateSuppressionReleaseRequest(request({ storedReason })),
      ).toThrowError(/LEGAL_SUPPRESSION_NOT_RELEASABLE/);
    },
  );

  it('requires a non-PII evidence reference for identity correction', () => {
    expect(() =>
      evaluateSuppressionReleaseRequest(
        request({
          storedReason: 'art17',
          requestKind: 'IDENTITY_CORRECTION',
          evidenceRef: null,
        }),
      ),
    ).toThrowError(/CORRECTION_EVIDENCE_REQUIRED/);

    expect(
      evaluateSuppressionReleaseRequest(
        request({
          storedReason: 'art17',
          requestKind: 'IDENTITY_CORRECTION',
          evidenceRef: 'case:SUP-42',
        }),
      ),
    ).toEqual({
      requestAccepted: true,
      decisionStatus: 'PENDING_LEGAL_REVIEW',
      mayAutoRelease: false,
      reviewClass: 'IDENTITY_CORRECTION',
    });
  });

  it('treats unknown historical reasons as non-releasable for preference requests', () => {
    expect(() =>
      evaluateSuppressionReleaseRequest(
        request({ storedReason: 'legacy_unclassified' }),
      ),
    ).toThrowError(/SUPPRESSION_REASON_UNCLASSIFIED/);
  });

  it('rejects control characters and oversized free text before persistence', () => {
    expect(() =>
      evaluateSuppressionReleaseRequest(
        request({ justification: 'bad\nvalue' }),
      ),
    ).toThrowError(/INVALID_JUSTIFICATION/);
    expect(() =>
      evaluateSuppressionReleaseRequest(
        request({ justification: 'x'.repeat(501) }),
      ),
    ).toThrowError(/INVALID_JUSTIFICATION/);
  });
});
