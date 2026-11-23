import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ScopesGuard } from "../../auth/scopes.guard";
import type { RequestContext } from "../../auth/request-context";
import {
  ContactEnrichmentResultsController,
  type ContactEnrichmentResultsPort,
} from "./contact-enrichment-results.controller";
import { describe, expect, it, vi } from "vitest";
import {
  encodeContactEnrichmentResultCursor,
  decodeContactEnrichmentResultCursor,
  parseContactEnrichmentResultsQuery,
} from "./contact-enrichment-results.dto";
const W = "00000000-0000-4000-8000-000000000001",
  C = "00000000-0000-4000-8000-000000000002",
  RUN = "00000000-0000-4000-8000-000000000003";
const cursor = { createdAt: "2026-11-22T00:00:00.000Z", id: C };
const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString(
  "base64url",
);
describe("fixed page-ten scoped keyset input, pure only", () => {
  it("defaults to exactly ten without adding client-selected account or workspace fields", () => {
    expect(parseContactEnrichmentResultsQuery({})).toEqual({
      limit: 10,
      cursor: null,
      businessRunId: null,
    });
  });
  it("retains the real business run filter rather than a workflow-run or budget-account key", () => {
    expect(parseContactEnrichmentResultsQuery({ runId: RUN })).toEqual({
      limit: 10,
      cursor: null,
      businessRunId: RUN,
    });
  });
  it("round-trips only the creation time and original row id", () => {
    expect(encodeContactEnrichmentResultCursor(cursor)).toBe(encoded);
    expect(decodeContactEnrichmentResultCursor(encoded)).toEqual(cursor);
    expect(
      parseContactEnrichmentResultsQuery({ cursor: encoded, runId: RUN }),
    ).toEqual({ limit: 10, cursor, businessRunId: RUN });
  });
  it.each([
    null,
    [],
    { limit: 11 },
    { workspaceId: W },
    { accountKey: "not-a-business-run" },
    { runId: "workflow-run-id" },
    { runId: undefined },
    { cursor: "" },
    { cursor: "bad!" },
  ])("rejects non-contract query input %#", (value) => {
    expect(() => parseContactEnrichmentResultsQuery(value)).toThrow();
  });
  it.each([
    { ...cursor, id: "not-a-uuid" },
    { ...cursor, createdAt: "yesterday" },
    { ...cursor, createdAt: "2026-02-30T00:00:00.000Z" },
    { ...cursor, receipt: "DO_NOT_EXPOSE" },
  ])("rejects noncanonical or payload-bearing keysets %#", (value) => {
    expect(() =>
      decodeContactEnrichmentResultCursor(
        Buffer.from(JSON.stringify(value)).toString("base64url"),
      ),
    ).toThrow();
  });
  it("rejects padded, overlong and non-UTF8 encodings", () => {
    for (const value of [
      encoded + "=",
      "a".repeat(257),
      Buffer.from([0xff]).toString("base64url"),
    ])
      expect(() => decodeContactEnrichmentResultCursor(value)).toThrow();
  });
  it("rejects hidden getters and proxies without observing their payload", () => {
    const read = vi.fn(() => encoded);
    const value = {};
    Object.defineProperty(value, "cursor", { enumerable: true, get: read });
    expect(() => parseContactEnrichmentResultsQuery(value)).toThrow();
    expect(read).not.toHaveBeenCalled();
    const own = vi.fn(() => []);
    expect(() =>
      parseContactEnrichmentResultsQuery(new Proxy({}, { ownKeys: own })),
    ).toThrow();
    expect(own).not.toHaveBeenCalled();
  });
});

