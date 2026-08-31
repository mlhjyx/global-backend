import { createHash } from 'node:crypto';
import { contentAddressedObjectKey } from '../artifact-key';
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  type GenericOperationArtifactManifest,
} from '../artifact.types';

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const AUTHORITY_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';

export function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function jsonBytes(value: unknown): Uint8Array {
  return encoded(JSON.stringify(value));
}

export async function* streamed(
  bytes: Uint8Array,
  chunkSizes: readonly number[] = [1, 2, 3, 5],
): AsyncIterable<Uint8Array> {
  let offset = 0;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    const size = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + size));
    offset += size;
    chunkIndex += 1;
  }
}

export function manifestFor(
  resultSchema: string,
  mediaType: string,
  bytes: Uint8Array,
): GenericOperationArtifactManifest {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({
    schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
    artifactId: ARTIFACT_ID,
    scopeKind: 'workspace',
    workspaceId: WORKSPACE_ID,
    authorityId: AUTHORITY_ID,
    operationId: OPERATION_ID,
    resultSchema,
    objectKey: contentAddressedObjectKey(sha256, 'PERSONAL_DATA'),
    sha256,
    sizeBytes: String(bytes.byteLength),
    mediaType,
    privacyClass: 'PERSONAL_DATA',
    sourceDigest: null,
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
  });
}
