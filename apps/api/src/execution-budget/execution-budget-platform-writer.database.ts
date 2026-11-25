import {
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "./execution-budget-authority.repository";
import {
  assertScopedDatabasePrincipal,
  EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
  inspectScopedDatabaseUrl,
  ScopedDatabasePrincipalError,
} from "../runtime/scoped-database-principal";

export {
  EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE,
  ScopedDatabasePrincipalError,
};

export type PlatformWriterPrismaClient = PrismaClient;
export type PlatformWriterPrismaClientFactory = (
  datasourceUrl: string,
) => PlatformWriterPrismaClient;

const DEFAULT_FACTORY: PlatformWriterPrismaClientFactory = (datasourceUrl) =>
  new PrismaClient({ datasourceUrl });

const verifiedPlatformWriters = new WeakSet<object>();
const verifyingPlatformWriters = new WeakMap<object, Promise<void>>();

export function createExecutionBudgetPlatformWriterClient(
  env: NodeJS.ProcessEnv,
  factory: PlatformWriterPrismaClientFactory = DEFAULT_FACTORY,
): PlatformWriterPrismaClient | undefined {
  const datasourceUrl =
    env.EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL?.trim();
  if (!datasourceUrl) return undefined;
  const check = inspectScopedDatabaseUrl(
    "EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL",
    datasourceUrl,
  );
  if (check.status !== "ok") {
    throw new ScopedDatabasePrincipalError(
      check.code,
      `EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL failed scoped URL validation (${check.code})`,
    );
  }
  return factory(datasourceUrl);
}

export async function assertExecutionBudgetPlatformWriterPrincipal(
  client: PlatformWriterPrismaClient,
  sourceLabel: string,
): Promise<void> {
  if (verifiedPlatformWriters.has(client)) {
    return;
  }
  if (
    !client ||
    typeof (client as { $queryRaw?: unknown }).$queryRaw !== "function"
  ) {
    throw new ScopedDatabasePrincipalError(
      "SCOPED_DATABASE_PRINCIPAL_NOT_FOUND",
      `${sourceLabel}: platformWriter client is missing $queryRaw principal check`,
    );
  }
  let pending = verifyingPlatformWriters.get(client);
  if (!pending) {
    pending = assertScopedDatabasePrincipal(
      client,
      EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
      sourceLabel,
    )
      .then(() => {
        verifiedPlatformWriters.add(client);
      })
      .finally(() => {
        verifyingPlatformWriters.delete(client);
      });
    verifyingPlatformWriters.set(client, pending);
  }
  await pending;
}

@Injectable()
export class ExecutionBudgetPlatformWriterDatabase implements OnModuleDestroy {
  constructor(
    @Inject(EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE)
    readonly client: PlatformWriterPrismaClient | null,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}

export function platformWriterDatabaseProviderValue(
  env: NodeJS.ProcessEnv = process.env,
  factory: PlatformWriterPrismaClientFactory = DEFAULT_FACTORY,
): PlatformWriterPrismaClient | null {
  return createExecutionBudgetPlatformWriterClient(env, factory) ?? null;
}

@Module({
  providers: [
    {
      provide: EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE,
      useFactory: platformWriterDatabaseProviderValue,
    },
    ExecutionBudgetPlatformWriterDatabase,
  ],
  exports: [EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE],
})
export class ExecutionBudgetPlatformWriterDatabaseModule {}
