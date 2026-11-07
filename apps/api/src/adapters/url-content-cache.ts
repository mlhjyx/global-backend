/**
 * PR-B 页面缓存端口（url_content_cache）的 Postgres 实现。
 *
 * 键 = (workspace_id, sha256(url))；只回放未过期行（24h TTL，主计划 §0.3b PR-B）。
 * 表为 FORCE RLS 租户表，读写一律经 withWorkspace()（app_user + workspace GUC）；
 * 平台作用域（workspaceId 非 UUID，如 'platform'）由本实现直接 no-op——平台渠道
 * 抓取的缓存另立项（设计 §4.6）。
 *
 * 表由迁移手写 SQL 建立（同仓已有「仅手写 SQL」表先例）；此处不依赖 Prisma model。
 */
import { createHash } from "node:crypto";
import type {
  HttpFirstCachePort,
  HttpFirstCacheWrite,
  HttpFirstCachedPage,
} from "./http-first-fetch";

export const URL_CONTENT_CACHE_TTL_HOURS = 24;
const URL_CONTENT_CACHE_TTL_MS = URL_CONTENT_CACHE_TTL_HOURS * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTenantWorkspaceId(workspaceId: string): boolean {
  return UUID_RE.test(workspaceId);
}

/** 稳定 URL 键（含 query；fragment 不参与服务端资源标识，去掉）。 */
export function urlContentCacheKey(url: string): string {
  let normalized = url.trim();
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    normalized = parsed.toString();
  } catch {
    // 非法 URL 原样哈希（抓取层会另行拒绝）。
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

interface UrlContentCacheRow {
  markdown: string;
  content_hash: string;
  etag: string | null;
  last_modified: string | null;
}

export interface UrlContentCacheTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<number>;
}

export interface UrlContentCacheDb {
  withWorkspace<T>(workspaceId: string, fn: (tx: UrlContentCacheTx) => Promise<T>): Promise<T>;
}

export interface UrlContentCacheOptions {
  now?: () => Date;
}

export function createPrismaUrlContentCache(
  db: UrlContentCacheDb,
  options: UrlContentCacheOptions = {},
): HttpFirstCachePort {
  const now = options.now ?? (() => new Date());
  return {
    async get(workspaceId: string, url: string): Promise<HttpFirstCachedPage | null> {
      if (!isTenantWorkspaceId(workspaceId)) return null;
      const urlHash = urlContentCacheKey(url);
      const rows = await db.withWorkspace(workspaceId, async (tx) =>
        tx.$queryRaw<UrlContentCacheRow[]>`
          SELECT markdown, content_hash, etag, last_modified
          FROM url_content_cache
          WHERE workspace_id = ${workspaceId}::uuid
            AND url_hash = ${urlHash}
            AND expires_at > statement_timestamp()
          LIMIT 1
        `,
      );
      const row = rows[0];
      if (!row) return null;
      return {
        markdown: row.markdown,
        contentHash: row.content_hash,
        etag: row.etag,
        lastModified: row.last_modified,
      };
    },

    async put(workspaceId: string, url: string, page: HttpFirstCacheWrite): Promise<void> {
      if (!isTenantWorkspaceId(workspaceId)) return;
      const urlHash = urlContentCacheKey(url);
      const fetchedAt = now();
      const expiresAt = new Date(fetchedAt.getTime() + URL_CONTENT_CACHE_TTL_MS);
      await db.withWorkspace(workspaceId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO url_content_cache
            (workspace_id, url_hash, url, etag, last_modified, content_hash, markdown, fetched_at, expires_at)
          VALUES
            (${workspaceId}::uuid, ${urlHash}, ${url}, ${page.etag}, ${page.lastModified},
             ${page.contentHash}, ${page.markdown}, ${fetchedAt}, ${expiresAt})
          ON CONFLICT (workspace_id, url_hash) DO UPDATE SET
            url = EXCLUDED.url,
            etag = EXCLUDED.etag,
            last_modified = EXCLUDED.last_modified,
            content_hash = EXCLUDED.content_hash,
            markdown = EXCLUDED.markdown,
            fetched_at = EXCLUDED.fetched_at,
            expires_at = EXCLUDED.expires_at
        `;
        // 写入路径顺带清理本 workspace 的过期行（对 (workspace_id, expires_at) 索引，有界）。
        await tx.$executeRaw`
          DELETE FROM url_content_cache
          WHERE workspace_id = ${workspaceId}::uuid
            AND expires_at <= statement_timestamp()
        `;
      });
    },
  };
}
