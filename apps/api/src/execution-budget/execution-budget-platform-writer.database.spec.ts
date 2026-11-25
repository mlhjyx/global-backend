import { MODULE_METADATA } from "@nestjs/common/constants";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { ExecutionBudgetModule } from "./execution-budget.module";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "./execution-budget-authority.repository";
import {
  assertExecutionBudgetPlatformWriterPrincipal,
  ExecutionBudgetPlatformWriterDatabase,
  ExecutionBudgetPlatformWriterDatabaseModule,
  platformWriterDatabaseProviderValue,
  ScopedDatabasePrincipalError,
  type PlatformWriterPrismaClient,
} from "./execution-budget-platform-writer.database";

function client(principalOverrides?: Record<string, unknown>) {
  return {
    $disconnect: vi.fn(async () => undefined),
    $queryRaw: vi.fn(async () => [
      {
        currentUser: "execution_budget_platform_writer_login",
        sessionUser: "execution_budget_platform_writer_login",
        sessionRole: "none",
        rolCanLogin: true,
        rolInherit: true,
        rolSuper: false,
        rolBypassRls: false,
        rolCreateDb: false,
        rolCreateRole: false,
        rolReplication: false,
        memberships: ["execution_budget_platform_writer"],
        ...principalOverrides,
      },
    ]),
  } as unknown as PlatformWriterPrismaClient;
}

describe("ExecutionBudgetPlatformWriterDatabase", () => {
  it("returns no client when the deployment-owned URL is absent", async () => {
    const factory = vi.fn();
    const value = platformWriterDatabaseProviderValue({}, factory);
    const database = new ExecutionBudgetPlatformWriterDatabase(value);

    expect(database.client).toBeNull();
    expect(value).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    await database.onModuleDestroy();
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    { DATABASE_URL: "postgresql://owner.invalid/global" },
    { APP_DATABASE_URL: "postgresql://app.invalid/global" },
    {
      EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL: "   ",
      DATABASE_URL: "postgresql://owner.invalid/global",
      APP_DATABASE_URL: "postgresql://app.invalid/global",
    },
  ])("never falls back to owner or app database URLs", (env) => {
    const factory = vi.fn();

    expect(platformWriterDatabaseProviderValue(env, factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it("creates exactly one dedicated client and disconnects it on shutdown", async () => {
    const platformWriter = client();
    const factory = vi.fn(() => platformWriter);
    const value = platformWriterDatabaseProviderValue(
      {
        EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL:
          "  postgresql://execution_budget_platform_writer_login:secret@platform-writer.invalid/global  ",
        DATABASE_URL: "postgresql://owner.invalid/global",
        APP_DATABASE_URL: "postgresql://app.invalid/global",
      },
      factory,
    );
    const database = new ExecutionBudgetPlatformWriterDatabase(value);

    expect(database.client).toBe(platformWriter);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(
      "postgresql://execution_budget_platform_writer_login:secret@platform-writer.invalid/global",
    );

    await database.onModuleDestroy();
    expect(platformWriter.$disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    "postgresql://global:secret@platform-writer.invalid/global",
    "postgresql://postgres:secret@platform-writer.invalid/global",
    "postgresql://app_user:secret@platform-writer.invalid/global",
    "postgresql://platform-writer.invalid/global",
    "mysql://execution_budget_platform_writer_login:secret@platform-writer.invalid/global",
  ])("rejects forbidden or malformed platform-writer URL %s before creating a client", (badUrl) => {
    const factory = vi.fn();
    expect(() =>
      platformWriterDatabaseProviderValue(
        { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL: badUrl },
        factory,
      ),
    ).toThrow(ScopedDatabasePrincipalError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("memoizes valid principal verification and never caches failed principal checks", async () => {
    const valid = client();
    await assertExecutionBudgetPlatformWriterPrincipal(valid, "unit-test");
    await assertExecutionBudgetPlatformWriterPrincipal(valid, "unit-test");
    expect(valid.$queryRaw).toHaveBeenCalledOnce();

    const superuser = client({
      currentUser: "global",
      sessionUser: "global",
      rolSuper: true,
      memberships: [],
    });
    await expect(
      assertExecutionBudgetPlatformWriterPrincipal(superuser, "unit-test"),
    ).rejects.toBeInstanceOf(ScopedDatabasePrincipalError);
    await expect(
      assertExecutionBudgetPlatformWriterPrincipal(superuser, "unit-test"),
    ).rejects.toBeInstanceOf(ScopedDatabasePrincipalError);
    expect(superuser.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("binds the exact platform-writer token in the deployment module", () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ExecutionBudgetPlatformWriterDatabaseModule,
    ) as readonly unknown[];
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ExecutionBudgetModule,
    ) as readonly unknown[];

    expect(imports).toContain(ExecutionBudgetPlatformWriterDatabaseModule);
    expect(providers).toContain(ExecutionBudgetPlatformWriterDatabase);
    expect(providers).toContainEqual(
      expect.objectContaining({
        provide: EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE,
        useFactory: platformWriterDatabaseProviderValue,
      }),
    );
  });

  it("boots diagnostically with a null writer binding when the URL is absent", async () => {
    vi.stubEnv("EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL", "");
    try {
      const app = await NestFactory.createApplicationContext(
        ExecutionBudgetPlatformWriterDatabaseModule,
        { logger: false },
      );
      expect(
        app.get(EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE, {
          strict: false,
        }),
      ).toBeNull();
      await app.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
