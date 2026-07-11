import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { piiExtension } from '../compliance/pii-crypto.extension';

/**
 * Connects as the non-superuser app_user (APP_DATABASE_URL) so RLS is enforced.
 * Domain services run their DB work inside withWorkspace() — never raw find
 * with a manual workspace filter — so tenant isolation is guaranteed by the DB.
 *
 * 收口⑥：构造时 `$extends` PII 透明加解密扩展（canonical_contact.full_name / contact_point.value
 * 密文落库、读时解密，含嵌套 include）。constructor **返回**扩展后的 client——`new PrismaService()`
 * 处处（DI / worker / verify）自动得加密版；withWorkspace 与生命周期由扩展 client 组件重挂
 * （$extends 会剥掉子类自定义方法）。下列方法体仅为调用方类型，运行时被扩展 client 同名实现遮蔽。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ datasourceUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL });
    return this.$extends(piiExtension) as unknown as PrismaService;
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
