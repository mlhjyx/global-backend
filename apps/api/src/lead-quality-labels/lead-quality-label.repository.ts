import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";
import {
  classifyLeadQualityLabel,
  type LeadQualityCommercialResult,
  type LeadQualityDisposition,
  type LeadQualityHeldReason,
  type LeadQualityLabel,
  type LeadQualityReasonCode,
  type NormalizedLeadQualityLabelRequest,
} from "./lead-quality-label.domain";

export interface LeadQualityLabelRecord {
  id: string;
  workspaceId: string;
  sourceEventId: string;
  leadId: string;
  leadQualifiedEventId: string;
  label: LeadQualityLabel;
  occurredAt: Date;
  sourceSystem: string;
  externalObjectRef: string | null;
  reasonCode: LeadQualityReasonCode | null;
  commercialResult: LeadQualityCommercialResult | null;
  disposition: LeadQualityDisposition;
  heldReason: LeadQualityHeldReason | null;
  actorId: string;
  ingestedAt: Date;
}

export interface AppendLeadQualityLabelResult {
  record: LeadQualityLabelRecord;
  replayed: boolean;
}

export const MIN_CONFIRMED_QGO_LABELS = 50;

function sourceEventConflict(): ConflictException {
  return new ConflictException({
    error: {
      code: "SOURCE_EVENT_CONFLICT",
      message: "source event was already recorded with different label content",
    },
  });
}

function isSourceEventUniqueConflict(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "P2002"
  ) {
    return false;
  }
  const meta = "meta" in error && isRecord(error.meta) ? error.meta : null;
  const target = meta?.target;
  if (target === "lead_quality_label_source_event_key") return true;
  if (!Array.isArray(target)) return false;
  const normalized = target.map(String).sort();
  return (
    JSON.stringify(normalized) ===
      JSON.stringify(["sourceEventId", "sourceSystem", "workspaceId"].sort()) ||
    JSON.stringify(normalized) ===
      JSON.stringify(
        ["source_event_id", "source_system", "workspace_id"].sort(),
      )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): LeadQualityLabelRecord {
  return value as LeadQualityLabelRecord;
}

function isIdenticalReplay(
  row: LeadQualityLabelRecord,
  request: NormalizedLeadQualityLabelRequest,
): boolean {
  return (
    row.sourceEventId === request.sourceEventId &&
    row.sourceSystem === request.sourceSystem &&
    row.leadId === request.leadId &&
    row.leadQualifiedEventId === request.leadQualifiedEventId &&
    row.label === request.label &&
    row.occurredAt.getTime() === request.occurredAt.getTime() &&
    row.externalObjectRef === request.externalObjectRef &&
    row.reasonCode === request.reasonCode &&
    row.commercialResult === request.commercialResult
  );
}

