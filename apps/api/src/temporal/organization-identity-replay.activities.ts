import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lockWorkspaceOrganizationIdentity } from '../discovery/organization-identity-root';
import { lockWorkspaceSuppressionPolicy } from '../discovery/suppression-policy-lock';
import {
  assertMergeProjectionSettled,
  assertOrganizationIdentityCommercialFactsMutable,
} from '../discovery/organization-identity-commercial-guard';

export interface OrganizationIdentityReplayInput {
  workspaceId: string;
  replayId: string;
}

export interface OrganizationIdentityReplayActivities {
  processOrganizationIdentityReplay(input: OrganizationIdentityReplayInput): Promise<{ status: 'SUCCEEDED'; replayId: string }>;
}

function outputHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const SAFE_ERROR_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;

class OrganizationIdentityReplayExecutionError extends Error {
  readonly name = 'OrganizationIdentityReplayExecutionError';

  constructor(
    readonly code: 'IDENTITY_REPLAY_ALREADY_RUNNING' | 'IDENTITY_REPLAY_CLAIM_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

function stableReplayErrorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && SAFE_ERROR_ID.test(candidate.code)) return candidate.code;
    if (typeof candidate.name === 'string' && candidate.name !== 'Error' && SAFE_ERROR_ID.test(candidate.name)) {
      return candidate.name;
    }
    current = candidate.cause;
  }
  return 'IDENTITY_REPLAY_FAILED';
}

function splitMappingId(factSnapshot: Prisma.JsonValue): string {
  if (
    !factSnapshot ||
    typeof factSnapshot !== 'object' ||
    Array.isArray(factSnapshot) ||
    typeof factSnapshot.mappingId !== 'string' ||
    !factSnapshot.mappingId
  ) {
    throw new Error('split decision has no mapping id');
  }
  return factSnapshot.mappingId;
}

async function resolveMappedRoot(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyId: string,
): Promise<string> {
  const mapping = await tx.organizationCanonicalMapping.findFirst({
    where: { workspaceId, sourceCompanyId: companyId, status: 'ACTIVE' },
    select: { canonicalCompanyId: true },
  });
  return mapping?.canonicalCompanyId ?? companyId;
}

