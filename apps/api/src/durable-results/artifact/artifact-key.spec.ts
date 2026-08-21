import { describe, expect, it } from 'vitest';
import {
  contentAddressedObjectKey,
  stagingObjectKey,
} from './artifact-key';

const DIGEST = 'ab'.padEnd(64, '0');
const ARTIFACT_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';

describe('artifact object keys', () => {
  it('derives the only immutable object key from a canonical SHA-256 digest', () => {
    expect(contentAddressedObjectKey(DIGEST)).toBe(
      `generic-operation-results/v1/sha256/ab/${DIGEST}`,
    );
  });

  it.each([
    ['an uppercase digest', DIGEST.toUpperCase()],
    ['a shortened digest', DIGEST.slice(0, -1)],
    ['a digest with a prefix', `sha256:${DIGEST}`],
  ])('rejects %s rather than accepting a caller-controlled final key', (_label, digest) => {
    expect(() => contentAddressedObjectKey(digest)).toThrow(
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
