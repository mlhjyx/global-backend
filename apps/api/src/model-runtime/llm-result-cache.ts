/**
 * PR-B：结构化任务结果缓存（llm_extraction_cache）的端口、键与 Postgres 实现。
 *
 * 键 =（workspaceId, task, contractVersion, promptVersion, 注册模型, 输入全文 digest,
 * schema digest, reasoning）。任何一元组变化都得到新键——同输入 24h 内复用结果，
 * 命中时跳过网关调用（因此不产生 ai_trace/usage_ledger 记录，也不结算）。
 *
 * 只对任务契约声明 `cacheable: true` 的任务生效；env `ACQ_LLM_CACHE=off` 全局关断。
 * 缓存是纯优化：端口未配置或读写失败时，调用方必须退化为直通（见 bridge）。
 * 表为 FORCE RLS 租户表，读写经 withWorkspace()；非 UUID 作用域（platform）no-op。
 */
import { canonicalDigest } from "./context-engine";

export const DEFAULT_LLM_CACHE_TTL_HOURS = 24;
/** 运维可调短、不容许超 7 天——缓存不是数据存储，过期即失效。 */
const MAX_LLM_CACHE_TTL_HOURS = 24 * 7;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LlmResultCachePort {
  /** 未过期命中返回结构化结果；实现必须过滤过期行。 */
  get(workspaceId: string, cacheKey: string): Promise<{ result: unknown } | null>;
  put(
    workspaceId: string,
    cacheKey: string,
    taskId: string,
    result: unknown,
    ttlHours: number,
  ): Promise<void>;
}

let configuredStore: LlmResultCachePort | null = null;

/** 组合根注入（API / worker 入口）；传 null 关闭。 */
export function configureLlmResultCache(store: LlmResultCachePort | null): void {
  configuredStore = store;
}

/** env `ACQ_LLM_CACHE`：默认 on；只有显式 off 才全直通。 */
export function llmResultCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ACQ_LLM_CACHE ?? "on").trim().toLowerCase() !== "off";
}

/** env `ACQ_LLM_CACHE_TTL_HOURS`：默认 24；非法值回默认，正值钳制到 7 天内。 */
export function llmResultCacheTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.ACQ_LLM_CACHE_TTL_HOURS ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_CACHE_TTL_HOURS;
  return Math.min(Math.floor(parsed), MAX_LLM_CACHE_TTL_HOURS);
}

/** 当前生效的缓存端口（env 关断或无注入时为 null）。 */
export function activeLlmResultCache(
  env: NodeJS.ProcessEnv = process.env,
): LlmResultCachePort | null {
  return llmResultCacheEnabled(env) ? configuredStore : null;
}

export interface LlmResultCacheKeyMaterial {
  workspaceId: string;
  task: string;
  contractVersion: string;
  promptVersion: string;
  /** 任务契约注册的模型串（env 可覆盖 → 换模型即换键）。 */
  model: string;
  /** canonicalDigest(requestMaterial)：prompt/system/model/maxTokens 全量。 */
  requestDigest: string;
  schemaDigest: string;
  reasoning: string;
}

export function llmResultCacheKey(material: LlmResultCacheKeyMaterial): string {
  return canonicalDigest({
    workspaceId: material.workspaceId,
    task: material.task,
    contractVersion: material.contractVersion,
    promptVersion: material.promptVersion,
    model: material.model,
    requestDigest: material.requestDigest,
    schemaDigest: material.schemaDigest,
    reasoning: material.reasoning,
  });
}

export interface LlmResultCacheTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
}

export interface LlmResultCacheDb {
  withWorkspace<T>(workspaceId: string, fn: (tx: LlmResultCacheTx) => Promise<T>): Promise<T>;
}

export interface LlmResultCacheOptions {
  now?: () => Date;
}

export function createPrismaLlmResultCache(
  db: LlmResultCacheDb,
  options: LlmResultCacheOptions = {},
): LlmResultCachePort {
  const now = options.now ?? (() => new Date());
  return {
    async get(workspaceId: string, cacheKey: string): Promise<{ result: unknown } | null> {
      if (!UUID_RE.test(workspaceId)) return null;
      const rows = await db.withWorkspace(workspaceId, async (tx) =>
        tx.$queryRaw<Array<{ result: unknown }>>`
          SELECT result
          FROM llm_extraction_cache
          WHERE workspace_id = ${workspaceId}::uuid
            AND cache_key = ${cacheKey}
            AND expires_at > statement_timestamp()
          LIMIT 1
        `,
      );
      const row = rows[0];
      return row ? { result: row.result } : null;
    },

    async put(
      workspaceId: string,
      cacheKey: string,
      taskId: string,
      result: unknown,
      ttlHours: number,
    ): Promise<void> {
      if (!UUID_RE.test(workspaceId)) return;
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + ttlHours * 60 * 60 * 1000);
      const payload = JSON.stringify(result);
      await db.withWorkspace(workspaceId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO llm_extraction_cache
            (workspace_id, cache_key, task_id, result, created_at, expires_at)
          VALUES
            (${workspaceId}::uuid, ${cacheKey}, ${taskId}, ${payload}::jsonb,
             ${createdAt}, ${expiresAt})
          ON CONFLICT (workspace_id, cache_key) DO UPDATE SET
            result = EXCLUDED.result,
            created_at = EXCLUDED.created_at,
            expires_at = EXCLUDED.expires_at
        `;
        await tx.$executeRaw`
          DELETE FROM llm_extraction_cache
          WHERE workspace_id = ${workspaceId}::uuid
            AND expires_at <= statement_timestamp()
        `;
      });
    },
  };
}
