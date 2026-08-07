import { BadRequestException, Injectable } from "@nestjs/common";
import type { RequestContext } from "../auth/request-context";
import { normalizeLeadQualityLabelRequest } from "./lead-quality-label.domain";
import {
  LeadQualityLabelRepository,
  type AppendLeadQualityLabelResult,
  type LeadQualityLabelRecord,
} from "./lead-quality-label.repository";

export interface LeadQualityLabelView {
  id: string;
  source_event_id: string;
  lead_id: string;
  lead_qualified_event_id: string;
  label: string;
  occurred_at: string;
  source_system: string;
  external_object_ref: string | null;
  reason_code: string | null;
  commercial_result: string | null;
  disposition: string;
  held_reason: string | null;
  ingested_at: string;
}

function toView(row: LeadQualityLabelRecord): LeadQualityLabelView {
  return {
    id: row.id,
    source_event_id: row.sourceEventId,
    lead_id: row.leadId,
    lead_qualified_event_id: row.leadQualifiedEventId,
    label: row.label,
    occurred_at: row.occurredAt.toISOString(),
    source_system: row.sourceSystem,
    external_object_ref: row.externalObjectRef,
    reason_code: row.reasonCode,
    commercial_result: row.commercialResult,
    disposition: row.disposition,
    held_reason: row.heldReason,
    ingested_at: row.ingestedAt.toISOString(),
  };
}

@Injectable()
export class LeadQualityLabelsService {
  constructor(private readonly repository: LeadQualityLabelRepository) {}

  async create(
    ctx: RequestContext,
    input: unknown,
  ): Promise<{ record: LeadQualityLabelView; replayed: boolean }> {
    let normalized;
    try {
      normalized = normalizeLeadQualityLabelRequest(input);
    } catch (error) {
      throw new BadRequestException({
        error: {
          code: "INVALID_LEAD_QUALITY_LABEL",
          message:
            error instanceof Error
              ? error.message
              : "invalid lead quality label",
        },
      });
    }

    const result: AppendLeadQualityLabelResult = await this.repository.append(
      ctx,
      normalized,
    );
    return { record: toView(result.record), replayed: result.replayed };
  }
}
