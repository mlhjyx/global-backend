import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Run `fn` inside a transaction scoped to a single workspace.
 *
 * Sets `app.current_workspace_id` as a transaction-local setting via
 * set_config(..., is_local => true). Every RLS policy is defined as
 * `USING (workspace_id = current_workspace_id())`, so all reads/writes in the
 * callback are transparently confined to this workspace — the domain code
 * never has to add `where: { workspaceId }` and can't accidentally cross
 * tenants (ADR-001, defense in depth).
 */
export async function withWorkspace<T>(
  prisma: PrismaClient,
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // 注意：这是一个数据库事务 —— 回调里只放 DB 操作。
  // 网络调用（爬虫/模型/Provider）必须在事务外完成，结果再进事务持久化。
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
      return fn(tx);
    },
    { timeout: 60_000, maxWait: 10_000 }, // 大批量 canonicalize/persist 需要余量
  );
}
