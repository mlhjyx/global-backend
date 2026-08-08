import { BadRequestException, NotFoundException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../auth/request-context";
import { COMPANY_IDENTITY_RULE_VERSION } from "./identity-review.domain";
import type { IdentityReviewRepository } from "./identity-review.repository";
import { IdentityReviewService } from "./identity-review.service";

const CTX: RequestContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "reviewer-from-token",
  roles: [],
};
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  vi.useRealTimers();
});

describe("IdentityReviewService", () => {
  it("normalizes the request and derives decision time at the server boundary", async () => {
    const now = new Date("2026-08-08T13:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const appendHuman = vi.fn(async () => ({ id: "decision-1" }));
    const service = new IdentityReviewService({
      appendHuman,
    } as unknown as IdentityReviewRepository);

    await expect(
      service.create(CTX, {
        canonical_company_id: SOURCE_ID,
        linked_canonical_company_id: TARGET_ID,
        decision: "REVIEW_LINK",
        rule_version: COMPANY_IDENTITY_RULE_VERSION,
        evidence_refs: [{ type: "FIELD_EVIDENCE", id: EVIDENCE_ID }],
      }),
    ).resolves.toEqual({ id: "decision-1" });
    expect(appendHuman).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        canonicalCompanyId: SOURCE_ID,
        linkedCanonicalCompanyId: TARGET_ID,
        decision: "REVIEW_LINK",
      }),
      now,
    );
  });

  it("maps invalid human semantics to the common 400 error boundary", async () => {
    const appendHuman = vi.fn();
    const service = new IdentityReviewService({
      appendHuman,
    } as unknown as IdentityReviewRepository);
    await expect(
      service.create(CTX, {
        canonical_company_id: SOURCE_ID,
        decision: "AUTO_LINK",
        rule_version: COMPANY_IDENTITY_RULE_VERSION,
        evidence_refs: [{ type: "FIELD_EVIDENCE", id: EVIDENCE_ID }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(appendHuman).not.toHaveBeenCalled();
  });

  it("preserves repository not-found boundaries after request normalization", async () => {
    const appendHuman = vi.fn().mockRejectedValue(
      new NotFoundException({
        error: { code: "IDENTITY_EVIDENCE_NOT_FOUND", message: "not found" },
      }),
    );
    const service = new IdentityReviewService({
      appendHuman,
    } as unknown as IdentityReviewRepository);

    await expect(
      service.create(CTX, {
        canonical_company_id: SOURCE_ID,
        linked_canonical_company_id: TARGET_ID,
        decision: "REVIEW_LINK",
        rule_version: COMPANY_IDENTITY_RULE_VERSION,
        evidence_refs: [{ type: "FIELD_EVIDENCE", id: EVIDENCE_ID }],
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "IDENTITY_EVIDENCE_NOT_FOUND" } },
    });
  });
});
