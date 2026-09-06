import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { RequestContext } from "../auth/request-context";
import { EventsService } from "./events.service";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const EVENT = "aaaaaaaa-0000-4000-8000-000000000001";
const AT = new Date("2026-09-05T11:00:00.000Z");
const ctx: RequestContext = {
  workspaceId: WS,
  userId: "consumer",
  roles: ["service"],
};

function setup(row: Record<string, unknown> | null) {
  const findFirst = vi.fn(async () => row);
  const withWorkspace = vi.fn(
    async (_ws: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback({ outboxDelivery: { findFirst } }),
  );
  return {
    service: new EventsService({ withWorkspace } as unknown as PrismaService),
    findFirst,
    withWorkspace,
  };
}

describe("EventsService ACK truth readback", () => {
  it.each(["PENDING", "DEAD"] as const)(
    "returns %s without inventing an ACK",
    async (status) => {
      const { service } = setup({ eventId: EVENT, status, ackedAt: null });
      expect(await service.ackStatus(ctx, EVENT)).toEqual({
        event_id: EVENT,
        status,
        acked_at: null,
      });
    },
  );

  it("returns committed ACK truth after the original response was lost", async () => {
    const { service, findFirst, withWorkspace } = setup({
      eventId: EVENT,
      status: "ACKED",
      ackedAt: AT,
      payload: { neverExpose: "personal record" },
      lastError: "private diagnostic",
    });
    expect(await service.ackStatus(ctx, EVENT)).toEqual({
      event_id: EVENT,
      status: "ACKED",
      acked_at: AT.toISOString(),
    });
    expect(withWorkspace.mock.calls[0][0]).toBe(WS);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        eventId: EVENT,
        workspaceId: WS,
        sink: "saas",
        event: {
          workspaceId: WS,
          eventType: { in: expect.arrayContaining(["LeadQualified"]) },
        },
      },
      select: { eventId: true, status: true, ackedAt: true },
    });
  });

  it("returns the same 404 for an absent or invisible delivery", async () => {
    const { service } = setup(null);
    for (const context of [ctx, { ...ctx, workspaceId: OTHER_WS }]) {
      await expect(service.ackStatus(context, EVENT)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
  });

  it.each(["bad-id", "' OR 1=1", "aaaaaaaa-0000-0000-0000-000000000001"])(
    "rejects invalid UUID %s before the database",
    async (eventId) => {
      const { service, withWorkspace } = setup(null);
      await expect(service.ackStatus(ctx, eventId)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(withWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: "UNRECOGNIZED", ackedAt: null },
    { status: "ACKED", ackedAt: null },
    { status: "ACKED", ackedAt: new Date("invalid") },
    { status: "PENDING", ackedAt: AT },
  ])(
    "does not expose inconsistent stored truth: $status/$ackedAt",
    async (facts) => {
      const { service } = setup({ eventId: EVENT, ...facts });
      await expect(service.ackStatus(ctx, EVENT)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );
});
