// Test intent source-mined from tugjvnh@70885cdb; rewritten for current main.
import { describe, expect, it, vi } from "vitest";
import { AcquisitionService } from "./acquisition.service";
import { cleanEntity } from "./clean";

function harness(existing: Record<string, unknown>[] = []) {
  const creates: Record<string, unknown>[] = [];
  const updates: Array<{
    where: { id: string };
    data: Record<string, unknown>;
  }> = [];
  const prisma = {
    monitoredSource: {
      findUnique: vi.fn(async () => ({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sourceKey: "fair:test",
        providerKey: "trade_fair",
        status: "ACTIVE",
        config: {},
        cadence: null,
      })),
      update: vi.fn(async () => ({})),
    },
    sourceFetch: {
      create: vi.fn(async () => ({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      })),
      update: vi.fn(async () => ({})),
    },
    sourceEntity: {
      findMany: vi.fn(async () => existing),
      createMany: vi.fn(
        async ({ data }: { data: Record<string, unknown>[] }) => {
          creates.push(...data);
          return { count: data.length };
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          updates.push(args);
          return args;
        },
      ),
    },
    sourceEntityChange: { createMany: vi.fn(async () => ({ count: 2 })) },
  };
  const registry = {
    get: vi.fn(() => ({
      fetch: vi.fn(async () => [
        { externalId: "new", name: "New Co" },
        { externalId: "same", name: "Same Co" },
        { externalId: "changed", name: "Changed Co" },
      ]),
    })),
  };
  return {
    service: new AcquisitionService({
      prisma: prisma as never,
      registry: registry as never,
    }),
    creates,
    updates,
  };
}

describe("AcquisitionService exact SourceFetch provenance", () => {
  it("binds added, changed, and unchanged observations to the exact successful fetch", async () => {
    const sameHash = cleanEntity({
      externalId: "same",
      name: "Same Co",
    })!.contentHash;
    const h = harness([
      {
        id: "same-id",
        externalId: "same",
        name: "Same Co",
        domain: null,
        country: null,
        cleaned: {},
        contentHash: sameHash,
        withdrawnAt: null,
        missCount: 0,
      },
      {
        id: "changed-id",
        externalId: "changed",
        name: "Old Co",
        domain: null,
        country: null,
        cleaned: {},
        contentHash: "different",
        withdrawnAt: null,
        missCount: 0,
      },
    ]);

    await h.service.acquire("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    const fetchId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(h.creates).toEqual([
      expect.objectContaining({ externalId: "new", lastSeenFetchId: fetchId }),
    ]);
    expect(h.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: { id: "same-id" },
          data: expect.objectContaining({ lastSeenFetchId: fetchId }),
        }),
        expect.objectContaining({
          where: { id: "changed-id" },
          data: expect.objectContaining({ lastSeenFetchId: fetchId }),
        }),
      ]),
    );
  });
});
