import { describe, expect, it } from 'vitest';
import {
  contentAddressedObjectKey,
  isCanonicalPersonalDataObjectKey,
  legacyPersonalDataObjectKey,
  stagingObjectKey,
} from './artifact-key';

const DIGEST = 'ab'.padEnd(64, '0');
const ARTIFACT_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('artifact object keys', () => {
  it.each([
    [
      'PUBLIC_ORGANIZATION',
      undefined,
      `generic-operation-results/v1/final/public-organization/sha256/ab/${DIGEST}`,
    ],
    [
      'CONFIDENTIAL_TENANT',
      undefined,
      `generic-operation-results/v1/final/confidential-tenant/sha256/ab/${DIGEST}`,
    ],
    [
      'PERSONAL_DATA',
      { scopeKind: 'workspace' as const, workspaceId: WORKSPACE_A },
      `generic-operation-results/v1/final/personal-data/ws/${WORKSPACE_A}/sha256/ab/${DIGEST}`,
    ],
  ])('derives a physically isolated %s object key', (privacyClass, scope, expected) => {
    expect(contentAddressedObjectKey(DIGEST, privacyClass, scope)).toBe(expected);
  });

  it('never aliases one digest across privacy-class prefixes or across PERSONAL_DATA workspaces', () => {
    expect(
      new Set([
        contentAddressedObjectKey(DIGEST, 'PUBLIC_ORGANIZATION'),
        contentAddressedObjectKey(DIGEST, 'CONFIDENTIAL_TENANT'),
        contentAddressedObjectKey(DIGEST, 'PERSONAL_DATA', {
          scopeKind: 'workspace',
          workspaceId: WORKSPACE_A,
        }),
        contentAddressedObjectKey(DIGEST, 'PERSONAL_DATA', {
          scopeKind: 'workspace',
          workspaceId: WORKSPACE_B,
        }),
      ]).size,
    ).toBe(4);
  });

  it('requires a canonical workspace scope for PERSONAL_DATA and rejects platform/missing scope', () => {
    expect(() =>
      contentAddressedObjectKey(DIGEST, 'PERSONAL_DATA'),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    expect(() =>
      contentAddressedObjectKey(DIGEST, 'PERSONAL_DATA', {
        scopeKind: 'platform',
        workspaceId: null,
      }),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    expect(() =>
      contentAddressedObjectKey(DIGEST, 'PERSONAL_DATA', {
        scopeKind: 'workspace',
        workspaceId: WORKSPACE_A.toUpperCase(),
      }),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('matches canonical and optionally legacy PERSONAL_DATA keys without accepting cross-workspace keys', () => {
    const wsAKey = contentAddressedObjectKey(DIGEST, 'PERSONAL_DATA', {
      scopeKind: 'workspace',
      workspaceId: WORKSPACE_A,
    });
    const legacyKey = legacyPersonalDataObjectKey(DIGEST);
    expect(isCanonicalPersonalDataObjectKey(wsAKey, DIGEST, WORKSPACE_A)).toBe(true);
    expect(isCanonicalPersonalDataObjectKey(wsAKey, DIGEST, WORKSPACE_B, true)).toBe(false);
    expect(isCanonicalPersonalDataObjectKey(legacyKey, DIGEST, WORKSPACE_A, false)).toBe(false);
    expect(isCanonicalPersonalDataObjectKey(legacyKey, DIGEST, WORKSPACE_A, true)).toBe(true);
  });

  it.each([
    ['an uppercase digest', DIGEST.toUpperCase()],
    ['a shortened digest', DIGEST.slice(0, -1)],
    ['a digest with a prefix', `sha256:${DIGEST}`],
  ])('rejects %s rather than accepting a caller-controlled final key', (_label, digest) => {
    expect(() =>
      contentAddressedObjectKey(digest, 'PERSONAL_DATA', {
        scopeKind: 'workspace',
        workspaceId: WORKSPACE_A,
      }),
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
