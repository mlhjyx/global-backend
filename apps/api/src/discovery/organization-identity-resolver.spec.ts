import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  OrganizationIdentityResolverError,
  resolveOrganizationIdentityForRaw,
} from "./organization-identity-resolver";
import { lockWorkspaceSuppressionThenIdentity } from "./organization-identity-lock";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const RAW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONFLICT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INPUT_HASH = "a".repeat(64);
const CONFLICT_FINGERPRINT = "b".repeat(64);
const NATIVE_TIMEOUT =
  "canceling statement due to statement timeout: owner-password-marker";
const REVIEWED_P0001_TOKENS = [
  "IDENTITY_RESOLUTION_INPUT_INVALID",
  "IDENTITY_RAW_NOT_RESOLVABLE",
  "IDENTITY_RAW_PROCESSING_RESTRICTED",
  "IDENTITY_INPUT_DRIFT",
  "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED",
  "IDENTITY_RESOLUTION_SUPPRESSED",
  "IDENTITY_RESOLUTION_STATE_INVALID",
] as const;

const _RECEIPT_KEYS = [
  "outcome_kind",
  "raw_record_id",
  "company_id",
  "conflict_id",
  "match_rule",
  "input_hash",
  "conflict_fingerprint",
  "replayed",
  "company_created",
  "identifier_count",
  "party_count",
] as const;

type QueryEvent =
  | "lock-timeout-prearm"
  | "statement-timeout-prearm"
  | "suppression-lock"
  | "identity-lock"
  | "resolver";

type DbRow = Record<(typeof _RECEIPT_KEYS)[number], unknown>;

function boundRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    outcome_kind: "bound",
    raw_record_id: RAW_ID,
    company_id: COMPANY_ID,
    conflict_id: null,
    match_rule: "identity_v2",
    input_hash: INPUT_HASH,
    conflict_fingerprint: null,
    replayed: false,
    company_created: false,
    identifier_count: 2,
    party_count: 0,
    ...overrides,
  };
}

function createdRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    ...boundRow(),
    outcome_kind: "created",
    match_rule: "domain_exact",
    replayed: false,
    company_created: true,
    identifier_count: 0,
    ...overrides,
  };
}

function conflictRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    outcome_kind: "conflict",
    raw_record_id: RAW_ID,
    company_id: null,
    conflict_id: CONFLICT_ID,
    match_rule: "identity_conflict",
    input_hash: INPUT_HASH,
    conflict_fingerprint: CONFLICT_FINGERPRINT,
    replayed: true,
    company_created: false,
    identifier_count: 0,
    party_count: 2,
    ...overrides,
  };
}

function legacyBoundRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    outcome_kind: "legacy_bound",
    raw_record_id: RAW_ID,
    company_id: COMPANY_ID,
    conflict_id: null,
    match_rule: "identifier_exact",
    input_hash: "legacy",
    conflict_fingerprint: null,
    replayed: true,
    company_created: false,
    identifier_count: 0,
    party_count: 0,
    ...overrides,
  };
}

function suppressedRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    outcome_kind: "suppressed",
    raw_record_id: RAW_ID,
    company_id: null,
    conflict_id: null,
    match_rule: null,
    input_hash: null,
    conflict_fingerprint: null,
    replayed: false,
    company_created: false,
    identifier_count: 0,
    party_count: 0,
    ...overrides,
  };
}

function without(row: DbRow, key: keyof DbRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([candidate]) => candidate !== key),
  );
}

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
  if (
    values.some(
      (value) =>
        typeof value === "string" && value.startsWith("organization-identity:"),
    )
  ) {
    return "identity-lock";
  }
  if (sql.includes("resolve_organization_identity_for_raw_v1")) {
    return "resolver";
  }
  throw new Error("unexpected organization identity SQL");
}

type FixtureOptions = Readonly<{
  rows?: unknown;
  errorAt?: QueryEvent;
  error?: unknown;
  resultAt?: Partial<Record<QueryEvent, unknown>>;
}>;

