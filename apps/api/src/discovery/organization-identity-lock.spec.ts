import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assertWorkspaceSuppressionThenIdentityLock,
  lockWorkspaceSuppressionThenIdentity,
} from "./organization-identity-lock";
import * as organizationIdentityLock from "./organization-identity-lock";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

describe("organization identity composite lock", () => {
  it("takes the workspace suppression lock before the workspace identity lock", async () => {
    const calls: unknown[][] = [];
    const executeRaw = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return 1;
    });
    const queryRaw = vi.fn(async () => {
      throw new Error("void advisory locks must not use queryRaw");
    });

    const receipt = await lockWorkspaceSuppressionThenIdentity(
      {
        $executeRaw: executeRaw,
        $queryRaw: queryRaw,
      } as unknown as Prisma.TransactionClient,
      WORKSPACE_ID,
    );

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(calls[0]?.slice(1)).toEqual([
      `acquisition-suppression-policy:${WORKSPACE_ID}`,
    ]);
    expect(calls[1]?.slice(1)).toEqual([
      `organization-identity:${WORKSPACE_ID}`,
    ]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt).toMatchObject({ workspaceId: WORKSPACE_ID });
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(receipt, WORKSPACE_ID),
    ).not.toThrow();
  });

  it("rejects a forged or cross-workspace receipt", async () => {
    const receipt = await lockWorkspaceSuppressionThenIdentity(
      {
        $executeRaw: vi.fn(async () => 1),
      } as unknown as Prisma.TransactionClient,
      WORKSPACE_ID,
    );

    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(receipt, OTHER_WORKSPACE_ID),
    ).toThrow("organization identity lock receipt mismatch");
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        { workspaceId: WORKSPACE_ID } as typeof receipt,
        WORKSPACE_ID,
      ),
    ).toThrow("organization identity lock receipt mismatch");
  });

  it("does not expose an identity-only acquisition or receipt factory", () => {
    expect(Object.keys(organizationIdentityLock).sort()).toEqual([
      "assertWorkspaceSuppressionThenIdentityLock",
      "lockWorkspaceSuppressionThenIdentity",
    ]);
  });
});
