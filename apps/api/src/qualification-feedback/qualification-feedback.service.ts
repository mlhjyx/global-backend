import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, type QualificationFeedbackReceipt } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestContext } from "../auth/request-context";
import {
  parseQualificationFeedback,
  qualificationFeedbackDigest,
} from "./qualification-feedback.contract";

export const QUALIFICATION_FEEDBACK_PRINCIPAL =
  "growthos-qualification-feedback";
export interface RecordedQualificationFeedback {
  status: "RECORDED";
  receiptId: string;
  eventId: string;
  workspaceId: string;
  eventDigest: string;
  receivedAt: string;
}
export type QualificationFeedbackStatus =
  | RecordedQualificationFeedback
  | { status: "NOT_RECEIVED"; eventId: string; workspaceId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function requireActor(ctx: RequestContext): void {
  if (
    !ctx ||
    ctx.userId !== QUALIFICATION_FEEDBACK_PRINCIPAL ||
    !ctx.scopes?.includes("acquisition:label:write") ||
    !uuid.test(ctx.workspaceId)
  )
    throw new ForbiddenException({
      error: {
        code: "FEEDBACK_FORBIDDEN",
        message: "feedback service identity required",
      },
    });
}
function conflict(): ConflictException {
  return new ConflictException({
    error: {
      code: "FEEDBACK_IDENTITY_CONFLICT",
      message: "feedback identity conflicts with an existing receipt",
    },
  });
}
function leadUnavailable(): NotFoundException {
  return new NotFoundException({
    error: {
      code: "FEEDBACK_LEAD_UNAVAILABLE",
      message: "feedback lead reference is unavailable",
    },
  });
}
function recorded(
  row: QualificationFeedbackReceipt,
): RecordedQualificationFeedback {
  return {
    status: "RECORDED",
    receiptId: row.id,
    eventId: row.eventId,
    workspaceId: row.workspaceId,
    eventDigest: row.eventDigest,
    receivedAt: row.receivedAt.toISOString(),
  };
}
function unavailable(error: unknown): never {
  if (error instanceof ConflictException || error instanceof NotFoundException)
    throw error;
  throw new ServiceUnavailableException({
    error: {
      code: "FEEDBACK_STORAGE_UNAVAILABLE",
      message: "feedback storage unavailable",
    },
  });
}
@Injectable()
export class QualificationFeedbackService {
  constructor(private readonly prisma: PrismaService) {}
  async receive(
    ctx: RequestContext,
    input: unknown,
  ): Promise<RecordedQualificationFeedback> {
    requireActor(ctx);
    const event = parseQualificationFeedback(input);
    if (event.workspaceId !== ctx.workspaceId)
      throw new ForbiddenException({
        error: {
          code: "FEEDBACK_WORKSPACE_MISMATCH",
          message: "feedback workspace does not match authorization",
        },
      });
    const digest = qualificationFeedbackDigest(event);
    try {
      return await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
        const where = {
          workspaceId_eventId: {
            workspaceId: ctx.workspaceId,
            eventId: event.eventId,
          },
        };
        const existing = await tx.qualificationFeedbackReceipt.findUnique({
          where,
        });
        if (existing) {
          if (existing.eventDigest !== digest) throw conflict();
          return recorded(existing);
        }
        // Discover the company without locking Lead first. Suppression/deletion takes
        // company locks before downstream rows; reversing that order could deadlock.
        const references = await tx.$queryRaw<
          Array<{ id: string; workspaceId: string; canonicalCompanyId: string }>
        >(Prisma.sql`
          SELECT id,workspace_id AS "workspaceId",canonical_company_id AS "canonicalCompanyId" FROM lead
          WHERE id=${event.leadId}::uuid AND workspace_id=${ctx.workspaceId}::uuid`);
        const reference = references[0];
        if (
          references.length !== 1 ||
          !reference ||
          reference.id !== event.leadId ||
          reference.workspaceId !== ctx.workspaceId ||
          !uuid.test(reference.canonicalCompanyId)
        )
          throw leadUnavailable();
        // Company SUPPRESSED is authoritative before asynchronous Lead updates.
        // SHARE conflicts with the freeze UPDATE and stays held through commit.
        const companies = await tx.$queryRaw<
          Array<{ id: string; workspaceId: string; status: string }>
        >(Prisma.sql`
          SELECT id,workspace_id AS "workspaceId",status FROM canonical_company
          WHERE id=${reference.canonicalCompanyId}::uuid AND workspace_id=${ctx.workspaceId}::uuid FOR SHARE`);
        const company = companies[0];
        if (
          companies.length !== 1 ||
          !company ||
          company.id !== reference.canonicalCompanyId ||
          company.workspaceId !== ctx.workspaceId ||
          company.status === "SUPPRESSED"
        )
          throw leadUnavailable();
        // Revalidate the reference under the Lead lock: the first read may be stale.
        const leads = await tx.$queryRaw<
          Array<{
            id: string;
            workspaceId: string;
            canonicalCompanyId: string;
            status: string;
            queue: string;
          }>
        >(Prisma.sql`
          SELECT id,workspace_id AS "workspaceId",canonical_company_id AS "canonicalCompanyId",status::text AS status,queue FROM lead
          WHERE id=${event.leadId}::uuid AND workspace_id=${ctx.workspaceId}::uuid FOR SHARE`);
        const lead = leads[0];
        if (
          leads.length !== 1 ||
          !lead ||
          lead.workspaceId !== ctx.workspaceId ||
          lead.id !== event.leadId ||
          lead.canonicalCompanyId !== reference.canonicalCompanyId ||
          lead.status === "SUPPRESSED" ||
          lead.queue === "suppressed"
        )
          throw leadUnavailable();
        await tx.qualificationFeedbackReceipt.createMany({
          data: [
            {
              workspaceId: ctx.workspaceId,
              eventId: event.eventId,
              opportunityId: event.opportunityId,
              leadId: event.leadId,
              decisionId: event.decisionId,
              revision: BigInt(event.revision),
              decision: event.decision,
              schemaVersion: event.schemaVersion,
              eventType: event.eventType,
              producer: event.producer,
              occurredAt: event.occurredAt,
              eventDigest: digest,
            },
          ],
          skipDuplicates: true,
        });
        const receipt = await tx.qualificationFeedbackReceipt.findUnique({
          where,
        });
        if (!receipt || receipt.eventDigest !== digest) throw conflict();
        return recorded(receipt);
      });
    } catch (error) {
      unavailable(error);
    }
  }
  async receipt(
    ctx: RequestContext,
    eventId: string,
  ): Promise<QualificationFeedbackStatus> {
    requireActor(ctx);
    if (!uuid.test(eventId))
      throw new BadRequestException({
        error: {
          code: "FEEDBACK_INVALID",
          message: "invalid feedback event identifier",
        },
      });
    try {
      return await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
        const row = await tx.qualificationFeedbackReceipt.findUnique({
          where: {
            workspaceId_eventId: { workspaceId: ctx.workspaceId, eventId },
          },
        });
        return row
          ? recorded(row)
          : {
              status: "NOT_RECEIVED" as const,
              eventId,
              workspaceId: ctx.workspaceId,
            };
      });
    } catch (error) {
      unavailable(error);
    }
  }
}