function transactionFixture(options: FixtureOptions = {}) {
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
    if (event === "suppression-lock" || event === "identity-lock") {
      return [{ locked: "" }];
    }
    return options.rows ?? [boundRow()];
  });
  const executeRaw = vi.fn(async () => {
    throw new Error("official identity source uses one queryRaw route");
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

async function expectReceiptInvalid(rows: unknown): Promise<void> {
  const fixture = transactionFixture({ rows });
  await expect(
    resolveOrganizationIdentityForRaw(fixture.tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: RAW_ID,
    }),
  ).rejects.toMatchObject({
    code: "IDENTITY_RESOLUTION_RECEIPT_INVALID",
    message: "organization identity resolution failed",
  });
}

async function expectDatabaseCode(
  error: unknown,
  expectedCode: string,
  errorAt: QueryEvent = "resolver",
): Promise<void> {
  const fixture = transactionFixture({ errorAt, error });
  let caught: unknown;
  try {
    await resolveOrganizationIdentityForRaw(fixture.tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: RAW_ID,
    });
  } catch (candidate) {
    caught = candidate;
  }
  expect(caught).toBeInstanceOf(OrganizationIdentityResolverError);
  expect(caught).toMatchObject({
    name: "OrganizationIdentityResolverError",
    code: expectedCode,
    message: "organization identity resolution failed",
  });
  expect(caught).not.toBe(error);
  expect(Object.isFrozen(caught)).toBe(true);
  expect(
    Reflect.ownKeys(caught as object)
      .map(String)
      .sort(),
  ).toEqual(["code", "message"]);
  expect(String(caught)).not.toContain(NATIVE_TIMEOUT);
  expect(JSON.stringify(caught)).not.toContain(NATIVE_TIMEOUT);
  expect(caught).not.toHaveProperty("cause");
  expect(caught).not.toHaveProperty("meta");
  expect(caught).not.toHaveProperty("detail");
  expect(caught).not.toHaveProperty("query");
}

function decoratedDomainError(
  code: string,
  cause: unknown,
): OrganizationIdentityResolverError {
  return Object.create(OrganizationIdentityResolverError.prototype, {
    code: { enumerable: true, value: code },
    message: { enumerable: false, value: NATIVE_TIMEOUT },
    cause: { enumerable: true, value: cause },
    meta: {
      enumerable: true,
      value: { detail: "private meta", query: "SELECT private" },
    },
    detail: { enumerable: true, value: "private detail" },
    query: { enumerable: true, value: "SELECT private" },
  }) as OrganizationIdentityResolverError;
}

