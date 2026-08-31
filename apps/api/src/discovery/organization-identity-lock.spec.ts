import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assertWorkspaceSuppressionThenIdentityLock,
  lockWorkspaceSuppressionThenIdentity,
} from "./organization-identity-lock";
import * as organizationIdentityLock from "./organization-identity-lock";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function sqlText(args: readonly unknown[]): string {
  return (args[0] as TemplateStringsArray).join("?");
}

function transaction(
  resultFor: (sql: string) => unknown = (sql) => {
    if (sql.includes("set_config('lock_timeout'")) {
      return [{ lock_timeout: "5s" }];
    }
    if (sql.includes("set_config('statement_timeout'")) {
      return [{ statement_timeout: "1min" }];
    }
    return [{ locked: "" }];
  },
) {
  return {
    $queryRaw: vi.fn(async (...args: unknown[]) => resultFor(sqlText(args))),
    $executeRaw: vi.fn(async () => {
      throw new Error("identity locks use one typed queryRaw path");
    }),
  } as unknown as Prisma.TransactionClient;
}

describe("organization identity composite lock", () => {
  it("prearms fixed local timeouts before suppression then identity and binds one same-transaction receipt", async () => {
    const tx = transaction();
    const receipt = await lockWorkspaceSuppressionThenIdentity(
      tx,
      WORKSPACE_ID,
    );
    const queryRaw = tx.$queryRaw as ReturnType<typeof vi.fn>;
    const executeRaw = tx.$executeRaw as ReturnType<typeof vi.fn>;
    const calls = queryRaw.mock.calls as unknown[][];
    const statements = calls.map(sqlText);

    expect(queryRaw).toHaveBeenCalledTimes(4);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(statements[0]).toContain("set_config('lock_timeout', '5s', true)");
    expect(statements[1]).toContain(
      "set_config('statement_timeout', '60s', true)",
    );
    expect(calls[0]?.slice(1)).toEqual([]);
    expect(calls[1]?.slice(1)).toEqual([]);
    expect(calls[2]?.slice(1)).toEqual([
      `acquisition-suppression-policy:${WORKSPACE_ID}`,
    ]);
    expect(calls[3]?.slice(1)).toEqual([
      `organization-identity:${WORKSPACE_ID}`,
    ]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt).toMatchObject({ workspaceId: WORKSPACE_ID });
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(receipt, tx, WORKSPACE_ID),
    ).not.toThrow();
  });

  it("fails on malformed prearm evidence before any source-level lock", async () => {
    const tx = transaction((sql) =>
      sql.includes("set_config('lock_timeout'") ? [] : [{ locked: "" }],
    );

    await expect(
      lockWorkspaceSuppressionThenIdentity(tx, WORKSPACE_ID),
    ).rejects.toThrow("organization identity timeout prearm failed");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects forged, cross-workspace, and cross-transaction receipts without reacquiring", async () => {
    const tx = transaction();
    const receipt = await lockWorkspaceSuppressionThenIdentity(
      tx,
      WORKSPACE_ID,
    );
    const otherTx = transaction();

    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        receipt,
        tx,
        OTHER_WORKSPACE_ID,
      ),
    ).toThrow("organization identity lock receipt mismatch");
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        receipt,
        otherTx,
        WORKSPACE_ID,
      ),
    ).toThrow("organization identity lock receipt mismatch");
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        { workspaceId: WORKSPACE_ID } as typeof receipt,
        tx,
        WORKSPACE_ID,
      ),
    ).toThrow("organization identity lock receipt mismatch");
    expect(otherTx.$queryRaw).not.toHaveBeenCalled();
  });

  it("does not expose an identity-only acquisition or receipt factory", () => {
    expect(Object.keys(organizationIdentityLock).sort()).toEqual([
      "assertWorkspaceSuppressionThenIdentityLock",
      "lockWorkspaceSuppressionThenIdentity",
    ]);
  });
});