async function projectPendingIdentifiers(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    conflictId: string;
    rawRecordIds: readonly string[];
    action: 'MERGE' | 'KEEP_SEPARATE';
    canonicalCompanyId: string | null;
  },
): Promise<void> {
  const pending = await tx.organizationIdentifier.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: 'PENDING_CONFLICT',
      OR: [
        { conflictId: input.conflictId },
        ...(input.rawRecordIds.length
          ? [{ conflictId: null, rawRecordId: { in: [...input.rawRecordIds] } }]
          : []),
      ],
    },
  });
  if (!pending.length) return;
  if (input.action === 'KEEP_SEPARATE') {
    await tx.organizationIdentifier.updateMany({
      where: { id: { in: pending.map((identifier) => identifier.id) }, status: 'PENDING_CONFLICT' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    return;
  }
  if (!input.canonicalCompanyId) throw new Error('merge decision has no canonical company');

  for (const identifier of pending) {
    const proposedRoot = await resolveMappedRoot(tx, input.workspaceId, identifier.companyId);
    if (proposedRoot !== input.canonicalCompanyId) {
      throw new Error('pending identifier company is outside the selected merge root');
    }
    const active = await tx.organizationIdentifier.findFirst({
      where: {
        workspaceId: input.workspaceId,
        scheme: identifier.scheme,
        jurisdiction: identifier.jurisdiction,
        normalizedValue: identifier.normalizedValue,
        status: 'ACTIVE',
      },
    });
    if (active) {
      const activeRoot = await resolveMappedRoot(tx, input.workspaceId, active.companyId);
      if (activeRoot !== input.canonicalCompanyId) {
        throw new Error('active identifier binding is outside the selected merge root');
      }
      await tx.organizationIdentifier.update({
        where: { id: identifier.id },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      continue;
    }
    await tx.organizationIdentifier.update({
      where: { id: identifier.id },
      data: { status: 'ACTIVE', revokedAt: null, lastSeenAt: new Date() },
    });
  }
}

export function createOrganizationIdentityReplayActivities(deps: { prisma: PrismaService }): OrganizationIdentityReplayActivities {
  return {
    async processOrganizationIdentityReplay(input) {
      try {
        return await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
          await lockWorkspaceSuppressionPolicy(tx, input.workspaceId);
          await lockWorkspaceOrganizationIdentity(tx, input.workspaceId);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.workspaceId + ':identity-replay:' + input.replayId}, 0))`;
          const replay = await tx.organizationIdentityReplay.findUnique({
            where: { id: input.replayId },
            include: { decision: true },
          });
          if (!replay) throw new Error('identity replay not found');
          if (replay.status === 'SUCCEEDED') return { status: 'SUCCEEDED' as const, replayId: replay.id };
          if (replay.status === 'RUNNING') {
            throw new OrganizationIdentityReplayExecutionError(
              'IDENTITY_REPLAY_ALREADY_RUNNING',
              'identity replay is already running',
            );
          }
          const claimed = await tx.organizationIdentityReplay.updateMany({
            where: { id: replay.id, status: { in: ['PENDING', 'FAILED'] } },
            data: {
              status: 'RUNNING',
              attempt: { increment: 1 },
              completedAt: null,
              errorCode: null,
            },
          });
          if (claimed.count !== 1) {
            throw new OrganizationIdentityReplayExecutionError(
              'IDENTITY_REPLAY_CLAIM_CONFLICT',
              'identity replay claim changed concurrently',
            );
          }
          const decision = replay.decision;
          if (decision.action === 'MERGE' || decision.action === 'KEEP_SEPARATE') {
            if (!decision.conflictId) throw new Error('merge/keep-separate decision has no conflict');
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.workspaceId + ':identity-conflict:' + decision.conflictId}, 0))`;
            if (decision.action === 'MERGE') {
              const parties = await tx.organizationIdentityConflictParty.findMany({
                where: { workspaceId: input.workspaceId, conflictId: decision.conflictId },
                select: { companyId: true },
              });
              await assertOrganizationIdentityCommercialFactsMutable(
                tx,
                input.workspaceId,
                parties.map((party) => party.companyId),
              );
            }
            const links = await tx.identityLink.findMany({
              where: {
                conflictId: decision.conflictId,
                status: 'PENDING_CONFLICT',
              },
            });
            await tx.identityLink.updateMany({
              where: {
                conflictId: decision.conflictId,
                status: 'PENDING_CONFLICT',
              },
              data: { status: 'REVOKED' },
            });
            const rawRecordIds = [...new Set(links.map((link) => link.rawRecordId))];
            if (decision.action === 'MERGE') {
              if (!decision.canonicalCompanyId) throw new Error('merge decision has no canonical company');
              const perRaw = new Map<string, (typeof links)[number]>();
              for (const link of links) if (!perRaw.has(link.rawRecordId)) perRaw.set(link.rawRecordId, link);
              for (const link of perRaw.values()) {
                const existing = await tx.identityLink.findFirst({
                  where: {
                    workspaceId: input.workspaceId,
                    canonicalType: 'company',
                    canonicalId: decision.canonicalCompanyId,
                    rawRecordId: link.rawRecordId,
                  },
                });
                if (existing) {
                  // The batch above already moves every original pending edge to REVOKED.
                  // conflictId, not the transient status, is the durable marker that this
                  // row must keep its original rule/confidence for a later split replay.
                  const isOriginalConflictEdge = existing.conflictId === decision.conflictId;
                  await tx.identityLink.update({
                    where: { id: existing.id },
                    data: isOriginalConflictEdge
                      ? { status: 'ACTIVE' }
                      : {
                          status: 'ACTIVE',
                          matchRule: 'manual_merge',
                          confidence: 1,
                        },
                  });
                } else {
                  await tx.identityLink.create({
                    data: {
                      workspaceId: input.workspaceId,
                      canonicalType: 'company',
                      canonicalId: decision.canonicalCompanyId,
                      rawRecordId: link.rawRecordId,
                      matchRule: 'manual_merge',
                      confidence: 1,
                      status: 'ACTIVE',
                      resolverVersion: link.resolverVersion,
                      inputHash: link.inputHash,
                      conflictId: decision.conflictId,
                    },
                  });
                }
              }
            }
            await projectPendingIdentifiers(tx, {
              workspaceId: input.workspaceId,
              conflictId: decision.conflictId,
              rawRecordIds,
              action: decision.action,
              canonicalCompanyId: decision.canonicalCompanyId,
            });
            await tx.organizationIdentityConflict.update({
              where: { id: decision.conflictId },
              data: {
                status: 'RESOLVED',
                revision: { increment: 1 },
                resolvedAt: new Date(),
              },
            });
          } else {
            const mappingId = splitMappingId(decision.factSnapshot);
            await tx.$queryRaw`SELECT id FROM organization_canonical_mapping WHERE id = ${mappingId}::uuid FOR UPDATE`;
            const mapping = await tx.organizationCanonicalMapping.findUnique({
              where: { id: mappingId },
              include: {
                mergeDecision: {
                  include: { replay: true, conflict: true },
                },
              },
            });
            if (!mapping) throw new Error('split decision mapping not found');
            if (
              mapping.status !== 'ACTIVE' ||
              mapping.revision !== decision.expectedRevision ||
              mapping.splitDecisionId !== null
            ) {
              throw new Error('split decision mapping changed before replay');
            }
            assertMergeProjectionSettled(mapping);
            await assertOrganizationIdentityCommercialFactsMutable(
              tx,
              input.workspaceId,
              [mapping.sourceCompanyId, mapping.canonicalCompanyId],
            );
            const originalConflictId = mapping.mergeDecision.conflictId;
            if (originalConflictId) {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.workspaceId + ':identity-conflict:' + originalConflictId}, 0))`;
              const originalLinks = await tx.identityLink.findMany({
                where: { workspaceId: input.workspaceId, conflictId: originalConflictId },
                select: { rawRecordId: true },
              });
              const rawRecordIds = [...new Set(originalLinks.map((link) => link.rawRecordId))];
              if (rawRecordIds.length) {
                await tx.identityLink.updateMany({
                  where: {
                    workspaceId: input.workspaceId,
                    conflictId: originalConflictId,
                    rawRecordId: { in: rawRecordIds },
                    matchRule: 'manual_merge',
                    status: 'ACTIVE',
                  },
                  data: { status: 'REVOKED' },
                });
              }
              // Enrichment conflicts deliberately have no Raw link. Claims are
              // tied directly to conflictId, while the second branch preserves
              // compatibility with older Raw-backed claims that predate that
              // association. Never sweep claims owned by another conflict.
              await tx.organizationIdentifier.updateMany({
                where: {
                  workspaceId: input.workspaceId,
                  OR: [
                    { conflictId: originalConflictId },
                    ...(rawRecordIds.length
                      ? [{ conflictId: null, rawRecordId: { in: rawRecordIds } }]
                      : []),
                  ],
                  status: { in: ['ACTIVE', 'REVOKED'] },
                },
                data: { status: 'PENDING_CONFLICT', revokedAt: null },
              });
              await tx.organizationIdentityConflict.update({
                where: { id: originalConflictId },
                data: {
                  status: 'OPEN',
                  revision: { increment: 1 },
                  resolvedAt: null,
                },
              });
              await tx.identityLink.updateMany({
                where: {
                  workspaceId: input.workspaceId,
                  conflictId: originalConflictId,
                  matchRule: { not: 'manual_merge' },
                },
                data: { status: 'PENDING_CONFLICT' },
              });
            }
            const revoked = await tx.organizationCanonicalMapping.updateMany({
              where: {
                id: mapping.id,
                status: 'ACTIVE',
                revision: decision.expectedRevision,
              },
              data: {
                status: 'REVOKED',
                revision: { increment: 1 },
                splitDecisionId: decision.id,
                revokedAt: new Date(),
              },
            });
            if (revoked.count !== 1) throw new Error('split decision mapping changed before commit');
          }
          const digest = outputHash({
            replayId: replay.id,
            decisionId: decision.id,
            action: decision.action,
          });
          await tx.organizationIdentityReplay.update({
            where: { id: replay.id },
            data: {
              status: 'SUCCEEDED',
              outputHash: digest,
              completedAt: new Date(),
              errorCode: null,
            },
          });
          return { status: 'SUCCEEDED' as const, replayId: replay.id };
        });
      } catch (error) {
        await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
          tx.organizationIdentityReplay.updateMany({
            where: { id: input.replayId, status: { in: ['PENDING', 'FAILED'] } },
            data: {
              status: 'FAILED',
              // The RUNNING claim and its increment are rolled back together with
              // a failed projection. Record the durable failed attempt here.
              attempt: { increment: 1 },
              completedAt: new Date(),
              errorCode: stableReplayErrorCode(error),
            },
          }),
        );
        throw error;
      }
    },
  };
}
