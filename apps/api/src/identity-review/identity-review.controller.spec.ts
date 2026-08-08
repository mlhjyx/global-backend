import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";
import { AuthGuard } from "../auth/auth.guard";
import { REQUIRED_AUTH_SCOPES } from "../auth/auth-scopes";
import type { RequestContext } from "../auth/request-context";
import {
  AppendHumanIdentityDecisionDto,
  IdentityDecisionListQueryDto,
  IdentityReviewController,
} from "./identity-review.controller";
import { COMPANY_IDENTITY_RULE_VERSION } from "./identity-review.domain";
import type { IdentityReviewService } from "./identity-review.service";

const CTX: RequestContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "reviewer-from-token",
  roles: [],
};
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

function validBody() {
  return {
    canonical_company_id: SOURCE_ID,
    linked_canonical_company_id: TARGET_ID,
    decision: "REVIEW_LINK",
    rule_version: COMPANY_IDENTITY_RULE_VERSION,
    evidence_refs: [{ type: "FIELD_EVIDENCE", id: EVIDENCE_ID }],
  };
}

describe("IdentityReviewController", () => {
  it("binds both operations to signed context and the exact identity-review scope", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, IdentityReviewController)).toContain(
      AuthGuard,
    );
    expect(
      Reflect.getMetadata(
        REQUIRED_AUTH_SCOPES,
        IdentityReviewController.prototype.create,
      ),
    ).toEqual(["acquisition:identity:review"]);
    expect(
      Reflect.getMetadata(
        REQUIRED_AUTH_SCOPES,
        IdentityReviewController.prototype.list,
      ),
    ).toEqual(["acquisition:identity:review"]);
  });

  it("passes token context to the service and returns common envelopes", async () => {
    const record = { id: "decision-1" };
    const create = vi.fn(async () => record);
    const list = vi.fn(async () => ({
      records: [record],
      nextCursor: null,
      hasMore: false,
    }));
    const controller = new IdentityReviewController({
      create,
      list,
    } as unknown as IdentityReviewService);
    const dto = plainToInstance(AppendHumanIdentityDecisionDto, validBody());
    const query = plainToInstance(IdentityDecisionListQueryDto, {});

    await expect(controller.create(CTX, dto)).resolves.toEqual({ data: record });
    await expect(controller.list(CTX, SOURCE_ID, query)).resolves.toEqual({
      data: [record],
      page: { next_cursor: null, has_more: false },
    });
    expect(create).toHaveBeenCalledWith(CTX, dto);
    expect(list).toHaveBeenCalledWith(CTX, SOURCE_ID, {
      cursor: null,
      limit: 50,
    });
  });

  it("rejects forged workspace, actor, actor type, and timestamps", async () => {
    const dto = plainToInstance(AppendHumanIdentityDecisionDto, {
      ...validBody(),
      workspace_id: CTX.workspaceId,
      actor_id: "forged",
      actor_type: "SYSTEM",
      decided_at: "2026-08-08T12:00:00.000Z",
      created_at: "2026-08-08T12:00:00.000Z",
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.map((error) => error.property).sort()).toEqual([
      "actor_id",
      "actor_type",
      "created_at",
      "decided_at",
      "workspace_id",
    ]);
  });

  it("rejects AUTO_LINK and malformed nested evidence before the service", async () => {
    const dto = plainToInstance(AppendHumanIdentityDecisionDto, {
      ...validBody(),
      decision: "AUTO_LINK",
      evidence_refs: [{ type: "FIELD_EVIDENCE", id: "not-a-uuid" }],
    });
    const errors = await validate(dto, { whitelist: true });
    expect(errors.map((error) => error.property).sort()).toEqual([
      "decision",
      "evidence_refs",
    ]);
  });

  it("bounds history queries and defaults to 50 rows", async () => {
    const defaults = plainToInstance(IdentityDecisionListQueryDto, {});
    expect(await validate(defaults)).toEqual([]);
    expect(defaults.limit).toBe(50);

    const oversized = plainToInstance(IdentityDecisionListQueryDto, {
      limit: 101,
    });
    expect((await validate(oversized)).map((error) => error.property)).toEqual([
      "limit",
    ]);
  });
});
