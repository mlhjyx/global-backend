import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assertWorkspaceSuppressionPolicyLock,
  lockWorkspaceSuppressionPolicy,
} from "./suppression-policy-lock";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function transaction(rows: unknown = [{ locked: "" }]) {
  return {
    $queryRaw: vi.fn(async () => rows),
    $executeRaw: vi.fn(async () => {
      throw new Error("advisory locks use one typed queryRaw path");
    }),
  } as unknown as Prisma.TransactionClient;
}

async function expectInvalidScalarReceipt(rows: unknown): Promise<void> {
  await expect(
    lockWorkspaceSuppressionPolicy(transaction(rows), WORKSPACE_ID),
  ).rejects.toThrow("database scalar receipt invalid");
}

describe("workspace suppression policy lock", () => {
  it("validates one exact scalar row before branding the receipt to the transaction", async () => {
    const tx = transaction();
    const receipt = await lockWorkspaceSuppressionPolicy(tx, WORKSPACE_ID);
    const queryRaw = tx.$queryRaw as ReturnType<typeof vi.fn>;
    const executeRaw = tx.$executeRaw as ReturnType<typeof vi.fn>;

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual([
      `acquisition-suppression-policy:${WORKSPACE_ID}`,
    ]);
    expect(receipt).toMatchObject({ workspaceId: WORKSPACE_ID });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() =>
      assertWorkspaceSuppressionPolicyLock(receipt, tx, WORKSPACE_ID),
    ).not.toThrow();

    const otherTx = transaction();
    expect(() =>
      assertWorkspaceSuppressionPolicyLock(receipt, otherTx, WORKSPACE_ID),
    ).toThrow("workspace suppression policy lock receipt mismatch");
  });

  it.each([
    ["non-array", { locked: "" }],
    ["zero rows", []],
    ["sparse row", Array(1)],
    ["extra rows", [{ locked: "" }, { locked: "" }]],
    ["custom array key", Object.assign([{ locked: "" }], { extra: true })],
    ["proxy array", new Proxy([{ locked: "" }], {})],
    ["null row", [null]],
    ["array row", [[""]]],
    [
      "null-prototype row",
      [Object.assign(Object.create(null), { locked: "" })],
    ],
    ["proxy row", [new Proxy({ locked: "" }, {})]],
    ["wrong key", [{ lock: "" }]],
    ["extra row key", [{ locked: "", extra: true }]],
    ["wrong scalar value", [{ locked: "true" }]],
    ["wrong scalar type", [{ locked: 0 }]],
  ])(
    "rejects malformed scalar receipt without branding: %s",
    async (_label, rows) => {
      await expectInvalidScalarReceipt(rows);
    },
  );

  it("rejects an accessor array element without invoking it", async () => {
    const getter = vi.fn(() => ({ locked: "" }));
    const rows = Object.defineProperty([], "0", {
      enumerable: true,
      get: getter,
    });

    await expectInvalidScalarReceipt(rows);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects an accessor scalar without invoking it", async () => {
    const getter = vi.fn(() => "");
    const row = Object.defineProperty({}, "locked", {
      enumerable: true,
      get: getter,
    });

    await expectInvalidScalarReceipt([row]);
    expect(getter).not.toHaveBeenCalled();
  });
});
