import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ScopesGuard } from "../../auth/scopes.guard";
import type { RequestContext } from "../../auth/request-context";
import { ContactEnrichmentQualityFactsController } from "./contact-enrichment-quality-facts.controller";
import type { ContactEnrichmentResultsPort } from "./contact-enrichment-results.controller";
import { describe, expect, it, vi } from "vitest";
const W = "00000000-0000-4000-8000-000000000001",
  C = "00000000-0000-4000-8000-000000000002",
  RUN = "00000000-0000-4000-8000-000000000003",
  CONTACT = "00000000-0000-4000-8000-000000000004";
function qualityResult() {
  return {
    version: 2 as const,
    protocolVersion: 1 as const,
    operationRef: "a".repeat(64),
    companyId: C,
    entrypoint: "http" as const,
    businessRunId: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    status: "COMPLETED" as const,
    resultRevision: 2,
    qualityCoverage: "FULL_QUALITY_FACTS" as const,
    basis: {
      consideredScope: "FROZEN_EXECUTION_TARGETS" as const,
      attributionBasis: "CANONICAL_COMPANY_CONTACT_SCOPE" as const,
      validityBasis: "ORIGINAL_VERIFICATION_RULES" as const,
      sendability: "NOT_IMPLIED" as const,
    },
    summary: {
      consideredUniqueContacts: 1,
      coveredUniqueContacts: 1,
      eligibleUniqueContacts: 0,
      stockValidPersonalContacts: 1,
      organizationChannelContacts: 0,
      unknownEmailTypeContacts: 0,
      physicallyAttemptedUniqueContacts: 1,
      newCandidatePoints: 0,
      newValidPersonalContacts: 0,
      unresolvedUniqueContacts: 0,
      skippedByReason: [] as { reasonCode: string; count: number }[],
    },
    perContact: [
      {
        contactId: CONTACT,
        reasonCode: "REUSED",
        committedState: null,
        beforeStates: ["VALID"],
        afterStates: ["VALID"],
        pointRefs: [],
        eventRefs: [],
        attemptRefs: [],
        newCandidate: false,
        newValidPersonal: false,
        stockValidPersonal: true,
        organizationChannel: false,
        unknownEmailType: false,
        eligible: false,
        unresolved: false,
      },
    ],
    spend: {
      quotedUpperBoundMicrousd: "1700",
      knownChargedMicrousd: "0",
      unknownUpperBoundMicrousd: "0",
      costBasis: "estimated_upper_bound" as const,
    },
    unavailableMetrics: [],
  };
}
const ctx: RequestContext = {
  workspaceId: W,
  userId: "synthetic-user",
  roles: ["synthetic-reader"],
  scopes: ["acquisition:read", "contact-discovery:read"],
};
function world(missing = false) {
  const read = vi.fn(
    async (context: RequestContext, company: string, ref: string) =>
      !missing && context.workspaceId === W && company === C && ref === "a".repeat(64)
        ? qualityResult()
        : null,
  );
  const list = vi.fn(async (context: RequestContext, company: string) =>
    !missing && context.workspaceId === W && company === C
      ? { items: [qualityResult()], nextCursor: null, hasMore: false }
      : null,
  );
  const port = {
    listEnrichmentQualityFacts: list,
    readEnrichmentQualityFacts: read,
  } as unknown as ContactEnrichmentResultsPort;
  return {
    read,
    list,
    controller: new ContactEnrichmentQualityFactsController(port),
  };
}
describe("complete quality facts read routes, no real DB or HTTP listener", () => {
  it("GET detail reads only the original scoped quality port", async () => {
    const x = world();
    expect(await x.controller.read(ctx, C, "a".repeat(64))).toEqual({
      data: qualityResult(),
    });
    expect(x.read).toHaveBeenCalledExactlyOnceWith(ctx, C, "a".repeat(64));
    expect(x.list).not.toHaveBeenCalled();
  });
  it("GET list passes the fixed-ten keyset/business-run query and returns the original page envelope", async () => {
    const x = world();
    expect(await x.controller.list(ctx, C, { runId: RUN })).toEqual({
      data: [qualityResult()],
      page: { next_cursor: null, has_more: false },
    });
    expect(x.list).toHaveBeenCalledExactlyOnceWith(ctx, C, {
      limit: 10,
      cursor: null,
      businessRunId: RUN,
    });
  });
  it("uses uniform not-found responses for absent, cross-company and cross-workspace results", async () => {
    const cases = [
      world(true).controller.read(ctx, C, "a".repeat(64)),
      world().controller.read(ctx, W, "a".repeat(64)),
      world().controller.read({ ...ctx, workspaceId: C }, C, "a".repeat(64)),
    ];
    const replies: unknown[] = [];
    for (const promise of cases) {
      try {
        await promise;
        throw new Error("expected not found");
      } catch (error) {
        const e = error as { getStatus(): number; getResponse(): unknown };
        expect(e.getStatus()).toBe(404);
        replies.push(e.getResponse());
      }
    }
    expect(replies[1]).toEqual(replies[0]);
    expect(replies[2]).toEqual(replies[0]);
  });
  it("does not turn a missing company into a successful empty list", async () => {
    await expect(world(true).controller.list(ctx, C, {})).rejects.toMatchObject({
      status: 404,
    });
  });
  it("rejects more than ten rows and a fabricated full-quality zero", async () => {
    const x = world();
    x.list.mockResolvedValue({
      items: Array.from({ length: 11 }, () => qualityResult()),
      nextCursor: null,
      hasMore: false,
    } as never);
    await expect(x.controller.list(ctx, C, {})).rejects.toThrow();
    const y = world();
    const fabricated = qualityResult();
    (fabricated.summary as Record<string, unknown>).stockValidPersonalContacts = 0;
    y.read.mockResolvedValue(fabricated as never);
    await expect(y.controller.read(ctx, C, "a".repeat(64))).rejects.toThrow();
  });
  it("does not leak unexpected persisted PII fields through a schema-shaped response", async () => {
    const x = world();
    x.read.mockResolvedValue({
      ...qualityResult(),
      email: "PII_SENTINEL",
    } as never);
    await expect(x.controller.read(ctx, C, "a".repeat(64))).rejects.toThrow();
  });
  it("requires only the two read scopes on both GET routes", () => {
    const guard = new ScopesGuard(new Reflector());
    const contextFor = (handler: (...args: never[]) => unknown) =>
      ({
        getHandler: () => handler,
        getClass: () => ContactEnrichmentQualityFactsController,
        switchToHttp: () => ({ getRequest: () => ({ requestContext: ctx }) }),
      }) as ExecutionContext;
    for (const handler of [
      ContactEnrichmentQualityFactsController.prototype.list,
      ContactEnrichmentQualityFactsController.prototype.read,
    ])
      expect(guard.canActivate(contextFor(handler))).toBe(true);
    expect(() =>
      guard.canActivate(
        contextFor(ContactEnrichmentQualityFactsController.prototype.list),
      ),
    ).not.toThrow();
  });
});
