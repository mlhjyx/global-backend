import { describe, expect, it } from 'vitest';
import { documentHash } from './market-candidate-set.document';
import { claimSourceDigest } from './market-candidate-sets.service';

const LEGACY_FIELDS = {
  type: 'certification',
  statement: '合成设备 M-1 仅适用于室内。',
  status: 'APPROVED',
  validUntil: null,
  verifiedBy: null,
  verifiedAt: null,
  verificationMethod: null,
  verificationProof: null,
};

describe('claimSourceDigest', () => {
  it('keeps the exact legacy bytes for non-document claims', () => {
    expect(claimSourceDigest(LEGACY_FIELDS)).toBe(documentHash(LEGACY_FIELDS));
  });

  it('treats an undefined binding hash as absent, never as null', () => {
    expect(
      claimSourceDigest({ ...LEGACY_FIELDS, documentBindingHash: undefined }),
    ).toBe(claimSourceDigest(LEGACY_FIELDS));
  });

  it('binds the current document binding for document claims', () => {
    const hash = 'a'.repeat(64);
    const digest = claimSourceDigest({ ...LEGACY_FIELDS, documentBindingHash: hash });
    expect(digest).toBe(documentHash({ ...LEGACY_FIELDS, documentBindingHash: hash }));
    expect(digest).not.toBe(claimSourceDigest(LEGACY_FIELDS));
  });
});
