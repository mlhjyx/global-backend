import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { lockWorkspaceSuppressionPolicy } from "./suppression-policy-lock";

describe("workspace suppression policy lock", () => {
  it("uses a transaction-scoped PostgreSQL advisory lock keyed by the authenticated workspace", async () => {
    const executeRaw = vi.fn(async () => 1);
    const queryRaw = vi.fn(async () => {
      throw new Error("void advisory locks must not use queryRaw");
    });
    const receipt = await lockWorkspaceSuppressionPolicy(
      {
        $executeRaw: executeRaw,
        $queryRaw: queryRaw,
      } as unknown as Prisma.TransactionClient,
      "ws-1",
    );
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ workspaceId: "ws-1" });
    expect(Object.isFrozen(receipt)).toBe(true);
  });
});
