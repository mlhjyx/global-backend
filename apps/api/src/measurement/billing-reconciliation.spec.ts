import { describe, expect, it, vi } from "vitest";
import {
  BillingReconciliationInputError,
  BillingReconciliationService,
  SELF_HOSTED_FREE_RESULT_SCHEMAS,
  reconcileSides,
  reconcileThreeLedgers,
} from "./billing-reconciliation";
import type { PrismaService } from "../prisma/prisma.service";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

describe("BillingReconciliationService (three-ledger alignment + self-hosted exclusion)", () => {
  it("computes consistent deltas across ai_trace, usage_ledger, and external vs full settled ledgers", () => {
    expect(reconcileSides({ usageMicrousd: 120_000, settledMicrousd: 150_000 })).toEqual({
      deltaMicrousd: -30_000,
    });
    expect(
      reconcileThreeLedgers({
        aiTraceMicrousd: 120_000,
        usageMicrousd: 120_000,
        settledMicrousd: 150_000,
        externalSettledMicrousd: 120_000,
      }),
    ).toEqual({
      deltaUsageMinusSettledMicrousd: -30_000,
      deltaAiTraceMinusUsageMicrousd: 0,
      deltaUsageMinusExternalSettledMicrousd: 0,
    });
  });

  it("rejects malformed date bounds", async () => {
    const service = new BillingReconciliationService({} as PrismaService);
    await expect(
      service.view({ workspaceId: WORKSPACE_ID, from: "2026/11/01" }),
    ).rejects.toBeInstanceOf(BillingReconciliationInputError);
    await expect(
      service.view({ workspaceId: WORKSPACE_ID, to: "not-a-date" }),
    ).rejects.toBeInstanceOf(BillingReconciliationInputError);
  });

  it("reconciles ai_trace, usage_ledger, external settled vs self-hosted excluded, and account envelope", async () => {
    const queryRaw = vi
      .fn()
      // 1. ai_trace
      .mockResolvedValueOnce([
        { row_count: 12, null_cost_rows: 0, cost_usd: 0.25 },
      ])
      // 2. usage_ledger
      .mockResolvedValueOnce([
        { resource_type: "ai_tokens", row_count: 12, cost_usd: 0.25 },
      ])
      // 3. tool_budget_operation (250k external + 30k historical crawl4ai phantom charges)
      .mockResolvedValueOnce([
        {
          purpose: "discovery.run",
          settled: 280_000n,
          self_hosted_settled: 30_000n,
          in_flight: 10_000n,
        },
      ])
      // 4. tool_budget_account
      .mockResolvedValueOnce([
        {
          open_accounts: 1,
          cap_microusd: 1_000_000n,
          charged_microusd: 280_000n,
          reserved_microusd: 10_000n,
        },
      ]);

    const prisma = {
      withWorkspace: vi.fn(
        async (_ws: string, fn: (tx: unknown) => Promise<unknown>) =>
          fn({ $queryRaw: queryRaw }),
      ),
    } as unknown as PrismaService;

    const service = new BillingReconciliationService(prisma);
    const report = await service.view({
      workspaceId: WORKSPACE_ID,
      from: "2026-11-01",
      to: "2026-11-26",
    });

    expect(SELF_HOSTED_FREE_RESULT_SCHEMAS).toContain("crawl4ai-fetch/v1");
    expect(SELF_HOSTED_FREE_RESULT_SCHEMAS).toContain("crawl4ai-render/v1");
    expect(report).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-26",
      aiTrace: {
        rowCount: 12,
        nullCostRowCount: 0,
        totalMicrousd: 250_000,
      },
      usage: {
        totalMicrousd: 250_000,
      },
      settled: {
        settledMicrousd: 280_000,
        externalSettledMicrousd: 250_000,
        selfHostedExcludedMicrousd: 30_000,
        inFlightMicrousd: 10_000,
      },
      deltaAiTraceMinusUsageMicrousd: 0,
      deltaUsageMinusSettledMicrousd: -30_000,
      deltaUsageMinusExternalSettledMicrousd: 0,
      sources: {
        aiTraceTable: "ai_trace",
        usageTable: "usage_ledger",
        settleTable: "tool_budget_operation",
        balanceTable: "tool_budget_account",
      },
    });
  });
});
