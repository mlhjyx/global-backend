import { PrismaClient } from '@prisma/client';
import { ToolRegistry } from './tool-registry';
import { registerBuiltinTools } from './builtin-tools';
import { ToolBroker, ToolTrace } from './tool-broker';

/** source_policy 表的最小客户端面（PrismaClient 或事务客户端皆可）。 */
type SourcePolicyDb = { sourcePolicy: PrismaClient['sourcePolicy'] };

/** Broker 用的 source_policy 读取器：按域名查（SUSPENDED + 用途）。未登记 → null（无策略）。 */
export type SourcePolicyReader = (domain: string) => Promise<{ suspended: boolean; allowedPurpose?: string[] } | null>;

/**
 * prisma 支持的 source_policy 读取。source_policy 是**平台级、无 RLS** 的治理表
 * （app_user 有 SELECT）——直接读，不进 withWorkspace。reviewStatus=SUSPENDED → 拒；
 * allowedPurpose 交由 Broker 与工具声明的 allowedPurpose 求交集。
 */
export function sourcePolicyReaderFrom(db: SourcePolicyDb): SourcePolicyReader {
  return async (domain: string) => {
    const p = await db.sourcePolicy.findUnique({
      where: { domain },
      select: { reviewStatus: true, allowedPurpose: true },
    });
    if (!p) return null;
    return {
      suspended: p.reviewStatus === 'SUSPENDED',
      allowedPurpose: Array.isArray(p.allowedPurpose) ? (p.allowedPurpose as string[]) : undefined,
    };
  };
}

/**
 * 平台级 ToolBroker（注册全部内置工具 + source_policy 读取）。邮箱验证 SMTP 出网等
 * 原始出网统一经此闸门（allowedTools 白名单 + source_policy + 预算 + 限流 + 幂等 + Trace）。
 * 默认 traceRecorder 对非 OK（DENIED/ERROR）落一条 warn，供出网被拒的审计可见。
 */
export function buildToolBroker(deps?: {
  sourcePolicyReader?: SourcePolicyReader;
  traceRecorder?: (t: ToolTrace) => void;
}): ToolBroker {
  const registry = registerBuiltinTools(new ToolRegistry());
  const traceRecorder =
    deps?.traceRecorder ??
    ((t: ToolTrace) => {
      if (t.status !== 'OK') console.warn(`[tool-broker] ${t.status} ${t.toolId} ${t.reason ?? ''}`.trim());
    });
  return new ToolBroker({ registry, sourcePolicyReader: deps?.sourcePolicyReader, traceRecorder });
}
