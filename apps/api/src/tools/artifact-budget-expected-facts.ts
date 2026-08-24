import {
  artifactExpectedFactsColumns,
  parseArtifactExpectedFactsColumns,
  type ArtifactExpectedFactsColumns,
  type GenericOperationArtifactSnapshot,
} from '../durable-results/artifact/artifact-expected-facts';
import { invalidGenericOperationArtifact } from '../durable-results/artifact/artifact.types';
import { parseGenericOperationArtifactSnapshot } from '../durable-results/artifact/generic-operation-artifact.repository';

export type UnknownArtifactRow = {
  expected_manifest: unknown;
  expected_http_status: unknown;
  expected_http_ok: unknown;
  expected_sanitized_url: unknown;
  expected_content_hash: unknown;
  expected_blocked_code: unknown;
  expected_robots_blocked: unknown;
};

interface ArtifactReservationBinding {
  readonly workspaceId: string;
  readonly operationId: string;
}

export function parseBoundArtifactBudgetSnapshot(
  value: GenericOperationArtifactSnapshot,
  reservation: ArtifactReservationBinding,
): Readonly<{
  snapshot: GenericOperationArtifactSnapshot;
  columns: ArtifactExpectedFactsColumns;
}> {
  const snapshot = parseGenericOperationArtifactSnapshot(value);
  const manifest = snapshot.manifest;
  if (
    manifest.operationId !== reservation.operationId ||
    (reservation.workspaceId === 'platform'
      ? manifest.scopeKind !== 'platform' || manifest.workspaceId !== null
      : manifest.scopeKind !== 'workspace' ||
        manifest.workspaceId !== reservation.workspaceId)
  ) {
    return invalidGenericOperationArtifact();
  }
  return Object.freeze({
    snapshot,
    columns: artifactExpectedFactsColumns(
      manifest.resultSchema,
      snapshot.expectedFacts,
    ),
  });
}

function nullable<T extends 'boolean' | 'number' | 'string'>(
  value: unknown,
  type: T,
): (T extends 'boolean' ? boolean : T extends 'number' ? number : string) | null {
  if (value === null) return null;
  return typeof value === type
    ? (value as never)
    : invalidGenericOperationArtifact();
}

export function expectedFactsFromUnknownRow(row: UnknownArtifactRow) {
  const manifest = row.expected_manifest;
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest) ||
    typeof (manifest as { resultSchema?: unknown }).resultSchema !== 'string'
  ) {
    return invalidGenericOperationArtifact();
  }
  return parseArtifactExpectedFactsColumns(
    (manifest as { resultSchema: string }).resultSchema,
    {
      expectedHttpStatus: nullable(row.expected_http_status, 'number'),
      expectedHttpOk: nullable(row.expected_http_ok, 'boolean'),
      expectedSanitizedUrl: nullable(row.expected_sanitized_url, 'string'),
      expectedContentHash: nullable(row.expected_content_hash, 'string'),
      expectedBlockedCode: nullable(row.expected_blocked_code, 'string'),
      expectedRobotsBlocked: nullable(
        row.expected_robots_blocked,
        'boolean',
      ),
    },
  );
}

export type { GenericOperationArtifactSnapshot };
