import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validate } from "class-validator";
import type { RequestContext } from "../auth/request-context";
import {
  CreateLeadQualityLabelDto,
  LeadQualityLabelsController,
} from "./lead-quality-label.controller";
import type { LeadQualityLabelsService } from "./lead-quality-label.service";

const CTX: RequestContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "operator-from-token",
  roles: [],
};

describe("LeadQualityLabelsController", () => {
  it("passes only RequestContext plus the validated DTO to the service and returns the common envelope", async () => {
    const record = { id: "label-1", disposition: "ACCEPTED" };
    const create = vi.fn(async () => ({ record, replayed: false }));
    const controller = new LeadQualityLabelsController({
      create,
    } as unknown as LeadQualityLabelsService);
    const dto = Object.assign(new CreateLeadQualityLabelDto(), {
      source_event_id: "crm:event:1001",
      lead_id: "11111111-1111-4111-8111-111111111111",
      lead_qualified_event_id: "22222222-2222-4222-8222-222222222222",
      label: "QGO_CREATED",
      occurred_at: "2026-08-07T12:00:00.000Z",
      source_system: "growth-saas",
    });

    await expect(controller.create(CTX, dto)).resolves.toEqual({
      data: { ...record, replayed: false },
    });
    expect(create).toHaveBeenCalledWith(CTX, dto);
    expect(dto.workspace_id).toBeUndefined();
    expect(dto.actor_id).toBeUndefined();
  });

  it("rejects forged workspace_id/actor_id instead of silently stripping server-owned provenance", async () => {
    const dto = Object.assign(new CreateLeadQualityLabelDto(), {
      source_event_id: "crm:event:1001",
      lead_id: "11111111-1111-4111-8111-111111111111",
      lead_qualified_event_id: "22222222-2222-4222-8222-222222222222",
      label: "QGO_CREATED",
      occurred_at: "2026-08-07T12:00:00.000Z",
      source_system: "growth-saas",
      workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor_id: "forged-user",
    });

    const errors = await validate(dto, { whitelist: true });
    expect(errors.map((error) => error.property).sort()).toEqual([
      "actor_id",
      "workspace_id",
    ]);
  });
});

describe("lead-quality-label OpenAPI contract", () => {
  const openapi = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "../../packages/contracts/openapi/openapi.json"),
      "utf8",
    ),
  ) as {
    paths: Record<
      string,
      { post?: { responses: Record<string, unknown>; requestBody?: unknown } }
    >;
    components: {
      schemas: Record<
        string,
        {
          required?: string[];
          properties?: Record<string, { enum?: string[] }>;
        }
      >;
    };
  };

  it("publishes POST /api/v1/lead-quality-labels with a required body and conflict response", () => {
    const operation = openapi.paths["/api/v1/lead-quality-labels"]?.post;
    expect(operation?.requestBody).toMatchObject({ required: true });
    expect(operation?.responses).toHaveProperty("201");
    expect(operation?.responses).toHaveProperty("409");
  });

  it("keeps label/reason/result values closed in the generated DTO schema", () => {
    const schema = openapi.components.schemas.CreateLeadQualityLabelDto;
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "source_event_id",
        "lead_id",
        "lead_qualified_event_id",
        "label",
        "occurred_at",
        "source_system",
      ]),
    );
    expect(schema.properties?.label.enum).toEqual([
      "QGO_CREATED",
      "SALES_ACCEPTED",
      "COMMERCIAL_OUTCOME_VERIFIED",
      "LEAD_OUTCOME_REJECTED",
    ]);
    expect(schema.properties?.reason_code?.enum).toEqual([
      "NOT_ICP",
      "BAD_TIMING",
      "UNREACHABLE",
      "DUPLICATE",
      "INSUFFICIENT_EVIDENCE",
      "COMPLIANCE_BLOCKED",
      "OTHER",
    ]);
    expect(schema.properties?.commercial_result?.enum).toEqual(["WON", "LOST"]);
    expect(schema.properties).not.toHaveProperty("workspace_id");
    expect(schema.properties).not.toHaveProperty("actor_id");
  });
});