@Injectable()
export class LeadQualityLabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(
    ctx: RequestContext,
    request: NormalizedLeadQualityLabelRequest,
  ): Promise<AppendLeadQualityLabelResult> {
    const existing = await this.findBySourceEvent(ctx.workspaceId, request);
    if (existing) return this.replayOrConflict(existing, request);

    try {
      return await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
        const rechecked = await tx.leadQualityLabel.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            sourceSystem: request.sourceSystem,
            sourceEventId: request.sourceEventId,
          },
        });
        if (rechecked)
          return this.replayOrConflict(asRecord(rechecked), request);

        const lockedLead = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "lead"
          WHERE "id" = ${request.leadId}::uuid
            AND "workspace_id" = ${ctx.workspaceId}::uuid
          FOR UPDATE
        `);
        if (lockedLead.length !== 1) {
          throw new NotFoundException({
            error: {
              code: "LEAD_NOT_FOUND",
              message: "lead was not found in the active workspace",
            },
          });
        }

        const handoff = await tx.outboxEvent.findFirst({
          where: {
            eventId: request.leadQualifiedEventId,
            workspaceId: ctx.workspaceId,
            eventType: "LeadQualified",
            aggregateType: "Lead",
            aggregateId: request.leadId,
          },
          select: { eventId: true, occurredAt: true },
        });
        if (!handoff) {
          throw new NotFoundException({
            error: {
              code: "LEAD_QUALIFIED_EVENT_NOT_FOUND",
              message: "matching LeadQualified handoff event was not found",
            },
          });
        }

        const accepted = await tx.leadQualityLabel.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            leadId: request.leadId,
            leadQualifiedEventId: request.leadQualifiedEventId,
            disposition: "ACCEPTED",
          },
          select: {
            label: true,
            reasonCode: true,
            commercialResult: true,
            occurredAt: true,
          },
        });
        const classification = classifyLeadQualityLabel(request, accepted, {
          handoffOccurredAt: handoff.occurredAt,
          observedAt: new Date(),
        });
        const created = await tx.leadQualityLabel.create({
          data: {
            workspaceId: ctx.workspaceId,
            sourceEventId: request.sourceEventId,
            leadId: request.leadId,
            leadQualifiedEventId: request.leadQualifiedEventId,
            label: request.label,
            occurredAt: request.occurredAt,
            sourceSystem: request.sourceSystem,
            externalObjectRef: request.externalObjectRef,
            reasonCode: request.reasonCode,
            commercialResult: request.commercialResult,
            disposition: classification.disposition,
            heldReason: classification.heldReason,
            actorId: ctx.userId,
          },
        });
        return { record: asRecord(created), replayed: false };
      });
    } catch (error) {
      if (!isSourceEventUniqueConflict(error)) throw error;
      const raced = await this.findBySourceEvent(ctx.workspaceId, request);
      if (!raced) throw sourceEventConflict();
      return this.replayOrConflict(raced, request);
    }
  }

  private async findBySourceEvent(
    workspaceId: string,
    request: Pick<
      NormalizedLeadQualityLabelRequest,
      "sourceSystem" | "sourceEventId"
    >,
  ): Promise<LeadQualityLabelRecord | null> {
    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const row = await tx.leadQualityLabel.findFirst({
        where: {
          workspaceId,
          sourceSystem: request.sourceSystem,
          sourceEventId: request.sourceEventId,
        },
      });
      return row ? asRecord(row) : null;
    });
  }

  private replayOrConflict(
    existing: LeadQualityLabelRecord,
    request: NormalizedLeadQualityLabelRequest,
  ): AppendLeadQualityLabelResult {
    if (!isIdenticalReplay(existing, request)) throw sourceEventConflict();
    return { record: existing, replayed: true };
  }
}

/** Reference backend consumer: its query excludes HELD rows at the data boundary. */
@Injectable()
export class LeadQualityLabelLearningConsumer {
  constructor(private readonly prisma: PrismaService) {}

  /** Offline observability only; callers must not treat this as a tuning batch. */
  observeForHandoff(
    ctx: RequestContext,
    leadId: string,
    leadQualifiedEventId: string,
  ): Promise<LeadQualityLabelRecord[]> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.leadQualityLabel.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          leadId,
          leadQualifiedEventId,
          disposition: "ACCEPTED",
        },
        orderBy: [{ occurredAt: "asc" }, { ingestedAt: "asc" }, { id: "asc" }],
      });
      return rows.map(asRecord);
    });
  }

  /**
   * The only tunable-batch seam. It returns no labels until 50 independently
   * accepted QGO_CREATED facts exist in the workspace; HELD rows are excluded.
   */
  buildTuningBatch(ctx: RequestContext): Promise<{
    eligible: boolean;
    confirmedQgoLabels: number;
    minimumRequired: number;
    labels: LeadQualityLabelRecord[];
  }> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const confirmedQgoHandoffs = await tx.leadQualityLabel.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          label: "QGO_CREATED",
          disposition: "ACCEPTED",
        },
        select: { leadQualifiedEventId: true },
        distinct: ["leadQualifiedEventId"],
      });
      const confirmedQgoLabels = confirmedQgoHandoffs.length;
      if (confirmedQgoLabels < MIN_CONFIRMED_QGO_LABELS) {
        return {
          eligible: false,
          confirmedQgoLabels,
          minimumRequired: MIN_CONFIRMED_QGO_LABELS,
          labels: [],
        };
      }
      const rows = (
        await tx.leadQualityLabel.findMany({
          where: { workspaceId: ctx.workspaceId, disposition: "ACCEPTED" },
          orderBy: [
            { occurredAt: "asc" },
            { ingestedAt: "asc" },
            { id: "asc" },
          ],
        })
      ).map(asRecord);
      const seenFacts = new Set<string>();
      const independentFacts = rows.filter((row) => {
        // One handoff contributes at most one fact per semantic stage. Legacy
        // or imported rows that disagree about rejection reason or commercial
        // result therefore cannot both enter the learning batch.
        const identity = [row.leadQualifiedEventId, row.label].join("\u0000");
        if (seenFacts.has(identity)) return false;
        seenFacts.add(identity);
        return true;
      });
      return {
        eligible: true,
        confirmedQgoLabels,
        minimumRequired: MIN_CONFIRMED_QGO_LABELS,
        labels: independentFacts,
      };
    });
  }
}
