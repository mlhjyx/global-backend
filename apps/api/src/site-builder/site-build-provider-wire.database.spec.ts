import { describe, expect, it, vi } from "vitest";
import {
  createSiteBuildProviderWireDatabaseFromEnv,
  isAuthorizedSiteBuildProviderWirePrincipal,
  siteBuildProviderWireTargetsAppDatabase,
  withSiteBuildProviderWireStatementTimeout,
} from "./site-build-provider-wire.database";

const LOGIN_URL =
  "postgresql://site_build_provider_wire_writer:secret@127.0.0.1:5432/global_dev";
const APP_URL =
  "postgresql://app_user:app-secret@127.0.0.1:5432/global_dev";
const MIGRATION_REVISION = "20260904190000_site_build_provider_wire_authority";
const DATABASE_ENV = {
  SITE_BUILD_PROVIDER_WIRE_DATABASE_URL: LOGIN_URL,
  APP_DATABASE_URL: APP_URL,
};

function principal(overrides: Record<string, unknown> = {}) {
  return {
    sessionUser: "site_build_provider_wire_writer",
    currentUser: "site_build_provider_wire_writer",
    statementTimeout: "4s",
    superuser: false,
    bypassRls: false,
    createDb: false,
    createRole: false,
    replication: false,
    inherit: true,
    memberships: [
      { role: "app_user", adminOption: false, inheritOption: true },
      { role: "runtime_worker", adminOption: false, inheritOption: true },
    ],
    databaseName: "global_dev",
    migrationRevision: MIGRATION_REVISION,
    requiredFunctionsReady: true,
    directWritesDenied: true,
    rlsForced: true,
    ...overrides,
  };
}

