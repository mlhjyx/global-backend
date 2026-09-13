import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { PlatformTargetLookupRepository } from "./platform-target-lookup.repository";

const request = {
  target_issuer: "https://growthos.example",
  target_jti: "11111111-1111-4111-8111-111111111111",
  schedule_id: "acq-sweep" as const,
  workflow_run_id: "22222222-2222-4222-8222-222222222222",
  nonce: "a".repeat(32),
};
const principal = {
  sessionUser: "platform_writer_login",
  currentUser: "platform_writer_login",
  canLogin: true,
  superuser: false,
  bypassRls: false,
  createDb: false,
  createRole: false,
  replication: false,
  inherit: true,
  memberships: ["execution_budget_platform_writer"],
};
const unavailable = "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE";
function database(rows: unknown = [{ found: true }]) {
  const events: string[] = [];
  const query = vi
    .fn<(statement: Prisma.Sql) => Promise<unknown>>()
    .mockImplementationOnce(async () => {
      events.push("attest");
      return [principal];
    })
    .mockImplementationOnce(async () => {
      events.push("lookup");
      return rows;
    });
  const tx = {
    $queryRaw: query,
    $executeRawUnsafe: vi.fn(async (_statement: string) => {
      events.push("read-only");
      return 0;
    }),
    $executeRaw: vi.fn(async (_statement: Prisma.Sql) => {
      events.push("timeout");
      return 0;
    }),
  };
  const client = {
    $transaction: vi.fn(
      async (
        callback: (transaction: typeof tx) => Promise<unknown>,
        _options: unknown,
      ) => {
        const result = await callback(tx);
        events.push("committed");
        return result;
      },
    ),
  };
  return { tx, query, client, events };
}
describe("platform target lookup repository", () => {
  it.each([true, false])(
    "returns only the committed boolean %s with a parameterized exact tuple",
    async (found) => {
      const db = database([{ found }]);
      expect(
        await new PlatformTargetLookupRepository(
          db.client as never,
          () => 100,
        ).lookup(request, 1600),
      ).toBe(found);
      expect(db.events).toEqual([
        "read-only",
        "timeout",
        "attest",
        "lookup",
        "committed",
      ]);
      expect(db.tx.$executeRawUnsafe.mock.calls[0]).toEqual([
        "SET TRANSACTION READ ONLY",
      ]);
      const statement = db.query.mock.calls[1][0];
      expect(statement.text).toMatch(
        /SELECT public\.lookup_platform_authority_target_v1\(/,
      );
      expect(statement.values).toEqual([
        request.target_issuer,
        request.target_jti,
        request.schedule_id,
        request.workflow_run_id,
      ]);
      expect(statement.text).not.toContain(request.target_issuer);
      const options = db.client.$transaction.mock.calls[0][1] as {
        maxWait: number;
        timeout: number;
      };
      expect(options.maxWait).toBeGreaterThan(0);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.maxWait + options.timeout).toBeLessThanOrEqual(1500);
      expect(db.tx.$executeRaw.mock.calls[0][0].values).toEqual([
        String(options.timeout),
      ]);
    },
  );
  it.each([0, 100, 99, 2101, NaN, Infinity])(
    "rejects expired or invalid caller deadline %s before acquisition",
    async (deadline) => {
      const db = database();
      await expect(
        new PlatformTargetLookupRepository(
          db.client as never,
          () => 100,
        ).lookup(request, deadline),
      ).rejects.toThrow(unavailable);
      expect(db.client.$transaction).not.toHaveBeenCalled();
    },
  );
  it("rejects invalid request and absent dedicated writer without fallback", async () => {
    const db = database();
    await expect(
      new PlatformTargetLookupRepository(db.client as never, () => 100).lookup(
        { ...request, nonce: "invalid" },
        1600,
      ),
    ).rejects.toThrow(unavailable);
    expect(db.client.$transaction).not.toHaveBeenCalled();
    await expect(
      new PlatformTargetLookupRepository(null, () => 100).lookup(request, 1600),
    ).rejects.toThrow(unavailable);
  });
  it("does not query targets when actual principal attestation fails", async () => {
    const db = database();
    db.query.mockReset().mockResolvedValue([{ ...principal, superuser: true }]);
    await expect(
      new PlatformTargetLookupRepository(db.client as never, () => 100).lookup(
        request,
        1600,
      ),
    ).rejects.toThrow(unavailable);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    [],
    [null],
    ["true"],
    [{ found: 1 }],
    [{ found: "true" }],
    [{ found: false, extra: true }],
    [{ found: true }, { found: false }],
  ])("rejects malformed result without coercion %#", async (rows) => {
    const db = database(rows);
    await expect(
      new PlatformTargetLookupRepository(db.client as never, () => 100).lookup(
        request,
        1600,
      ),
    ).rejects.toThrow(unavailable);
  });
  it("does not invoke result accessors", async () => {
    const getter = vi.fn(() => true);
    const row = Object.defineProperty({}, "found", {
      enumerable: true,
      get: getter,
    });
    const db = database([row]);
    await expect(
      new PlatformTargetLookupRepository(db.client as never, () => 100).lookup(
        request,
        1600,
      ),
    ).rejects.toThrow(unavailable);
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["acquisition", "attestation", "lookup", "commit"])(
    "discards deadline exceeded during %s",
    async (phase) => {
      let now = 100;
      const db = database();
      const original = db.client.$transaction.getMockImplementation()!;
      if (phase === "acquisition")
        db.client.$transaction.mockImplementation(async (callback, options) => {
          now = 1600;
          return original(callback, options);
        });
      if (phase === "attestation")
        db.query.mockReset().mockImplementationOnce(async () => {
          now = 1600;
          return [principal];
        });
      if (phase === "lookup")
        db.query
          .mockReset()
          .mockResolvedValueOnce([principal])
          .mockImplementationOnce(async () => {
            now = 1600;
            return [{ found: true }];
          });
      if (phase === "commit")
        db.client.$transaction.mockImplementation(async (callback, options) => {
          const result = await original(callback, options);
          now = 1600;
          return result;
        });
      await expect(
        new PlatformTargetLookupRepository(
          db.client as never,
          () => now,
        ).lookup(request, 1600),
      ).rejects.toThrow(unavailable);
      if (phase === "acquisition") expect(db.query).not.toHaveBeenCalled();
      if (phase === "attestation") expect(db.query).toHaveBeenCalledTimes(1);
    },
  );
  it("does not expose SQL errors or an uncertain outer transaction result", async () => {
    const db = database();
    db.client.$transaction.mockRejectedValue(
      new Error("private SQL/password/JWS diagnostic"),
    );
    const error = await new PlatformTargetLookupRepository(
      db.client as never,
      () => 100,
    )
      .lookup(request, 1600)
      .catch((value) => value);
    expect(error.message).toBe(unavailable);
    expect(error).not.toHaveProperty("cause");
  });
});
