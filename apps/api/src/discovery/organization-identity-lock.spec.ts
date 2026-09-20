import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assertWorkspaceSuppressionThenIdentityLock,
  lockWorkspaceSuppressionThenIdentity,
} from "./organization-identity-lock";
import * as organizationIdentityLock from "./organization-identity-lock";
import { OrganizationIdentityResolverError } from "./organization-identity-resolver";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const NATIVE_MARKER =
  "canceling statement due to statement timeout: private-query-marker";

type QueryEvent =
  | "lock-timeout-prearm"
  | "statement-timeout-prearm"
  | "suppression-lock"
  | "identity-lock";

function sqlText(args: readonly unknown[]): string {
  return (args[0] as TemplateStringsArray).join("?");
}

function queryEvent(args: readonly unknown[]): QueryEvent {
  const sql = sqlText(args);
  if (sql.includes("set_config('lock_timeout'")) {
    return "lock-timeout-prearm";
  }
  if (sql.includes("set_config('statement_timeout'")) {
    return "statement-timeout-prearm";
  }
  const values = args.slice(1);
  if (
    values.some(
      (value) =>
        typeof value === "string" &&
        value.startsWith("acquisition-suppression-policy:"),
    )
  ) {
    return "suppression-lock";
  }
  return "identity-lock";
}

type FixtureOptions = Readonly<{
  errorAt?: QueryEvent;
  error?: unknown;
  resultAt?: Partial<Record<QueryEvent, unknown>>;
}>;

function transaction(options: FixtureOptions = {}) {
  const events: QueryEvent[] = [];
  const calls: unknown[][] = [];
  const queryRaw = vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    const event = queryEvent(args);
    events.push(event);
    if (options.errorAt === event) throw options.error;
    if (
      options.resultAt &&
      Object.prototype.hasOwnProperty.call(options.resultAt, event)
    ) {
      return options.resultAt[event];
    }
    if (event === "lock-timeout-prearm") {
      return [{ lock_timeout: "5s" }];
    }
    if (event === "statement-timeout-prearm") {
      return [{ statement_timeout: "1min" }];
    }
    return [{ locked: "" }];
  });
  const executeRaw = vi.fn(async () => {
    throw new Error("identity locks use one typed queryRaw path");
  });
  return {
    tx: {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient,
    events,
    calls,
    queryRaw,
    executeRaw,
  };
}

async function captureAcquisitionError(
  fixture: ReturnType<typeof transaction>,
): Promise<unknown> {
  try {
    await lockWorkspaceSuppressionThenIdentity(fixture.tx, WORKSPACE_ID);
  } catch (error) {
    return error;
  }
  throw new Error("expected composite lock acquisition to fail");
}

function expectSanitizedError(
  caught: unknown,
  original: unknown,
  code:
    | "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT"
    | "IDENTITY_RESOLUTION_STATE_INVALID",
): void {
  expect(caught).toBeInstanceOf(OrganizationIdentityResolverError);
  expect(caught).toMatchObject({
    name: "OrganizationIdentityResolverError",
    code,
    message: "organization identity resolution failed",
  });
  expect(caught).not.toBe(original);
  expect(Object.isFrozen(caught)).toBe(true);
  expect(
    Reflect.ownKeys(caught as object)
      .map(String)
      .sort(),
  ).toEqual(["code", "message"]);
  expect(String(caught)).not.toContain(NATIVE_MARKER);
  expect(JSON.stringify(caught)).not.toContain(NATIVE_MARKER);
  expect(caught).not.toHaveProperty("cause");
  expect(caught).not.toHaveProperty("meta");
  expect(caught).not.toHaveProperty("detail");
  expect(caught).not.toHaveProperty("query");
}

