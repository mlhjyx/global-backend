import { Prisma } from '@prisma/client';
import type { ArtifactSubjectRef } from '../../tools/artifact-execution-port';
import {
  parseDiscoveryV3ArtifactProjection,
  type DiscoveryV3ArtifactIdentity,
} from '../../tools/discovery-v3-artifact-execution-port';
import type { GenericOperationProjection } from '../../tools/generic-operation-projection';
import {
  artifactExpectedFactsColumns,
  parseArtifactExpectedFactsColumns,
  type ArtifactExpectedFacts,
  type ArtifactExpectedFactsColumns,
} from './artifact-expected-facts';
import {
  DISCOVERY_V3_ARTIFACT_MANIFEST_SCHEMA,
  invalidGenericOperationArtifact,
  type DiscoveryV3ArtifactManifest,
} from './artifact.types';
import { parseDiscoveryV3ArtifactManifest } from './generic-operation-artifact.repository';

interface ArtifactBinding {
  readonly identity: DiscoveryV3ArtifactIdentity;
  readonly subjectRef: ArtifactSubjectRef;
  readonly projection: GenericOperationProjection;
  readonly resultSha256: string;
}

interface ArtifactSnapshot {
  readonly manifest: DiscoveryV3ArtifactManifest;
  readonly expectedFacts: ArtifactExpectedFacts | undefined;
}

interface ArtifactReadRow extends ArtifactExpectedFactsColumns {
  readonly objectKey: string;
  readonly createdAt: Date;
}

function promotionArgs({ identity, subjectRef, projection }: ArtifactBinding) {
  return Prisma.sql`
    ${identity.workspaceId}::uuid, ${identity.operationId}::uuid,
    ${identity.requestSha256}::text, ${subjectRef.subjectType}::text,
    ${subjectRef.subjectId}::uuid, ${JSON.stringify(projection)}::jsonb
  `;
}

export class DiscoveryV3ArtifactRepository {
  async registerPromotion(tx: Prisma.TransactionClient, input: ArtifactBinding): Promise<void> {
    await tx.$executeRaw`SELECT public.register_discovery_v3_artifact_promotion_v1(${promotionArgs(input)})`;
  }

  async authorizePromotion(tx: Prisma.TransactionClient, input: ArtifactBinding): Promise<void> {
    await tx.$executeRaw`SELECT public.authorize_discovery_v3_artifact_promotion_v1(${promotionArgs(input)})`;
  }

  async confirmPromotion(tx: Prisma.TransactionClient, input: ArtifactBinding, objectVersionId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT public.confirm_discovery_v3_artifact_promotion_v1(${promotionArgs(input)}, ${objectVersionId}::text)
    `;
  }

  async lockForWrite(tx: Prisma.TransactionClient, input: ArtifactBinding): Promise<boolean> {
    const { identity, subjectRef, projection } = input;
    const [row] = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT public.prepare_discovery_v3_artifact_v1(
        ${identity.workspaceId}::uuid, ${identity.operationId}::uuid,
        ${identity.requestSha256}::text, ${subjectRef.subjectType}::text,
        ${subjectRef.subjectId}::uuid, ${JSON.stringify(projection)}::jsonb
      ) AS "exists"
    `;
    if (typeof row?.exists !== 'boolean') return invalidGenericOperationArtifact();
    return row.exists;
  }

  async append(
    tx: Prisma.TransactionClient,
    input: ArtifactBinding & ArtifactSnapshot & Readonly<{ versionId: string }>,
  ): Promise<void> {
    const { identity, subjectRef, projection, manifest, versionId } = input;
    const facts = artifactExpectedFactsColumns(manifest.resultSchema, input.expectedFacts);
    await tx.$executeRaw`
      SELECT public.append_discovery_v3_artifact_v1(
        ${identity.workspaceId}::uuid, ${identity.operationId}::uuid,
        ${identity.requestSha256}::text, ${subjectRef.subjectType}::text,
        ${subjectRef.subjectId}::uuid, ${JSON.stringify(projection)}::jsonb,
        ${new Date(manifest.createdAt)}::timestamptz, ${versionId}::text,
        ${facts.expectedHttpStatus}::smallint, ${facts.expectedHttpOk}::boolean,
        ${facts.expectedSanitizedUrl}::text, ${facts.expectedContentHash}::text,
        ${facts.expectedBlockedCode}::text, ${facts.expectedRobotsBlocked}::boolean
      )
    `;
  }

  async findExact(tx: Prisma.TransactionClient, input: ArtifactBinding): Promise<ArtifactSnapshot | null> {
    const { identity, subjectRef, projection } = input;
    const reference = parseDiscoveryV3ArtifactProjection(projection, {
      operationId: identity.operationId, resultSha256: input.resultSha256,
    });
    const rows = await tx.$queryRaw<ArtifactReadRow[]>`
      SELECT object_key AS "objectKey", created_at AS "createdAt",
        expected_http_status AS "expectedHttpStatus", expected_http_ok AS "expectedHttpOk",
        expected_sanitized_url AS "expectedSanitizedUrl", expected_content_hash AS "expectedContentHash",
        expected_blocked_code AS "expectedBlockedCode", expected_robots_blocked AS "expectedRobotsBlocked"
      FROM public.find_exact_discovery_v3_artifact_v1(
        ${identity.workspaceId}::uuid, ${identity.operationId}::uuid,
        ${identity.requestSha256}::text, ${subjectRef.subjectType}::text,
        ${subjectRef.subjectId}::uuid, ${JSON.stringify(projection)}::jsonb
      )
    `;
    if (rows.length === 0) return null;
    if (rows.length !== 1) return invalidGenericOperationArtifact();
    const { objectKey, createdAt, ...facts } = rows[0];
    const manifest = parseDiscoveryV3ArtifactManifest({
      ...reference, schemaVersion: DISCOVERY_V3_ARTIFACT_MANIFEST_SCHEMA,
      scopeKind: 'workspace', workspaceId: identity.workspaceId, objectKey,
      privacyClass: 'PERSONAL_DATA', sourceDigest: null, createdAt: createdAt.toISOString(),
    });
    return { manifest, expectedFacts: parseArtifactExpectedFactsColumns(reference.resultSchema, facts) };
  }
}
