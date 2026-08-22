import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AcquisitionService } from "./acquisition.service";
import { SourceAdapterRegistry } from "./source-adapter";

describe("AcquisitionService execution-control propagation", () => {
  it.each([
    { code: "EXECUTION_BUDGET_AUTHORITY_REVOKED" },
    {
      name: "ActivityFailure",
      cause: { code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE" },
    },
  ])(
    "rethrows $code before diff persistence or a later source can run",
    async (failure) => {
      const findMany = vi.fn(async () => []);
      const update = vi.fn(async () => ({}));
      const prisma = {
        monitoredSource: {
          findUnique: vi.fn(async () => ({
            id: "source-1",
            providerKey: "controlled",
            sourceKey: "controlled",
            status: "ACTIVE",
            config: {},
          })),
        },
        sourceFetch: {
          create: vi.fn(async () => ({ id: "fetch-1" })),
          update,
        },
        sourceEntity: { findMany },
      } as unknown as PrismaService;
      const registry = new SourceAdapterRegistry().register({
        providerKey: "controlled",
        fetch: vi.fn(async () => Promise.reject(failure)),
      });
      const service = new AcquisitionService({ prisma, registry });

      await expect(service.acquire("source-1")).rejects.toBe(failure);
      expect(findMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );
});
