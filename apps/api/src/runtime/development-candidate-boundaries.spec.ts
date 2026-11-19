import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as candidate from "./development-candidate";
import { AuthGuard } from "../auth/auth.guard";
import { PostgresBudgetStore } from "../tools/budget-store";
import { PrismaService } from "../prisma/prisma.service";
import { OutboxRelayService } from "../relay/outbox-relay.service";

afterEach(() => vi.restoreAllMocks());

describe("candidate workspace boundaries through normal product paths", () => {
  it("guards the actual extended Prisma client before zero-cost tenant reads or writes", async () => {
    const refusal = new Error("EXECUTION_BUDGET_SCOPE_MISMATCH");
    vi.spyOn(candidate, "assertCandidateTenantAccess").mockImplementation(
      () => {
        throw refusal;
      },
    );
    const service = new PrismaService();
    const transaction = vi.fn();
    const work = vi.fn();
    Object.assign(service, { $transaction: transaction });
    await expect(service.withWorkspace("outside", work)).rejects.toBe(refusal);
    expect(transaction).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it("rejects a foreign owner-relay event before Temporal, parking or publication", async () => {
    const refusal = new Error("EXECUTION_BUDGET_SCOPE_MISMATCH");
    vi.spyOn(candidate, "assertCandidateWorkspaceAllowed").mockImplementation(
      () => {
        throw refusal;
      },
    );
    const update = vi.fn();
    const temporal = { start: vi.fn() };
    const relay = new OutboxRelayService(
      temporal as never,
      { outboxEvent: { update } } as never,
    );
    await expect(
      relay.routeEvent({
        workspaceId: "outside",
        eventType: "DiscoveryRunRequested",
      } as never),
    ).rejects.toBe(refusal);
    expect(update).not.toHaveBeenCalled();
    expect(temporal.start).not.toHaveBeenCalled();
  });
  it("rejects an otherwise signed identity outside the candidate workspace scope", async () => {
    vi.spyOn(candidate, "candidateWorkspaceAllowed").mockReturnValue(false);
    const verify = vi.fn(async () => ({
      userId: "user",
      workspaceId: "outside",
      roles: [],
    }));
    const guard = new AuthGuard({ verify }, { resolve: () => [] });
    const request = {
      headers: { authorization: "Bearer fixture-signed-token" },
    };
    const execution = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(execution)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(verify).toHaveBeenCalledOnce();
    expect(request).not.toHaveProperty("requestContext");
  });

  it("blocks a foreign or expired worker budget request before it reaches the database or physical dispatch", async () => {
    const refusal = Object.assign(
      new Error("EXECUTION_BUDGET_SCOPE_MISMATCH"),
      { code: "EXECUTION_BUDGET_SCOPE_MISMATCH" },
    );
    vi.spyOn(candidate, "assertCandidateWorkspaceAllowed").mockImplementation(
      () => {
        throw refusal;
      },
    );
    const withWorkspace = vi.fn();
    const store = new PostgresBudgetStore({ withWorkspace } as never);
    await expect(
      store.reserve({
        workspaceId: "outside",
        accountKey: "account",
        operationKey: "operation",
        estimatedMicrousd: 1n,
      }),
    ).rejects.toBe(refusal);
    expect(withWorkspace).not.toHaveBeenCalled();
  });
});