function publicResult() {
  return {
    version: 1,
    protocolVersion: 1,
    operationRef: "a".repeat(64),
    companyId: C,
    entrypoint: "http",
    businessRunId: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    status: "PREPARED",
    resultRevision: 1,
    qualityCoverage: "PREREQUISITE_ONLY",
    summary: {
      consideredUniqueContacts: 0,
      eligibleUniqueContacts: 0,
      stockValidPersonalContacts: null,
      physicallyAttemptedUniqueContacts: 0,
      newCandidatePoints: 0,
      newValidPersonalContacts: null,
      unresolvedUniqueContacts: 0,
      skippedByReason: [],
    },
    perContact: [],
    spend: {
      quotedUpperBoundMicrousd: "1780",
      knownChargedMicrousd: "0",
      unknownUpperBoundMicrousd: "0",
      costBasis: "estimated_upper_bound",
    },
    unavailableMetrics: [
      "stockValidPersonalContacts",
      "newValidPersonalContacts",
    ],
  };
}
const ctx: RequestContext = {
  workspaceId: W,
  userId: "synthetic-user",
  roles: ["synthetic-reader"],
  scopes: ["acquisition:read", "contact-discovery:read"],
};
function resultWorld(missing = false) {
  const read = vi.fn(
    async (context: RequestContext, company: string, ref: string) =>
      !missing &&
      context.workspaceId === W &&
      company === C &&
      ref === "a".repeat(64)
        ? publicResult()
        : null,
  );
  const list = vi.fn(async (context: RequestContext, company: string) =>
    !missing && context.workspaceId === W && company === C
      ? { items: [publicResult()], nextCursor: null, hasMore: false }
      : null,
  );
  const recover = vi.fn(async () => publicResult());
  const port: ContactEnrichmentResultsPort = {
    listEnrichmentExecutions: list,
    readEnrichmentExecution: read,
    recoverEnrichmentExecution: recover,
  };
  return {
    read,
    list,
    recover,
    controller: new ContactEnrichmentResultsController(port),
  };
}
describe("scoped persistent result route ports, no real DB or HTTP listener", () => {
  it("GET detail uses only the original scoped read port and never calls recovery", async () => {
    const x = resultWorld();
    expect(await x.controller.read(ctx, C, "a".repeat(64))).toEqual({
      data: publicResult(),
    });
    expect(x.read).toHaveBeenCalledExactlyOnceWith(ctx, C, "a".repeat(64));
    expect(x.recover).not.toHaveBeenCalled();
    expect(x.list).not.toHaveBeenCalled();
  });
  it("GET list passes only the fixed-ten keyset/business-run query and returns the original page envelope", async () => {
    const x = resultWorld();
    expect(
      await x.controller.list(ctx, C, { runId: RUN, cursor: encoded }),
    ).toEqual({
      data: [publicResult()],
      page: { next_cursor: null, has_more: false },
    });
    expect(x.list).toHaveBeenCalledExactlyOnceWith(ctx, C, {
      limit: 10,
      cursor,
      businessRunId: RUN,
    });
    expect(x.recover).not.toHaveBeenCalled();
  });
  it("explicit POST recovery calls only the recovery port without receiving a new Grant or tool interface", async () => {
    const x = resultWorld();
    const writeCtx = {
      ...ctx,
      scopes: [
        "acquisition:write",
        "contact-discovery:read",
        "compliance:manage",
      ] as const,
    };
    expect(await x.controller.recover(writeCtx, C, "a".repeat(64))).toEqual({
      data: publicResult(),
    });
    expect(x.recover).toHaveBeenCalledExactlyOnceWith(
      writeCtx,
      C,
      "a".repeat(64),
    );
    expect(x.read).not.toHaveBeenCalled();
  });
  it("uses uniform not-found responses for absent, cross-company and cross-workspace results", async () => {
    const cases = [
      resultWorld(true).controller.read(ctx, C, "a".repeat(64)),
      resultWorld().controller.read(ctx, W, "a".repeat(64)),
      resultWorld().controller.read(
        { ...ctx, workspaceId: C },
        C,
        "a".repeat(64),
      ),
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
    await expect(
      resultWorld(true).controller.list(ctx, C, {}),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("rejects more than ten rows rather than shrinking the denominator", async () => {
    const x = resultWorld();
    x.list.mockResolvedValue({
      items: Array.from({ length: 11 }, () => publicResult()),
      nextCursor: null,
      hasMore: false,
    });
    await expect(x.controller.list(ctx, C, {})).rejects.toThrow();
    expect(x.recover).not.toHaveBeenCalled();
  });
  it("does not leak unexpected persisted PII fields through a schema-shaped response", async () => {
    const x = resultWorld();
    x.read.mockResolvedValue({
      ...publicResult(),
      email: "PII_SENTINEL",
    } as never);
    await expect(x.controller.read(ctx, C, "a".repeat(64))).rejects.toThrow();
    expect(x.recover).not.toHaveBeenCalled();
  });
  it("actual ScopesGuard allows read-only GET but refuses that same context for recover", () => {
    const guard = new ScopesGuard(new Reflector());
    const contextFor = (handler: (...args: never[]) => unknown, requestContext: RequestContext) =>
      ({
        getHandler: () => handler,
        getClass: () => ContactEnrichmentResultsController,
        switchToHttp: () => ({ getRequest: () => ({ requestContext }) }),
      }) as ExecutionContext;
    expect(
      guard.canActivate(
        contextFor(ContactEnrichmentResultsController.prototype.read, ctx),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        contextFor(ContactEnrichmentResultsController.prototype.recover, ctx),
      ),
    ).toThrow();
    expect(
      guard.canActivate(
        contextFor(ContactEnrichmentResultsController.prototype.recover, {
          ...ctx,
          scopes: [
            "acquisition:write",
            "contact-discovery:read",
            "compliance:manage",
          ],
        }),
      ),
    ).toBe(true);
  });
});