describe("organization identity composite lock", () => {
  it("prearms fixed local timeouts before suppression then identity and binds one same-transaction receipt", async () => {
    const fixture = transaction();
    const receipt = await lockWorkspaceSuppressionThenIdentity(
      fixture.tx,
      WORKSPACE_ID,
    );
    const statements = fixture.calls.map(sqlText);

    expect(fixture.queryRaw).toHaveBeenCalledTimes(4);
    expect(fixture.executeRaw).not.toHaveBeenCalled();
    expect(statements[0]).toContain("set_config('lock_timeout', '5s', true)");
    expect(statements[1]).toContain(
      "set_config('statement_timeout', '60s', true)",
    );
    expect(fixture.calls[0]?.slice(1)).toEqual([]);
    expect(fixture.calls[1]?.slice(1)).toEqual([]);
    expect(fixture.calls[2]?.slice(1)).toEqual([
      `acquisition-suppression-policy:${WORKSPACE_ID}`,
    ]);
    expect(fixture.calls[3]?.slice(1)).toEqual([
      `organization-identity:${WORKSPACE_ID}`,
    ]);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(receipt).toMatchObject({ workspaceId: WORKSPACE_ID });
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        receipt,
        fixture.tx,
        WORKSPACE_ID,
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "lock-timeout prearm",
      "lock-timeout-prearm",
      Object.assign(new Error(NATIVE_MARKER), {
        code: "57014",
        detail: "private detail",
        query: "SELECT private",
      }),
      ["lock-timeout-prearm"],
    ],
    [
      "statement-timeout prearm",
      "statement-timeout-prearm",
      {
        cause: {
          originalError: Object.assign(new Error(NATIVE_MARKER), {
            sqlState: "57014",
            hint: "private hint",
          }),
        },
      },
      ["lock-timeout-prearm", "statement-timeout-prearm"],
    ],
    [
      "suppression lock",
      "suppression-lock",
      {
        code: "P2010",
        meta: new Proxy({ code: "57014", message: NATIVE_MARKER }, {}),
      },
      ["lock-timeout-prearm", "statement-timeout-prearm", "suppression-lock"],
    ],
    [
      "identity lock",
      "identity-lock",
      {
        cause: {
          cause: Object.assign(new Error(NATIVE_MARKER), {
            code: "57014",
            context: "private context",
          }),
        },
      },
      [
        "lock-timeout-prearm",
        "statement-timeout-prearm",
        "suppression-lock",
        "identity-lock",
      ],
    ],
  ] as const)(
    "sanitizes %s cancellation before a caller can retain the receipt",
    async (_label, errorAt, error, expectedEvents) => {
      const fixture = transaction({ errorAt, error });
      const caught = await captureAcquisitionError(fixture);

      expectSanitizedError(
        caught,
        error,
        "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
      );
      expect(fixture.events).toEqual(expectedEvents);
    },
  );

  it.each([
    ["lock-timeout-prearm", ["lock-timeout-prearm"]],
    [
      "statement-timeout-prearm",
      ["lock-timeout-prearm", "statement-timeout-prearm"],
    ],
    [
      "suppression-lock",
      ["lock-timeout-prearm", "statement-timeout-prearm", "suppression-lock"],
    ],
    [
      "identity-lock",
      [
        "lock-timeout-prearm",
        "statement-timeout-prearm",
        "suppression-lock",
        "identity-lock",
      ],
    ],
  ] as const)(
    "sanitizes non-cancellation failure at %s",
    async (errorAt, expectedEvents) => {
      const original = Object.assign(new Error(NATIVE_MARKER), {
        code: "XX000",
        detail: "private detail",
      });
      const fixture = transaction({ errorAt, error: original });
      const caught = await captureAcquisitionError(fixture);

      expectSanitizedError(
        caught,
        original,
        "IDENTITY_RESOLUTION_STATE_INVALID",
      );
      expect(fixture.events).toEqual(expectedEvents);
    },
  );

  it.each([
    [
      "sparse lock prearm",
      { "lock-timeout-prearm": Array(1) },
      ["lock-timeout-prearm"],
    ],
    [
      "proxy statement prearm",
      {
        "statement-timeout-prearm": new Proxy(
          [{ statement_timeout: "1min" }],
          {},
        ),
      },
      ["lock-timeout-prearm", "statement-timeout-prearm"],
    ],
    [
      "missing suppression receipt",
      { "suppression-lock": undefined },
      ["lock-timeout-prearm", "statement-timeout-prearm", "suppression-lock"],
    ],
    [
      "extra identity row",
      { "identity-lock": [{ locked: "" }, { locked: "" }] },
      [
        "lock-timeout-prearm",
        "statement-timeout-prearm",
        "suppression-lock",
        "identity-lock",
      ],
    ],
    [
      "wrong identity scalar",
      { "identity-lock": [{ locked: "locked" }] },
      [
        "lock-timeout-prearm",
        "statement-timeout-prearm",
        "suppression-lock",
        "identity-lock",
      ],
    ],
  ] as const)(
    "fails closed on strict scalar evidence: %s",
    async (_label, resultAt, expectedEvents) => {
      const fixture = transaction({ resultAt });
      const caught = await captureAcquisitionError(fixture);

      expectSanitizedError(
        caught,
        undefined,
        "IDENTITY_RESOLUTION_STATE_INVALID",
      );
      expect(fixture.events).toEqual(expectedEvents);
    },
  );

  it("rejects an accessor identity scalar without invoking it", async () => {
    const getter = vi.fn(() => "");
    const row = Object.defineProperty({}, "locked", {
      enumerable: true,
      get: getter,
    });
    const fixture = transaction({ resultAt: { "identity-lock": [row] } });

    const caught = await captureAcquisitionError(fixture);
    expectSanitizedError(
      caught,
      undefined,
      "IDENTITY_RESOLUTION_STATE_INVALID",
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects forged, cross-workspace, and cross-transaction receipts without reacquiring", async () => {
    const fixture = transaction();
    const receipt = await lockWorkspaceSuppressionThenIdentity(
      fixture.tx,
      WORKSPACE_ID,
    );
    const other = transaction();

    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        receipt,
        fixture.tx,
        OTHER_WORKSPACE_ID,
      ),
    ).toThrow("organization identity lock receipt mismatch");
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        receipt,
        other.tx,
        WORKSPACE_ID,
      ),
    ).toThrow("organization identity lock receipt mismatch");
    expect(() =>
      assertWorkspaceSuppressionThenIdentityLock(
        { workspaceId: WORKSPACE_ID } as typeof receipt,
        fixture.tx,
        WORKSPACE_ID,
      ),
    ).toThrow("organization identity lock receipt mismatch");
    expect(other.queryRaw).not.toHaveBeenCalled();
  });

  it("does not expose an identity-only acquisition or receipt factory", () => {
    expect(Object.keys(organizationIdentityLock).sort()).toEqual([
      "assertWorkspaceSuppressionThenIdentityLock",
      "lockWorkspaceSuppressionThenIdentity",
    ]);
  });
});
