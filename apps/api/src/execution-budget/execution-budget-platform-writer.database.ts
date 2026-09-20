import {
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "./execution-budget-authority.repository";

export type PlatformWriterPrismaClient = PrismaClient;
export type PlatformWriterPrismaClientFactory = (
  datasourceUrl: string,
) => PlatformWriterPrismaClient;

const DEFAULT_FACTORY: PlatformWriterPrismaClientFactory = (datasourceUrl) =>
  new PrismaClient({ datasourceUrl });

export function createExecutionBudgetPlatformWriterClient(
  env: NodeJS.ProcessEnv,
  factory: PlatformWriterPrismaClientFactory = DEFAULT_FACTORY,
): PlatformWriterPrismaClient | undefined {
  const datasourceUrl =
    env.EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL?.trim();
  return datasourceUrl ? factory(datasourceUrl) : undefined;
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
