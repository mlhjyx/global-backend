import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { admitDiscoveryV3 } from '../../discovery/discovery-v3-admission';
import { DiscoveryV3OperationStore } from '../../discovery/discovery-v3-operations';
import { PrismaService } from '../../prisma/prisma.service';
import { parseDiscoveryV3Dispatch } from '../../runtime/discovery-v3-dispatch-contract';
import { claimDiscoveryV3Dispatch } from '../../temporal/discovery-v3.worker-activities';
import { formatTenantWorkflowId } from '../../temporal/tenant-workflow-id';
import type { Tool } from '../../tools/tool-contract';
import { ArtifactSubjectBindingContract } from './artifact-subject-binding.contract';
import { DiscoveryV3ArtifactExecution } from './discovery-v3-artifact.execution';
import { DiscoveryV3ArtifactRepository } from './discovery-v3-artifact.repository';
import { GenericOperationArtifactSubjectRepository } from './generic-operation-artifact-subject.repository';
import { productArtifactMaterializerRegistry } from './generic-operation-artifact.runtime';
import { S3GenericOperationArtifactStore } from './generic-operation-artifact.store';
import { BUCKET, MemoryS3Client } from './generic-operation-artifact.store.spec-helper';
import { PersonalArtifactCleanupService } from './personal-artifact-cleanup.contract';
import { PrismaPersonalArtifactCleanupCommandRepository, personalArtifactCleanupPersistence } from './personal-artifact-cleanup.repository';
import { S3PersonalArtifactCleanupAdapter } from './personal-artifact-cleanup.store';
import { VersionedBucketFixture } from './personal-artifact-cleanup.versioned-bucket.test-fixture';

const adminUrl = process.env.DISCOVERY_V3_TEST_ADMIN_URL;
const appUrl = process.env.APP_DATABASE_URL;

function assertIsolatedFixture(url: string | undefined): void {
  if (!url) return;
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.includes('test')) {
    throw new Error('discovery v3 Artifact test requires an isolated loopback test database');
  }
}