describe("SiteBuildProviderWireDatabase", () => {
  it("has no app_user, owner, or group-role fallback", () => {
    expect(createSiteBuildProviderWireDatabaseFromEnv({})).toBeUndefined();
    for (const login of [
      "app_user",
      "global",
      "postgres",
      "runtime_api",
      "runtime_outbox_relay",
      "runtime_worker",
    ]) {
      expect(() =>
        withSiteBuildProviderWireStatementTimeout(
          `postgresql://${login}:secret@127.0.0.1/global_dev`,
        ),
      ).toThrow("SITE_BUILD_PROVIDER_WIRE_DATABASE_URL_INVALID");
    }
    for (const invalid of [
      "not-a-url",
      "mysql://dedicated_writer:secret@127.0.0.1/global_dev",
      "postgresql://dedicated_writer@127.0.0.1/global_dev",
      "postgresql://dedicated_writer:secret@127.0.0.1",
      "postgresql://dedicated_writer:secret@127.0.0.1/global_dev/extra",
      "postgresql://dedicated_writer:secret@127.0.0.1/global_dev?unknown=1",
      "postgresql://dedicated_writer:secret@127.0.0.1/global_dev?sslmode=require&sslmode=verify-full",
      "postgresql://dedicated_writer:secret@127.0.0.1/global_dev#fragment",
    ]) {
      expect(() => withSiteBuildProviderWireStatementTimeout(invalid)).toThrow(
        "SITE_BUILD_PROVIDER_WIRE_DATABASE_URL_INVALID",
      );
    }
  });

  it("binds the writer URL to the exact application database target and release migration", () => {
    expect(siteBuildProviderWireTargetsAppDatabase(LOGIN_URL, APP_URL)).toBe(
      true,
    );
    expect(
      siteBuildProviderWireTargetsAppDatabase(
        LOGIN_URL,
        "postgresql://app_user:secret@127.0.0.1:5432/other_db",
      ),
    ).toBe(false);
    expect(() =>
      createSiteBuildProviderWireDatabaseFromEnv(
        {
          SITE_BUILD_PROVIDER_WIRE_DATABASE_URL: LOGIN_URL,
          APP_DATABASE_URL:
            "postgresql://app_user:secret@127.0.0.1:5432/other_db",
        },
        () => ({}) as never,
        MIGRATION_REVISION,
      ),
    ).toThrow("SITE_BUILD_PROVIDER_WIRE_DATABASE_EXPECTATION_INVALID");
    expect(() =>
      createSiteBuildProviderWireDatabaseFromEnv(
        DATABASE_ENV,
        () => ({}) as never,
      ),
    ).toThrow("SITE_BUILD_PROVIDER_WIRE_DATABASE_EXPECTATION_INVALID");
  });

  it("accepts only one dedicated login with exactly app_user and runtime_worker memberships", () => {
    expect(isAuthorizedSiteBuildProviderWirePrincipal(principal())).toBe(true);
    expect(isAuthorizedSiteBuildProviderWirePrincipal(undefined)).toBe(false);
    for (const invalid of [
      { sessionUser: "app_user", currentUser: "app_user" },
      { sessionUser: "INVALID-NAME", currentUser: "INVALID-NAME" },
      { currentUser: "another_writer" },
      {
        memberships: [
          { role: "app_user", adminOption: false, inheritOption: true },
        ],
      },
      {
        memberships: [
          { role: "runtime_worker", adminOption: false, inheritOption: true },
          { role: "app_user", adminOption: false, inheritOption: true },
        ],
      },
      {
        memberships: [
          { role: "app_user", adminOption: true, inheritOption: true },
          { role: "runtime_worker", adminOption: false, inheritOption: true },
        ],
      },
      {
        memberships: [
          { role: "app_user", adminOption: false, inheritOption: true },
          { role: "runtime_worker", adminOption: false, inheritOption: false },
        ],
      },
      { superuser: true },
      { bypassRls: true },
      { createDb: true },
      { createRole: true },
      { replication: true },
      { inherit: false },
      { statementTimeout: "0" },
    ]) {
      expect(
        isAuthorizedSiteBuildProviderWirePrincipal(principal(invalid)),
      ).toBe(false);
    }
  });

  it("verifies the principal before setting one transaction-local workspace", async () => {
    const executeRawUnsafe = vi.fn(async () => 1);
    const transaction = { $executeRawUnsafe: executeRawUnsafe };
    const client = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(async () => [principal()]),
      $transaction: vi.fn(async (operation) => operation(transaction)),
    };
    const database = createSiteBuildProviderWireDatabaseFromEnv(
      DATABASE_ENV,
      () => client as never,
      MIGRATION_REVISION,
    );

    await expect(database?.checkReadiness()).resolves.toEqual({ status: "ok" });
    await expect(
      database?.withWorkspace(
        "11111111-1111-4111-8111-111111111111",
        async () => "scoped",
      ),
    ).resolves.toBe("scoped");
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      "SELECT set_config('app.current_workspace_id', $1, true)",
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("preserves allowed URL options while enforcing the bounded statement timeout", () => {
    const clientFactory = vi.fn(() => ({}) as never);
    createSiteBuildProviderWireDatabaseFromEnv(
      {
        APP_DATABASE_URL: APP_URL,
        SITE_BUILD_PROVIDER_WIRE_DATABASE_URL:
          `${LOGIN_URL}?sslmode=require&connect_timeout=3&` +
          "options=-c%20lock_timeout%3D1000",
      },
      clientFactory,
      MIGRATION_REVISION,
    );
    const resolved = new URL(clientFactory.mock.calls[0]?.[0] ?? "");
    expect(resolved.searchParams.get("sslmode")).toBe("require");
    expect(resolved.searchParams.get("connect_timeout")).toBe("3");
    expect(resolved.searchParams.get("options")).toBe(
      "-c lock_timeout=1000 -c statement_timeout=4000",
    );
  });

  it("fails readiness closed for unavailable and unauthorized principals", async () => {
    const unavailable = {
      $connect: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      $disconnect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
    };
    const unavailableDatabase = createSiteBuildProviderWireDatabaseFromEnv(
      DATABASE_ENV,
      () => unavailable as never,
      MIGRATION_REVISION,
    );
    await expect(unavailableDatabase?.checkReadiness()).resolves.toEqual({
      status: "failed",
      code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_UNAVAILABLE",
    });

    const unauthorized = {
      ...unavailable,
      $connect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(async () => [principal({ createRole: true })]),
    };
    const unauthorizedDatabase = createSiteBuildProviderWireDatabaseFromEnv(
      DATABASE_ENV,
      () => unauthorized as never,
      MIGRATION_REVISION,
    );
    await expect(unauthorizedDatabase?.checkReadiness()).resolves.toEqual({
      status: "failed",
      code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_PRINCIPAL_INVALID",
    });
  });

  it.each([
    [
      { databaseName: "other_db" },
      "SITE_BUILD_PROVIDER_WIRE_DATABASE_IDENTITY_INVALID",
    ],
    [
      { migrationRevision: "20260901000000_old" },
      "SITE_BUILD_PROVIDER_WIRE_DATABASE_IDENTITY_INVALID",
    ],
    [
      { requiredFunctionsReady: false },
      "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONTRACT_INVALID",
    ],
    [
      { directWritesDenied: false },
      "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONTRACT_INVALID",
    ],
    [
      { rlsForced: false },
      "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONTRACT_INVALID",
    ],
  ])("fails readiness closed for runtime contract drift %#", async (override, code) => {
    const client = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(async () => [principal(override)]),
      $transaction: vi.fn(),
    };
    const database = createSiteBuildProviderWireDatabaseFromEnv(
      DATABASE_ENV,
      () => client as never,
      MIGRATION_REVISION,
    );

    await expect(database?.checkReadiness()).resolves.toEqual({
      status: "failed",
      code,
    });
  });

  it("validates workspace IDs, auto-verifies once, and clears admission on disconnect", async () => {
    const executeRawUnsafe = vi.fn(async () => 1);
    const transaction = { $executeRawUnsafe: executeRawUnsafe };
    const client = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(async () => [principal()]),
      $transaction: vi.fn(async (operation, options) => ({
        value: await operation(transaction),
        options,
      })),
    };
    const database = createSiteBuildProviderWireDatabaseFromEnv(
      DATABASE_ENV,
      () => client as never,
      MIGRATION_REVISION,
    )!;

    await expect(
      database.withWorkspace("not-a-uuid", async () => "never"),
    ).rejects.toThrow("SITE_BUILD_PROVIDER_WIRE_WORKSPACE_INVALID");
    await expect(
      database.withWorkspace(
        "11111111-1111-4111-8111-111111111111",
        async () => "scoped",
        { maxWait: 10, timeout: 20 },
      ),
    ).resolves.toEqual({
      value: "scoped",
      options: { maxWait: 10, timeout: 20 },
    });
    expect(client.$connect).toHaveBeenCalledTimes(1);

    await database.disconnect();
    expect(client.$disconnect).toHaveBeenCalledOnce();
    await database.checkReadiness();
    expect(client.$connect).toHaveBeenCalledTimes(2);
  });
});

const liveDatabaseIt =
  process.env.SITE_BUILD_PROVIDER_WIRE_DATABASE_URL &&
  process.env.APP_DATABASE_URL &&
  process.env.SITE_BUILD_PROVIDER_WIRE_EXPECTED_MIGRATION_REVISION
    ? it
    : it.skip;

describe("SiteBuildProviderWireDatabase live contract", () => {
  liveDatabaseIt("admits the exact database, migration, ACL, RLS, and membership options", async () => {
    const database = createSiteBuildProviderWireDatabaseFromEnv(
      process.env,
      undefined,
      process.env.SITE_BUILD_PROVIDER_WIRE_EXPECTED_MIGRATION_REVISION,
    );
    try {
      await expect(database?.checkReadiness()).resolves.toEqual({ status: "ok" });
    } finally {
      await database?.disconnect();
    }
  });
});
