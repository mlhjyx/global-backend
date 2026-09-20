import { MODULE_METADATA } from "@nestjs/common/constants";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { ExecutionBudgetModule } from "./execution-budget.module";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "./execution-budget-authority.repository";
import {
  ExecutionBudgetPlatformWriterDatabase,
  ExecutionBudgetPlatformWriterDatabaseModule,
  platformWriterDatabaseProviderValue,
  type PlatformWriterPrismaClient,
} from "./execution-budget-platform-writer.database";

function client() {
  return {
    $disconnect: vi.fn(async () => undefined),
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
          "  postgresql://platform-writer.invalid/global  ",
        DATABASE_URL: "postgresql://owner.invalid/global",
        APP_DATABASE_URL: "postgresql://app.invalid/global",
      },
      factory,
    );
    const database = new ExecutionBudgetPlatformWriterDatabase(value);

    expect(database.client).toBe(platformWriter);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(
      "postgresql://platform-writer.invalid/global",
    );

    await database.onModuleDestroy();
    expect(platformWriter.$disconnect).toHaveBeenCalledOnce();
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