describe.skipIf(!adminUrl || !appUrl)('Discovery v3 Artifact database binding', () => {
  it.each([
    'replay', 'promoted then rolled back', 'unknown storage reply', 'unknown shared key',
    'purge confirmed orphan', 'unknown workspace purge',
  ] as const)(
    'keeps the final object discoverable by DSR after %s', async (scenario) => {
    assertIsolatedFixture(adminUrl);
    assertIsolatedFixture(appUrl);
    const owner = new PrismaClient({ datasourceUrl: adminUrl });
    const app = new PrismaService();
    const workspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const s3 = new MemoryS3Client();
    const repository = new DiscoveryV3ArtifactRepository();
    const subjectRepository = new GenericOperationArtifactSubjectRepository();
    const artifacts = new DiscoveryV3ArtifactExecution({
      withWorkspace: (id, fn, options) => app.withWorkspace(id, fn, options),
      binding: new ArtifactSubjectBindingContract(subjectRepository),
      repository,
      materializers: productArtifactMaterializerRegistry(),
      storage: new S3GenericOperationArtifactStore({ bucket: BUCKET, client: s3 }),
    });
    try {
      await owner.workspace.createMany({ data: [workspaceId, foreignWorkspaceId].map((id) => ({ id, name: 'Artifact fixture' })) });
      const profile = await owner.companyProfile.create({ data: { workspaceId, name: 'Fixture profile' } });
      const icp = await owner.icpDefinition.create({ data: { workspaceId, companyId: profile.id, name: 'Fixture ICP' } });
      const plan = await owner.discoveryQueryPlan.create({ data: { workspaceId, icpId: icp.id, status: 'READY', queries: [] } });
      const run = await admitDiscoveryV3(app, { workspaceId, userId: randomUUID(), roles: ['saas-admin'] }, plan.id, {}, {
        taskQueue: 'batch-discovery', runtime: { readyForNewAdmission: async () => true },
      });
      const event = await owner.outboxEvent.findFirstOrThrow({
        where: { workspaceId, aggregateId: run.runId, eventType: 'DiscoveryRunRequested' },
      });
      const dispatch = parseDiscoveryV3Dispatch(event.payload);
      const workflowId = formatTenantWorkflowId(workspaceId, 'discovery', run.runId);
      expect(await claimDiscoveryV3Dispatch(app, dispatch, workflowId, true)).toBe(true);

      const operations = new DiscoveryV3OperationStore(app);
      const operation = {
        step: 'profile/fixture/tool/1', kind: 'TOOL', ordinal: 1, requestSha256: 'a'.repeat(64),
        provider: 'crawl4ai.fetch', action: 'crawl4ai.fetch', method: 'invoke', maxDurationMs: 5_000,
      } as const;
      const claim = await operations.claim(dispatch, operation);
      if (claim.status !== 'CLAIMED') throw new Error('fixture did not claim tool operation');
      await operations.authorizeSend(dispatch, operation, claim, 1);
      const identity = { workspaceId, operationId: claim.operationId, requestSha256: operation.requestSha256 };
      const subjectRef = { subjectType: 'company_profile', subjectId: profile.id } as const;
      const tool = {
        id: 'crawl4ai.fetch',
        durableResultStrategy: {
          kind: 'artifact_reference', schema: 'crawl4ai-fetch/v1', maxBytes: 300_000,
          mediaTypes: ['text/markdown'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
        },
      } as unknown as Tool;
      const url = 'https://artifact.example.invalid/page?secret=synthetic';
      const capture = { identity, subjectRef, tool, input: { url },
        result: { data: { url, text: 'Synthetic Artifact body.' }, costCents: 0 } };
      const purgeDatabase = async (tx: Prisma.TransactionClient) => {
        const [result] = await tx.$queryRaw<{
          db_rows_deleted: Prisma.JsonObject;
          personal_objects_to_erase: Prisma.JsonArray;
        }[]>`
          SELECT db_rows_deleted, personal_objects_to_erase
          FROM public.purge_workspace_tenant_data_v1(${workspaceId}::uuid)
        `;
        return result;
      };
      const purge = () => app.withWorkspace(workspaceId, async (tx) => {
        await tx.$executeRaw`SELECT * FROM public.begin_workspace_purge_v1(${workspaceId}::uuid, 'artifact-fixture'::varchar)`;
        await tx.$executeRaw`SELECT public.mark_workspace_purge_running_v1(${workspaceId}::uuid)`;
        return purgeDatabase(tx);
      });
      const tombstone = async (subject: typeof subjectRef) => {
        const deletion = await owner.deletionRequest.create({
          data: { workspaceId, ...subject, requestedBy: 'fixture', reason: 'erasure' },
        });
        const enqueued = await app.withWorkspace(workspaceId, async (tx) => {
          await subjectRepository.tombstoneSubject(tx, { workspaceId, subjectRef: subject, deletionRequestId: deletion.id });
          const [result] = await tx.$queryRaw<{ command_count: number; shared_hold_count: number; version_hold_count: number }[]>`
            SELECT * FROM enqueue_workspace_personal_artifact_cleanup_v1(${workspaceId}::uuid, ${deletion.id}::uuid)
          `;
          return result;
        });
        return { deletion, enqueued };
      };
      if (scenario.startsWith('unknown')) {
        s3.finalPutFailure = 'after_commit';
        await expect(artifacts.prepare(capture)).rejects.toMatchObject({ code: 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN' });
        const intent = await owner.discoveryV3ArtifactPromotion.findUniqueOrThrow({
          where: { workspaceId_operationId: { workspaceId, operationId: identity.operationId } },
        });
        expect(intent).toMatchObject({ subjectId: profile.id, objectVersionId: null });
        if (scenario === 'unknown workspace purge') {
          await expect(purge()).rejects.toThrow('WORKSPACE_PURGE_ARTIFACT_PROMOTION_UNRESOLVED');
          expect(await owner.workspace.count({ where: { id: workspaceId } })).toBe(1);
          expect(await owner.discoveryV3ArtifactPromotion.count({ where: { workspaceId, operationId: identity.operationId } })).toBe(1);
          return;
        }
        const physical = s3.objects.get(intent.objectKey);
        if (!physical) throw new Error('fixture did not create a version');
        const bucket = new VersionedBucketFixture(BUCKET);
        bucket.putVersion(intent.objectKey, { versionId: physical.versionId });
        const cleanup = new PersonalArtifactCleanupService(
          new PrismaPersonalArtifactCleanupCommandRepository(personalArtifactCleanupPersistence(app)),
          new S3PersonalArtifactCleanupAdapter({ bucket: BUCKET, client: bucket }),
        );
        if (scenario === 'unknown shared key') {
          const other = await owner.companyProfile.create({ data: { workspaceId, name: 'Other fixture profile' } });
          const otherOperation = { ...operation, step: 'profile/shared/tool/1', requestSha256: 'd'.repeat(64) };
          const otherClaim = await operations.claim(dispatch, otherOperation);
          if (otherClaim.status !== 'CLAIMED') throw new Error('fixture did not claim second operation');
          await operations.authorizeSend(dispatch, otherOperation, otherClaim, 1);
          const otherSubject = { ...subjectRef, subjectId: other.id };
          s3.finalPutFailure = null;
          const shared = await artifacts.prepare({ ...capture, subjectRef: otherSubject,
            identity: { workspaceId, operationId: otherClaim.operationId, requestSha256: otherOperation.requestSha256 } });
          await shared.cleanup();
          const { deletion, enqueued } = await tombstone(subjectRef);
          expect(enqueued).toEqual({ command_count: 0, shared_hold_count: 1, version_hold_count: 1 });
          await expect(cleanup.cleanup({ workspaceId, deletionRequestId: deletion.id })).resolves.toEqual({
            status: 'HOLD', reason: 'SHARED_OBJECT_STILL_REFERENCED',
          });
          expect(bucket.commands).toHaveLength(0);
          expect(bucket.current(intent.objectKey)).toBe(physical.versionId);
          return;
        }
        const { deletion, enqueued } = await tombstone(subjectRef);
        expect(enqueued).toEqual({ command_count: 1, shared_hold_count: 0, version_hold_count: 1 });
        const request = { workspaceId, deletionRequestId: deletion.id };
        for (const version of ['late-version', null]) {
          await expect(cleanup.cleanup(request)).resolves.toEqual({
            status: 'HOLD', reason: 'EXACT_OBJECT_VERSION_UNAVAILABLE',
          });
          expect(bucket.versionIds(intent.objectKey)).toEqual({ objects: [], markers: [] });
          if (version) bucket.putVersion(intent.objectKey, { versionId: version });
        }
        expect(await owner.personalArtifactCleanupCommand.findFirstOrThrow({ where: request })).toMatchObject({
          status: 'CLAIMED', objectStatus: null, objectVersionId: null, completedAt: null,
        });
        return;
      }
      const prepared = await artifacts.prepare(capture);
      if (scenario === 'purge confirmed orphan') {
        try {
          const intent = await owner.discoveryV3ArtifactPromotion.findUniqueOrThrow({
            where: { workspaceId_operationId: { workspaceId, operationId: identity.operationId } },
          });
          expect(intent.objectVersionId).toBe(s3.objects.get(intent.objectKey)?.versionId);
          expect(await owner.genericOperationArtifact.count({ where: { workspaceId } })).toBe(0);
          const committed = await purge();
          expect(committed.db_rows_deleted).toMatchObject({ workspace: 1, discovery_run: 1 });
          expect(committed.personal_objects_to_erase).toEqual([{
            objectKey: intent.objectKey, sha256: intent.sha256,
            versionId: intent.objectVersionId, objectScope: 'workspace',
          }]);
          expect(await owner.workspace.count({ where: { id: workspaceId } })).toBe(0);
          // Temporal did not receive the activity response before retrying on fresh transactions.
          const retryPurge = () => app.withWorkspace(workspaceId, purgeDatabase);
          await expect(Promise.all([retryPurge(), retryPurge()])).resolves.toEqual([committed, committed]);
          await expect(app.withWorkspace(foreignWorkspaceId, purgeDatabase))
            .rejects.toThrow('WORKSPACE_PURGE_WORKSPACE_REQUIRED');
          await expect(app.withWorkspace(workspaceId, (tx) => tx.$queryRaw`
            SELECT 1 FROM public.workspace_purge_db_checkpoint LIMIT 1
          `)).rejects.toThrow('permission denied');
          const complete = (dbRowsDeleted: Prisma.JsonObject) => app.withWorkspace(workspaceId, (tx) =>
            tx.$queryRaw<{ id: string; status: string; cleanup_manifest: Prisma.JsonObject }[]>`
              SELECT id, status, cleanup_manifest FROM public.complete_workspace_purge_v1(
                ${workspaceId}::uuid, ${JSON.stringify(dbRowsDeleted)}::jsonb, '{}'::jsonb, 0, 0
              )
            `);
          await expect(complete({})).rejects.toThrow('WORKSPACE_PURGE_DB_CHECKPOINT_MISMATCH');
          await expect(retryPurge()).resolves.toEqual(committed);
          await app.withWorkspace(workspaceId, (tx) => tx.$executeRaw`
            SELECT public.fail_workspace_purge_v1(${workspaceId}::uuid, 'fixture storage retry'::varchar)
          `);
          await expect(complete(committed.db_rows_deleted)).rejects.toThrow('WORKSPACE_PURGE_DB_CHECKPOINT_MISMATCH');
          await expect(purge()).resolves.toEqual(committed);
          const [receipt] = await complete(committed.db_rows_deleted);
          expect(receipt).toMatchObject({ status: 'COMPLETED', cleanup_manifest: {} });
          await expect(owner.$queryRaw`
            SELECT receipt_id FROM public.workspace_purge_db_checkpoint WHERE receipt_id = ${receipt.id}::uuid
          `).resolves.toEqual([]);
        } finally {
          await prepared.cleanup();
        }
        return;
      }
      const receipt = {
        outcome: 'SUCCEEDED', result: prepared.projection,
        cost: { basis: 'CONFIRMED_ZERO', amountMicros: 0, currency: 'USD', evidenceSha256: 'b'.repeat(64) },
      } as const;
      const operationRow = () => owner.discoveryV3Operation.findUniqueOrThrow({ where: { id: claim.operationId } });
      try {
        await expect(operations.finish(dispatch, operation, claim, receipt, async () => {}))
          .rejects.toThrow('DISCOVERY_V3_ARTIFACT_RECEIPT_REQUIRED');
        expect(await operationRow()).toMatchObject({ status: 'IN_FLIGHT', result: null });
        expect(await owner.usageLedger.count({ where: { id: claim.operationId } })).toBe(0);
        if (scenario === 'promoted then rolled back') {
          await expect(operations.finish(dispatch, operation, claim, receipt, async (tx) => {
            await prepared.commit(tx);
            throw new Error('fixture interruption after the final object was written');
          })).rejects.toThrow('fixture interruption');
          const { deletion, enqueued } = await tombstone(subjectRef);
          expect(enqueued).toEqual({ command_count: 1, shared_hold_count: 0, version_hold_count: 0 });
          const [version] = await owner.$queryRaw<{ object_key: string; object_version_id: string }[]>`
            SELECT object_key, object_version_id FROM personal_artifact_cleanup_command WHERE deletion_request_id = ${deletion.id}::uuid
          `;
          expect(version.object_version_id).toBe(s3.objects.get(version.object_key)?.versionId);
          expect(await operationRow()).toMatchObject({ status: 'IN_FLIGHT', result: null });
          return;
        }
        await operations.finish(dispatch, operation, claim, receipt, prepared.commit);
        await operations.finish(dispatch, operation, claim, receipt, prepared.commit);
      } finally {
        await prepared.cleanup();
      }
      expect(await operationRow()).toMatchObject({
        status: 'SUCCEEDED', result: prepared.projection, resultSha256: prepared.projection.digest,
      });
      const artifact = await owner.genericOperationArtifact.findFirstOrThrow({
        where: { workspaceId, discoveryV3OperationId: claim.operationId },
      });
      expect(artifact).toMatchObject({
        executionContractVersion: 3, authorityId: null, operationId: null,
        expectedSanitizedUrl: 'https://artifact.example.invalid/page',
      });
      const replay = { identity, subjectRef, tool, projection: prepared.projection, resultSha256: prepared.projection.digest };
      await expect(artifacts.replay(replay)).resolves.toMatchObject({ data: { text: 'Synthetic Artifact body.' } });
      await expect(app.withWorkspace(foreignWorkspaceId, (tx) => repository.findExact(tx, replay)))
        .rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
      await expect(app.withWorkspace(workspaceId, (tx) => repository.findExact(tx, {
        ...replay, identity: { ...identity, requestSha256: '0'.repeat(64) },
      }))).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

      const deletion = await owner.deletionRequest.create({
        data: { workspaceId, ...subjectRef, requestedBy: 'fixture', reason: 'erasure' },
      });
      await app.withWorkspace(workspaceId, async (tx) => {
        await expect(subjectRepository.tombstoneSubject(tx, { workspaceId, subjectRef, deletionRequestId: deletion.id }))
          .resolves.toMatchObject({ artifactCount: 1 });
        const [enqueued] = await tx.$queryRaw<{ command_count: number; shared_hold_count: number; version_hold_count: number }[]>`
          SELECT * FROM enqueue_workspace_personal_artifact_cleanup_v1(${workspaceId}::uuid, ${deletion.id}::uuid)
        `;
        expect(enqueued).toEqual({ command_count: 1, shared_hold_count: 0, version_hold_count: 0 });
      });
      const [version] = await owner.$queryRaw<{ object_key: string; object_version_id: string }[]>`
        SELECT object_key, object_version_id FROM personal_artifact_cleanup_command
        WHERE deletion_request_id = ${deletion.id}::uuid
      `;
      expect(version).toEqual({
        object_key: artifact.objectKey, object_version_id: s3.objects.get(artifact.objectKey)?.versionId,
      });
      const objectCalls = s3.commands.length;
      await expect(artifacts.replay(replay)).rejects.toMatchObject({ code: 'GENERIC_OPERATION_ARTIFACT_INVALID' });
      expect(s3.commands).toHaveLength(objectCalls);
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  }, 20_000);
});
