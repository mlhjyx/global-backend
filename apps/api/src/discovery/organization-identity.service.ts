import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { lockWorkspaceOrganizationIdentity } from './organization-identity-root';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';
import {
  assertMergeProjectionSettled,
  assertOrganizationIdentityCommercialFactsMutable,
} from './organization-identity-commercial-guard';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type IdentityDecisionRequest = {
  requestId: string;
  decision: 'merge' | 'keep_separate';
  canonicalCompanyId?: string;
  reasonCode: string;
  note?: string;
};

export type IdentitySplitRequest = {
  requestId: string;
  reasonCode: string;
  note?: string;
};

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function conflictEtag(id: string, revision: number): string {
  return '"organization-identity-conflict:' + id + ':' + revision + '"';
}

export function mappingEtag(id: string, revision: number): string {
  return '"organization-identity-mapping:' + id + ':' + revision + '"';
}

export function parseRevisionEtag(raw: string | undefined, kind: 'conflict' | 'mapping', id: string): number {
  if (!raw) {
    throw new HttpException(
      {
        error: {
          code: 'PRECONDITION_REQUIRED',
          message: 'If-Match is required',
        },
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
  const prefix = kind === 'conflict' ? 'organization-identity-conflict' : 'organization-identity-mapping';
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp('^"' + prefix + ':' + escapedId + ':(\\d+)"$', 'u').exec(raw.trim());
  if (!match) {
    throw new HttpException({ error: { code: 'VALIDATION_ERROR', message: 'If-Match is malformed' } }, HttpStatus.BAD_REQUEST);
  }
  return Number(match[1]);
}

@Injectable()
export class OrganizationIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  listConflicts(
    ctx: RequestContext,
    input: {
      status?: 'open' | 'resolving' | 'resolved';
      cursor?: string;
      limit: number;
    },
  ) {
    if (input.cursor && !UUID_PATTERN.test(input.cursor)) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'identity conflict cursor must be a UUID',
        },
      });
    }
    if (input.status && !['open', 'resolving', 'resolved'].includes(input.status)) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'unsupported identity conflict status',
        },
      });
    }
    const status = input.status?.toUpperCase() as 'OPEN' | 'RESOLVING' | 'RESOLVED' | undefined;
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.organizationIdentityConflict.findMany({
        where: status ? { status } : {},
        include: { parties: { include: { company: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const data = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        data,
        hasMore,
        nextCursor: hasMore ? data[data.length - 1].id : null,
      };
    });
  }

  async getConflict(ctx: RequestContext, id: string) {
    const conflict = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.organizationIdentityConflict.findUnique({
        where: { id },
        include: {
          rawRecord: true,
          links: { include: { rawRecord: true } },
          parties: {
            include: {
              company: {
                include: {
                  organizationIdentifiers: { where: { status: 'ACTIVE' } },
                },
              },
            },
          },
          decisions: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    if (!conflict)
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'identity conflict not found' },
      });
    return { conflict, etag: conflictEtag(conflict.id, conflict.revision) };
  }

  decideConflict(ctx: RequestContext, conflictId: string, ifMatch: string | undefined, request: IdentityDecisionRequest) {
    const expectedRevision = parseRevisionEtag(ifMatch, 'conflict', conflictId);
    const normalized = {
      conflictId,
      decision: request.decision,
      canonicalCompanyId: request.canonicalCompanyId ?? null,
      reasonCode: request.reasonCode,
      note: request.note?.trim() || null,
    };
    const decisionHash = hashRequest(normalized);
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await lockWorkspaceSuppressionPolicy(tx, ctx.workspaceId);
      await lockWorkspaceOrganizationIdentity(tx, ctx.workspaceId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.workspaceId + ':identity-request:' + request.requestId}, 0))`;
      const previous = await tx.organizationIdentityDecision.findUnique({
        where: {
          workspaceId_requestId: {
            workspaceId: ctx.workspaceId,
            requestId: request.requestId,
          },
        },
      });
      if (previous) {
        if (previous.decisionHash !== decisionHash) {
          throw new ConflictException({
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'requestId was reused with different content',
            },
          });
        }
        return {
          decision: previous,
          replay: await tx.organizationIdentityReplay.findUnique({
            where: {
              workspaceId_decisionId: {
                workspaceId: ctx.workspaceId,
                decisionId: previous.id,
              },
            },
          }),
        };
      }
      await tx.$queryRaw`SELECT id FROM organization_identity_conflict WHERE id = ${conflictId}::uuid FOR UPDATE`;
      const conflict = await tx.organizationIdentityConflict.findUnique({
        where: { id: conflictId },
        include: { parties: true },
      });
      if (!conflict)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'identity conflict not found' },
        });
      if (conflict.revision !== expectedRevision || conflict.status !== 'OPEN') {
        throw new PreconditionFailedException({
          error: {
            code: 'IDENTITY_REVISION_CONFLICT',
            message: 'identity conflict changed; reload before deciding',
          },
        });
      }
      const companyIds = [...new Set(conflict.parties.map((party) => party.companyId))];
      if (!companyIds.length)
        throw new ConflictException({
          error: {
            code: 'NO_CANDIDATES',
            message: 'conflict has no candidate companies',
          },
        });
      if (request.decision === 'merge') {
        if (companyIds.length < 2) {
          throw new ConflictException({
            error: {
              code: 'IDENTITY_MERGE_REQUIRES_MULTIPLE_COMPANIES',
              message: 'merge requires at least two candidate companies; use keep_separate for a rejected enrichment claim',
            },
          });
        }
        if (!request.canonicalCompanyId || !companyIds.includes(request.canonicalCompanyId)) {
          throw new ConflictException({
            error: {
              code: 'INVALID_CANONICAL_COMPANY',
              message: 'canonical company must be a conflict candidate',
            },
          });
        }
        const sourceCompanyIds = companyIds.filter((id) => id !== request.canonicalCompanyId);
        const incompatibleMapping = await tx.organizationCanonicalMapping.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            status: 'ACTIVE',
            OR: [{ sourceCompanyId: request.canonicalCompanyId }, { canonicalCompanyId: { in: sourceCompanyIds } }],
          },
          select: { id: true },
        });
        if (incompatibleMapping) {
          throw new ConflictException({
            error: {
              code: 'IDENTITY_MAPPING_REQUIRES_REROOT',
              message: 'selected companies already participate in an incompatible active identity mapping',
            },
          });
        }
        await assertOrganizationIdentityCommercialFactsMutable(tx, ctx.workspaceId, companyIds);
      } else if (request.canonicalCompanyId) {
        throw new ConflictException({
          error: {
            code: 'INVALID_CANONICAL_COMPANY',
            message: 'keep_separate must not select a canonical company',
          },
        });
      }
      const decision = await tx.organizationIdentityDecision.create({
        data: {
          workspaceId: ctx.workspaceId,
          conflictId,
          action: request.decision === 'merge' ? 'MERGE' : 'KEEP_SEPARATE',
          canonicalCompanyId: request.canonicalCompanyId ?? null,
          requestId: request.requestId,
          expectedRevision,
          reasonCode: request.reasonCode,
          note: request.note?.trim() || null,
          decidedBy: ctx.userId,
          decisionHash,
          factSnapshot: conflict.facts as Prisma.InputJsonValue,
        },
      });
      if (request.decision === 'merge') {
        const canonicalCompanyId = request.canonicalCompanyId!;
        for (const sourceCompanyId of companyIds.filter((id) => id !== canonicalCompanyId)) {
          await tx.organizationCanonicalMapping.create({
            data: {
              workspaceId: ctx.workspaceId,
              sourceCompanyId,
              canonicalCompanyId,
              mergeDecisionId: decision.id,
            },
          });
        }
      }
      const replay = await tx.organizationIdentityReplay.create({
        data: {
          workspaceId: ctx.workspaceId,
          decisionId: decision.id,
          inputHash: decisionHash,
        },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'OrganizationIdentityReplayRequested',
          aggregateType: 'OrganizationIdentityReplay',
          aggregateId: replay.id,
          payload: { replayId: replay.id, decisionId: decision.id },
        },
      });
      await tx.organizationIdentityConflict.update({
        where: { id: conflict.id },
        data: { status: 'RESOLVING', revision: { increment: 1 } },
      });
      return { decision, replay };
    });
  }

  async getMapping(ctx: RequestContext, id: string) {
    const mapping = await this.prisma.withWorkspace(ctx.workspaceId, (tx) => tx.organizationCanonicalMapping.findUnique({ where: { id } }));
    if (!mapping)
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'identity mapping not found' },
      });
    return { mapping, etag: mappingEtag(mapping.id, mapping.revision) };
  }

  splitMapping(ctx: RequestContext, mappingId: string, ifMatch: string | undefined, request: IdentitySplitRequest) {
    const expectedRevision = parseRevisionEtag(ifMatch, 'mapping', mappingId);
    const normalized = {
      mappingId,
      decision: 'split',
      reasonCode: request.reasonCode,
      note: request.note?.trim() || null,
    };
    const decisionHash = hashRequest(normalized);
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await lockWorkspaceSuppressionPolicy(tx, ctx.workspaceId);
      await lockWorkspaceOrganizationIdentity(tx, ctx.workspaceId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.workspaceId + ':identity-request:' + request.requestId}, 0))`;
      const previous = await tx.organizationIdentityDecision.findUnique({
        where: {
          workspaceId_requestId: {
            workspaceId: ctx.workspaceId,
            requestId: request.requestId,
          },
        },
      });
      if (previous) {
        if (previous.decisionHash !== decisionHash)
          throw new ConflictException({
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'requestId was reused with different content',
            },
          });
        return {
          decision: previous,
          replay: await tx.organizationIdentityReplay.findUnique({
            where: {
              workspaceId_decisionId: {
                workspaceId: ctx.workspaceId,
                decisionId: previous.id,
              },
            },
          }),
        };
      }
      await tx.$queryRaw`SELECT id FROM organization_canonical_mapping WHERE id = ${mappingId}::uuid FOR UPDATE`;
      const mapping = await tx.organizationCanonicalMapping.findUnique({
        where: { id: mappingId },
        include: {
          mergeDecision: {
            include: { replay: true, conflict: true },
          },
        },
      });
      if (!mapping)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'identity mapping not found' },
        });
      if (mapping.revision !== expectedRevision || mapping.status !== 'ACTIVE') {
        throw new PreconditionFailedException({
          error: {
            code: 'IDENTITY_REVISION_CONFLICT',
            message: 'identity mapping changed; reload before splitting',
          },
        });
      }
      assertMergeProjectionSettled(mapping);
      const pendingSplit = await tx.organizationIdentityReplay.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          status: { in: ['PENDING', 'RUNNING'] },
          decision: {
            action: 'SPLIT',
            factSnapshot: {
              path: ['mappingId'],
              equals: mappingId,
            },
          },
        },
        select: { id: true },
      });
      if (pendingSplit) {
        throw new ConflictException({
          error: {
            code: 'IDENTITY_SPLIT_ALREADY_PENDING',
            message: 'identity mapping already has a pending split replay',
          },
        });
      }
      await assertOrganizationIdentityCommercialFactsMutable(
        tx,
        ctx.workspaceId,
        [mapping.sourceCompanyId, mapping.canonicalCompanyId],
      );
      const decision = await tx.organizationIdentityDecision.create({
        data: {
          workspaceId: ctx.workspaceId,
          action: 'SPLIT',
          requestId: request.requestId,
          expectedRevision,
          reasonCode: request.reasonCode,
          note: request.note?.trim() || null,
          decidedBy: ctx.userId,
          decisionHash,
          factSnapshot: {
            mappingId,
            sourceCompanyId: mapping.sourceCompanyId,
            canonicalCompanyId: mapping.canonicalCompanyId,
          },
        },
      });
      const replay = await tx.organizationIdentityReplay.create({
        data: {
          workspaceId: ctx.workspaceId,
          decisionId: decision.id,
          inputHash: decisionHash,
        },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'OrganizationIdentityReplayRequested',
          aggregateType: 'OrganizationIdentityReplay',
          aggregateId: replay.id,
          payload: { replayId: replay.id, decisionId: decision.id, mappingId },
        },
      });
      return { decision, replay };
    });
  }
}
