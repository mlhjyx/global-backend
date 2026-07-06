import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Connects as the non-superuser app_user (APP_DATABASE_URL) so RLS is enforced.
 * Domain services run their DB work inside withWorkspace() — never raw find
 * with a manual workspace filter — so tenant isolation is guaranteed by the DB.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ datasourceUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Run `fn` in a transaction scoped to one workspace (sets app.current_workspace_id). */
  async withWorkspace<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
      return fn(tx);
    });
  }
}
