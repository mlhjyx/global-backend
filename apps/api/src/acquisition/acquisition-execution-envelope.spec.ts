import { describe, expect, it, vi } from "vitest";

import { AcquisitionService } from "./acquisition.service";
import { SourceAdapterRegistry } from "./source-adapter";

function harness(fetchLimit: unknown) {
  const fetch = vi.fn(async () => {
    throw new Error("bounded test stop");
  });
  const sourceFetchUpdate = vi.fn(async () => ({}));
  const service = new AcquisitionService({
    prisma: {
      monitoredSource: {
        findUnique: vi.fn(async () => ({
          id: "source-1",
          providerKey: "bounded",
          sourceKey: "bounded",
          status: "ACTIVE",
          config: fetchLimit === undefined ? {} : { fetchLimit },
        })),
      },
      sourceFetch: {
        create: vi.fn(async () => ({ id: "fetch-1" })),
        update: sourceFetchUpdate,
      },
    } as never,
    registry: new SourceAdapterRegistry().register({
      providerKey: "bounded",
      fetch,
    }),
  });
  return { fetch, service, sourceFetchUpdate };
}

describe("AcquisitionService platform execution envelope", () => {
  it.each([
    ["missing config default", undefined, undefined, 10_000],
    ["oversized source config", 50_000, undefined, 10_000],
    ["oversized activity request", 7, 50_000, 10_000],
    ["positive bounded request", 50_000, 321, 321],
  ] as const)(
    "passes the bounded fetch limit for %s",
    async (_label, configured, requested, expected) => {
      const context = harness(configured);

      await expect(
        context.service.acquire("source-1", {
          ...(requested === undefined ? {} : { limit: requested }),
        }),
      ).resolves.toMatchObject({ status: "FAILED" });
      expect(context.fetch).toHaveBeenCalledWith(
        expect.objectContaining({ sourceKey: "bounded" }),
        expected,
        undefined,
      );
    },
  );

  it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a malformed configured fetch limit without invoking an adapter: %s",
    async (fetchLimit) => {
      const context = harness(fetchLimit);

      await expect(context.service.acquire("source-1")).resolves.toMatchObject({
        status: "FAILED",
      });
      expect(context.fetch).not.toHaveBeenCalled();
      expect(context.sourceFetchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
      );
    },
  );
});