describe("organization identity DB resolver source contract", () => {
  it("uses the official separate prearm, suppression, identity, two-ID resolver statement order", async () => {
    const fixture = transactionFixture();

    await expect(
      resolveOrganizationIdentityForRaw(fixture.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      }),
    ).resolves.toMatchObject({ kind: "bound", companyId: COMPANY_ID });

    expect(fixture.events).toEqual([
      "lock-timeout-prearm",
      "statement-timeout-prearm",
      "suppression-lock",
      "identity-lock",
      "resolver",
    ]);
    expect(fixture.executeRaw).not.toHaveBeenCalled();
    const statements = fixture.calls.map(sqlText);
    expect(statements[0]).toContain("set_config('lock_timeout', '5s', true)");
    expect(statements[1]).toContain(
      "set_config('statement_timeout', '60s', true)",
    );
    expect(statements[4]).toContain(
      "public.resolve_organization_identity_for_raw_v1",
    );
    expect(statements[4]).not.toMatch(/\bWITH\b/iu);
    expect(statements[4]).not.toContain(
      "apply_organization_identity_resolution_v1",
    );
    expect(fixture.calls[0]?.slice(1)).toEqual([]);
    expect(fixture.calls[1]?.slice(1)).toEqual([]);
    expect(fixture.calls[2]?.slice(1)).toEqual([
      `acquisition-suppression-policy:${WORKSPACE_ID}`,
    ]);
    expect(fixture.calls[3]?.slice(1)).toEqual([
      `organization-identity:${WORKSPACE_ID}`,
    ]);
    expect(fixture.calls[4]?.slice(1)).toEqual([WORKSPACE_ID, RAW_ID]);
    expect(JSON.stringify(fixture.calls)).not.toContain("authorityIdentifiers");
    expect(JSON.stringify(fixture.calls)).not.toContain("targetCompanyId");
    expect(JSON.stringify(fixture.calls)).not.toContain("blocker");
  });

  it.each([
    [
      "bound",
      boundRow(),
      {
        schemaVersion: "organization-identity-resolution-receipt/v1",
        kind: "bound",
        rawRecordId: RAW_ID,
        companyId: COMPANY_ID,
        matchRule: "identity_v2",
        inputHash: INPUT_HASH,
        replayed: false,
        identifierCount: 2,
      },
    ],
    [
      "created",
      createdRow(),
      {
        schemaVersion: "organization-identity-resolution-receipt/v1",
        kind: "created",
        rawRecordId: RAW_ID,
        companyId: COMPANY_ID,
        matchRule: "domain_exact",
        inputHash: INPUT_HASH,
        replayed: false,
        identifierCount: 0,
      },
    ],
    [
      "conflict",
      conflictRow(),
      {
        schemaVersion: "organization-identity-resolution-receipt/v1",
        kind: "conflict",
        rawRecordId: RAW_ID,
        conflictId: CONFLICT_ID,
        matchRule: "identity_conflict",
        inputHash: INPUT_HASH,
        conflictFingerprint: CONFLICT_FINGERPRINT,
        replayed: true,
        partyCount: 2,
      },
    ],
    [
      "legacy_bound",
      legacyBoundRow(),
      {
        schemaVersion: "organization-identity-resolution-receipt/v1",
        kind: "legacy_bound",
        rawRecordId: RAW_ID,
        companyId: COMPANY_ID,
        matchRule: "identifier_exact",
        inputHash: "legacy",
        replayed: true,
      },
    ],
    [
      "suppressed",
      suppressedRow(),
      {
        schemaVersion: "organization-identity-resolution-receipt/v1",
        kind: "suppressed",
        rawRecordId: RAW_ID,
        replayed: false,
      },
    ],
  ])(
    "parses and freezes the exact %s receipt",
    async (_kind, row, expected) => {
      const fixture = transactionFixture({ rows: [row] });
      const receipt = await resolveOrganizationIdentityForRaw(fixture.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      });

      expect(receipt).toEqual(expected);
      expect(Object.isFrozen(receipt)).toBe(true);
    },
  );

  it("reuses one same-transaction composite receipt without prearming or reacquiring under another key", async () => {
    const fixture = transactionFixture();
    const lockReceipt = await lockWorkspaceSuppressionThenIdentity(
      fixture.tx,
      WORKSPACE_ID,
    );
    const start = fixture.events.length;

    await expect(
      resolveOrganizationIdentityForRaw(
        fixture.tx,
        { workspaceId: WORKSPACE_ID, rawRecordId: RAW_ID },
        lockReceipt,
      ),
    ).resolves.toMatchObject({ kind: "bound" });
    expect(fixture.events.slice(start)).toEqual(["resolver"]);
    expect(fixture.calls.at(-1)?.slice(1)).toEqual([WORKSPACE_ID, RAW_ID]);
  });

  it("rejects cross-transaction and cross-workspace composite receipts without silently reacquiring", async () => {
    const owner = transactionFixture();
    const receipt = await lockWorkspaceSuppressionThenIdentity(
      owner.tx,
      WORKSPACE_ID,
    );
    const other = transactionFixture();

    await expect(
      resolveOrganizationIdentityForRaw(
        other.tx,
        { workspaceId: WORKSPACE_ID, rawRecordId: RAW_ID },
        receipt,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_RESOLUTION_STATE_INVALID" });
    expect(other.events).toEqual([]);

    await expect(
      resolveOrganizationIdentityForRaw(
        owner.tx,
        { workspaceId: OTHER_WORKSPACE_ID, rawRecordId: RAW_ID },
        receipt,
      ),
    ).rejects.toMatchObject({ code: "IDENTITY_RESOLUTION_STATE_INVALID" });
    expect(owner.events).toHaveLength(4);
  });

  it("rejects hostile and non-exact two-ID inputs before prearm or command dispatch", async () => {
    const getter = vi.fn(() => WORKSPACE_ID);
    const accessor = Object.create(Object.prototype, {
      workspaceId: { enumerable: true, get: getter },
      rawRecordId: { enumerable: true, value: RAW_ID },
    });
    const candidates: unknown[] = [
      null,
      [],
      Object.create(null),
      new Proxy({ workspaceId: WORKSPACE_ID, rawRecordId: RAW_ID }, {}),
      { workspaceId: WORKSPACE_ID, rawRecordId: RAW_ID, extra: true },
      { workspaceId: WORKSPACE_ID, rawRecordId: RAW_ID.toUpperCase() },
      accessor,
    ];

    for (const candidate of candidates) {
      const fixture = transactionFixture();
      await expect(
        resolveOrganizationIdentityForRaw(
          fixture.tx,
          candidate as { workspaceId: string; rawRecordId: string },
        ),
      ).rejects.toMatchObject({ code: "IDENTITY_RESOLUTION_INPUT_INVALID" });
      expect(fixture.events).toEqual([]);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("requires exactly one plain exact-key data row without invoking accessors or proxies", async () => {
    await expectReceiptInvalid([]);
    await expectReceiptInvalid([boundRow(), boundRow()]);
    await expectReceiptInvalid(boundRow());
    await expectReceiptInvalid(new Proxy([boundRow()], {}));
    await expectReceiptInvalid([null]);
    await expectReceiptInvalid([[boundRow()]]);
    await expectReceiptInvalid([new Date()]);
    await expectReceiptInvalid([
      Object.assign(Object.create(null), boundRow()),
    ]);
    await expectReceiptInvalid([new Proxy(boundRow(), {})]);
    await expectReceiptInvalid([{ ...boundRow(), extra: true }]);
    await expectReceiptInvalid([
      { ...boundRow(), [Symbol("unexpected")]: true },
    ]);
    await expectReceiptInvalid([without(boundRow(), "party_count")]);

    const getter = vi.fn(() => COMPANY_ID);
    const accessor = Object.defineProperty({ ...boundRow() }, "company_id", {
      enumerable: true,
      get: getter,
    });
    await expectReceiptInvalid([accessor]);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown discriminator", boundRow({ outcome_kind: "BOUND" })],
    ["malformed Raw UUID", boundRow({ raw_record_id: "not-a-uuid" })],
    ["bound missing company", boundRow({ company_id: null })],
    ["bound malformed company UUID", boundRow({ company_id: "not-a-uuid" })],
    ["bound conflict ID", boundRow({ conflict_id: CONFLICT_ID })],
    ["bound match rule", boundRow({ match_rule: "identifier_exact" })],
    ["bound input hash", boundRow({ input_hash: "not-a-hash" })],
    [
      "bound conflict fingerprint",
      boundRow({ conflict_fingerprint: CONFLICT_FINGERPRINT }),
    ],
    ["bound replay type", boundRow({ replayed: 0 })],
    ["bound company-created mismatch", boundRow({ company_created: true })],
    ["bound company-created type", boundRow({ company_created: 0 })],
    ["bound negative identifier count", boundRow({ identifier_count: -1 })],
    ["bound fractional identifier count", boundRow({ identifier_count: 1.5 })],
    ["bound string identifier count", boundRow({ identifier_count: "1" })],
    [
      "bound unsafe identifier count",
      boundRow({ identifier_count: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["bound identifier count maximum", boundRow({ identifier_count: 33 })],
    ["bound party count", boundRow({ party_count: 1 })],
    ["created replay mismatch", createdRow({ replayed: true })],
    [
      "created company-created mismatch",
      createdRow({ company_created: false }),
    ],
    ["created conflict ID", createdRow({ conflict_id: CONFLICT_ID })],
    [
      "created conflict fingerprint",
      createdRow({ conflict_fingerprint: CONFLICT_FINGERPRINT }),
    ],
    ["conflict company ID", conflictRow({ company_id: COMPANY_ID })],
    ["conflict missing ID", conflictRow({ conflict_id: null })],
    [
      "conflict malformed conflict UUID",
      conflictRow({ conflict_id: "not-a-uuid" }),
    ],
    ["conflict match rule", conflictRow({ match_rule: "identity_v2" })],
    ["conflict input hash", conflictRow({ input_hash: null })],
    ["conflict fingerprint", conflictRow({ conflict_fingerprint: null })],
    [
      "conflict malformed fingerprint",
      conflictRow({ conflict_fingerprint: "not-a-hash" }),
    ],
    ["conflict company-created", conflictRow({ company_created: true })],
    [
      "conflict company-created type",
      conflictRow({ company_created: "false" }),
    ],
    ["conflict identifier count", conflictRow({ identifier_count: 1 })],
    ["conflict party minimum", conflictRow({ party_count: 1 })],
    ["conflict negative party count", conflictRow({ party_count: -1 })],
    ["conflict fractional party count", conflictRow({ party_count: 2.5 })],
    ["conflict string party count", conflictRow({ party_count: "2" })],
    ["conflict party maximum", conflictRow({ party_count: 65 })],
    [
      "conflict unsafe party count",
      conflictRow({ party_count: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    ["legacy match rule", legacyBoundRow({ match_rule: "identity_v2" })],
    ["legacy input hash", legacyBoundRow({ input_hash: INPUT_HASH })],
    ["legacy replay mismatch", legacyBoundRow({ replayed: false })],
    [
      "legacy company-created mismatch",
      legacyBoundRow({ company_created: true }),
    ],
    ["legacy identifier count", legacyBoundRow({ identifier_count: 1 })],
    ["legacy party count", legacyBoundRow({ party_count: 1 })],
    ["suppressed company ID", suppressedRow({ company_id: COMPANY_ID })],
    ["suppressed conflict ID", suppressedRow({ conflict_id: CONFLICT_ID })],
    ["suppressed match rule", suppressedRow({ match_rule: "domain_exact" })],
    ["suppressed input hash", suppressedRow({ input_hash: INPUT_HASH })],
    [
      "suppressed conflict fingerprint",
      suppressedRow({ conflict_fingerprint: CONFLICT_FINGERPRINT }),
    ],
    ["suppressed replay mismatch", suppressedRow({ replayed: true })],
    [
      "suppressed company-created mismatch",
      suppressedRow({ company_created: true }),
    ],
    ["suppressed identifier count", suppressedRow({ identifier_count: 1 })],
    ["suppressed party count", suppressedRow({ party_count: 1 })],
  ])("rejects malformed outcome matrix mutation: %s", async (_label, row) => {
    await expectReceiptInvalid([row]);
  });

  it("rejects a valid-shaped row for a different Raw occurrence", async () => {
    await expectReceiptInvalid([
      boundRow({
        raw_record_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ]);
  });

  it("maps direct and arbitrarily nested SQLSTATE 57014 to one statement-timeout error", async () => {
    await expectDatabaseCode(
      Object.assign(new Error(NATIVE_TIMEOUT), {
        code: "57014",
        detail: "private worker context",
        hint: "database URL",
        query: "SELECT secret",
      }),
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
    await expectDatabaseCode(
      Object.assign(new Error("Prisma raw query failed"), {
        code: "P2010",
        meta: {
          cause: {
            originalError: {
              driverError: Object.assign(new Error(NATIVE_TIMEOUT), {
                sqlState: "57014",
                context: "private worker",
              }),
            },
          },
        },
      }),
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
    await expectDatabaseCode(
      Object.assign(new Error("Prisma proxied raw query failed"), {
        code: "P2010",
        meta: new Proxy({ code: "57014", message: NATIVE_TIMEOUT }, {}),
      }),
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
    const deeplyNested = Array.from({ length: 600 }).reduce<unknown>(
      (cause) => ({ cause }),
      Object.assign(new Error(NATIVE_TIMEOUT), { code: "57014" }),
    );
    await expectDatabaseCode(
      deeplyNested,
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
  });

  it("maps a 57014 beyond the 1024-node deep traversal budget to conservative timeout", async () => {
    const beyondBudget = Array.from({ length: 1024 }).reduce<unknown>(
      (cause) => ({ cause }),
      Object.assign(new Error(NATIVE_TIMEOUT), { code: "57014" }),
    );

    await expectDatabaseCode(
      beyondBudget,
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
  });

  it("maps a wide graph whose 57014 is after the queue threshold to conservative timeout", async () => {
    const errors = Array.from({ length: 1100 }, (_unused, index) =>
      index === 1099
        ? Object.assign(new Error(NATIVE_TIMEOUT), { code: "57014" })
        : { message: `ordinary sibling ${index}` },
    );

    await expectDatabaseCode(
      { errors },
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
  });

  it("maps an over-budget graph with no observed 57014 to conservative timeout", async () => {
    const errors = Array.from({ length: 1100 }, (_unused, index) => ({
      message: `ordinary sibling ${index}`,
    }));

    await expectDatabaseCode(
      { errors },
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
  });

  it("bounds cyclic Proxy overflow without invoking accessors or leaking native fields", async () => {
    const getter = vi.fn(() => ({ code: "57014" }));
    const proxyDescriptor = vi.fn(
      (
        target: Record<string, unknown>,
        key: PropertyKey,
      ): PropertyDescriptor | undefined =>
        Reflect.getOwnPropertyDescriptor(target, key),
    );
    const errors = Array.from({ length: 1100 }, (_unused, index) => ({
      message: `ordinary sibling ${index}`,
    }));
    const envelope: Record<string, unknown> = { errors };
    Object.defineProperty(envelope, "hiddenCancellation", {
      enumerable: true,
      get: getter,
    });
    const proxyTarget: Record<string, unknown> = {
      cause: envelope,
      message: NATIVE_TIMEOUT,
    };
    const proxy = new Proxy(proxyTarget, {
      getOwnPropertyDescriptor: proxyDescriptor,
    });
    Object.defineProperty(envelope, "cycle", {
      enumerable: true,
      value: proxy,
    });

    await expectDatabaseCode(proxy, "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT");
    expect(getter).not.toHaveBeenCalled();
    expect(proxyDescriptor.mock.calls.length).toBeLessThanOrEqual(13);
  });

  it("keeps an exactly-1024-node exhaustive graph on its associated non-timeout mapping", async () => {
    const exactlyAtLimit = Array.from({ length: 1023 }).reduce<unknown>(
      (cause) => ({ cause }),
      Object.assign(new Error("ERROR: IDENTITY_INPUT_DRIFT"), {
        code: "P0001",
      }),
    );

    await expectDatabaseCode(exactlyAtLimit, "IDENTITY_INPUT_DRIFT");
  });

  it("inspects decorated domain errors for nested cancellation before trusting their class", async () => {
    const decorated = decoratedDomainError(
      "IDENTITY_RESOLUTION_STATE_INVALID",
      {
        cause: Object.assign(new Error(NATIVE_TIMEOUT), {
          code: "57014",
          detail: "private detail",
          query: "SELECT private",
        }),
      },
    );

    await expectDatabaseCode(
      decorated,
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
  });

  it("replaces a decorated domain error with a fresh frozen fixed error", async () => {
    const decorated = decoratedDomainError("IDENTITY_INPUT_DRIFT", {
      code: "XX000",
      message: "unreviewed native message",
    });

    await expectDatabaseCode(decorated, "IDENTITY_INPUT_DRIFT");
  });

  it.each(REVIEWED_P0001_TOKENS)(
    "does not combine sibling P0001 code and %s message",
    async (token) => {
      await expectDatabaseCode(
        {
          codeEnvelope: { code: "P0001" },
          messageEnvelope: { message: `ERROR: ${token}` },
        },
        "IDENTITY_RESOLUTION_STATE_INVALID",
      );
    },
  );

  it("does not combine AggregateError siblings into a reviewed P0001 pair", async () => {
    const split = new AggregateError([
      Object.assign(new Error("code only"), { code: "P0001" }),
      new Error("ERROR: IDENTITY_INPUT_DRIFT"),
    ]);

    await expectDatabaseCode(split, "IDENTITY_RESOLUTION_STATE_INVALID");
  });

  it("does not combine cyclic sibling envelopes into a reviewed P0001 pair", async () => {
    const codeEnvelope: Record<string, unknown> = { code: "P0001" };
    const messageEnvelope: Record<string, unknown> = {
      message: "ERROR: IDENTITY_INPUT_DRIFT",
    };
    Object.defineProperty(codeEnvelope, "peer", {
      enumerable: true,
      value: messageEnvelope,
    });
    Object.defineProperty(messageEnvelope, "peer", {
      enumerable: true,
      value: codeEnvelope,
    });

    await expectDatabaseCode(codeEnvelope, "IDENTITY_RESOLUTION_STATE_INVALID");
  });

  it("maps pre-context prearm cancellation before any lock and never returns native database text", async () => {
    const fixture = transactionFixture({
      errorAt: "lock-timeout-prearm",
      error: Object.assign(new Error(NATIVE_TIMEOUT), {
        code: "P2010",
        meta: {
          code: "57014",
          message: NATIVE_TIMEOUT,
          detail: "private detail",
          hint: "private hint",
        },
      }),
    });

    let caught: unknown;
    try {
      await resolveOrganizationIdentityForRaw(fixture.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OrganizationIdentityResolverError);
    expect(caught).toMatchObject({
      code: "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
      message: "organization identity resolution failed",
    });
    expect(String(caught)).not.toContain(NATIVE_TIMEOUT);
    expect(JSON.stringify(caught)).not.toContain(NATIVE_TIMEOUT);
    expect(caught).not.toHaveProperty("cause");
    expect(fixture.events).toEqual(["lock-timeout-prearm"]);
  });

  it("fails closed on malformed prearm evidence before resolver dispatch", async () => {
    const fixture = transactionFixture({
      resultAt: { "statement-timeout-prearm": [] },
    });

    await expect(
      resolveOrganizationIdentityForRaw(fixture.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      }),
    ).rejects.toMatchObject({
      code: "IDENTITY_RESOLUTION_STATE_INVALID",
      message: "organization identity resolution failed",
    });
    expect(fixture.events).toEqual([
      "lock-timeout-prearm",
      "statement-timeout-prearm",
    ]);
  });

  it.each([
    [
      Object.assign(new Error("lock unavailable"), { code: "55P03" }),
      "IDENTITY_RESOLUTION_LOCK_TIMEOUT",
    ],
    [
      Object.assign(new Error("serialization"), { code: "40001" }),
      "IDENTITY_RESOLUTION_PLAN_STALE",
    ],
    [
      Object.assign(new Error("raw query failed"), {
        code: "P2010",
        meta: { code: "42501", message: "IDENTITY_RESOLUTION_COMMAND_DENIED" },
      }),
      "IDENTITY_RESOLUTION_COMMAND_DENIED",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_RESOLUTION_INPUT_INVALID"), {
        code: "P0001",
      }),
      "IDENTITY_RESOLUTION_INPUT_INVALID",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_RAW_NOT_RESOLVABLE"), {
        code: "P0001",
      }),
      "IDENTITY_RAW_NOT_RESOLVABLE",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_RAW_PROCESSING_RESTRICTED"), {
        code: "P0001",
      }),
      "IDENTITY_RAW_PROCESSING_RESTRICTED",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_INPUT_DRIFT"), {
        code: "P0001",
      }),
      "IDENTITY_INPUT_DRIFT",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_LEGACY_LINK_ALREADY_RESOLVED"), {
        code: "P0001",
      }),
      "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_RESOLUTION_SUPPRESSED"), {
        code: "P0001",
      }),
      "IDENTITY_RESOLUTION_SUPPRESSED",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_RESOLUTION_STATE_INVALID"), {
        code: "P0001",
      }),
      "IDENTITY_RESOLUTION_STATE_INVALID",
    ],
    [
      Object.assign(new Error("ERROR: IDENTITY_INPUT_DRIFT_SUFFIX"), {
        code: "P0001",
      }),
      "IDENTITY_RESOLUTION_STATE_INVALID",
    ],
    [
      Object.assign(new Error("unreviewed native text"), { code: "XX000" }),
      "IDENTITY_RESOLUTION_STATE_INVALID",
    ],
  ])(
    "retains the reviewed closed database mapping",
    async (error, expected) => {
      await expectDatabaseCode(error, expected);
    },
  );

  it("maps a lock failure before resolver dispatch without claiming hostile-direct SQL bounds", async () => {
    const fixture = transactionFixture({
      errorAt: "identity-lock",
      error: Object.assign(new Error("lock unavailable"), {
        code: "P2010",
        meta: { code: "55P03", message: "IDENTITY_RESOLUTION_LOCK_TIMEOUT" },
      }),
    });

    await expect(
      resolveOrganizationIdentityForRaw(fixture.tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: RAW_ID,
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_RESOLUTION_LOCK_TIMEOUT" });
    expect(fixture.events).toEqual([
      "lock-timeout-prearm",
      "statement-timeout-prearm",
      "suppression-lock",
      "identity-lock",
    ]);
  });

  it("uses a closed generic error type", () => {
    const error = new OrganizationIdentityResolverError(
      "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
    );
    expect(error).toEqual(
      expect.objectContaining({
        name: "OrganizationIdentityResolverError",
        code: "IDENTITY_RESOLUTION_STATEMENT_TIMEOUT",
        message: "organization identity resolution failed",
      }),
    );
    expect(Object.isFrozen(error)).toBe(true);
    expect(Reflect.ownKeys(error).map(String).sort()).toEqual([
      "code",
      "message",
    ]);
  });
});
