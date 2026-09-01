import { describe, expect, it } from 'vitest';
import {
  contentAddressedObjectKey,
  stagingObjectKey,
} from './artifact-key';

const DIGEST = 'ab'.padEnd(64, '0');
const ARTIFACT_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';

describe('artifact object keys', () => {
  it.each([
    [
      'PUBLIC_ORGANIZATION',
      `generic-operation-results/v1/final/public-organization/sha256/ab/${DIGEST}`,
    ],
    [
      'CONFIDENTIAL_TENANT',
      `generic-operation-results/v1/final/confidential-tenant/sha256/ab/${DIGEST}`,
    ],
    [
      'PERSONAL_DATA',
      `generic-operation-results/v1/final/personal-data/sha256/ab/${DIGEST}`,
    ],
  ] as const)('derives a physically isolated %s object key', (privacyClass, expected) => {
    expect(contentAddressedObjectKey(DIGEST, privacyClass)).toBe(expected);
  });

  it('never aliases one digest across privacy-class prefixes', () => {
    expect(
      new Set([
        contentAddressedObjectKey(DIGEST, 'PUBLIC_ORGANIZATION'),
        contentAddressedObjectKey(DIGEST, 'CONFIDENTIAL_TENANT'),
        contentAddressedObjectKey(DIGEST, 'PERSONAL_DATA'),
      ]).size,
    ).toBe(3);
  });

  it.each([
    ['an uppercase digest', DIGEST.toUpperCase()],
    ['a shortened digest', DIGEST.slice(0, -1)],
    ['a digest with a prefix', `sha256:${DIGEST}`],
  ])('rejects %s rather than accepting a caller-controlled final key', (_label, digest) => {
    expect(() =>
      contentAddressedObjectKey(digest, 'PERSONAL_DATA'),
    ).toThrow(
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('rejects an unknown privacy-class path selector', () => {
    expect(() => contentAddressedObjectKey(DIGEST, 'UNKNOWN' as never)).toThrow(
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });

  it('derives a staging key only from a canonical artifact UUID', () => {
    expect(stagingObjectKey(ARTIFACT_ID)).toBe(
      `generic-operation-results/v1/staging/${ARTIFACT_ID}`,
    );
  });

  it.each([
    ['a non-UUID staging id', 'staging-name'],
    ['an uppercase staging id', ARTIFACT_ID.toUpperCase()],
  ])('rejects %s', (_label, artifactId) => {
    expect(() => stagingObjectKey(artifactId)).toThrow(
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });
});
