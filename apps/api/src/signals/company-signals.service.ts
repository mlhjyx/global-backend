import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';

/**
 * P1-18 读侧（2026-11-10）：`company_signal` 的公司级只读查询。
 *
 * 写侧见 `company-signals.ts`（changedetection/RSSHub 解析→归因→落库，运营 CLI 驱动）；
 * 本服务只做租户内的 keyset 分页读取，供公司/线索详情「触发信号」块使用。
 *
 * RLS：走 `withWorkspace`（app_user + set_config 事务），查询**同时**显式带
 * workspaceId/companyId 作纵深防御——与会话身份不符的行既被 RLS 挡、也被谓词挡。
 * 只读元数据（标题/URL/摘要），不含页面正文。
 */

export const COMPANY_SIGNALS_DEFAULT_LIMIT = 20;
export const COMPANY_SIGNALS_MAX_LIMIT = 100;

export interface CompanySignalItem {
  id: string;
  providerKey: string;
  signalKind: string;
  sourceUrl: string;
  title: string;
  excerpt: string | null;
  observedAt: string;
}

export interface CompanySignalsPage {
  data: CompanySignalItem[];
  page: { nextCursor: string | null; hasMore: boolean };
}

type Cursor = Readonly<{ observedAt: string; id: string }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.observedAt, id: cursor.id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalid';
    const { t, id } = parsed as { t?: unknown; id?: unknown };
    if (typeof t !== 'string' || !ISO_RE.test(t)) return 'invalid';
    if (typeof id !== 'string' || !UUID_RE.test(id)) return 'invalid';
    return Object.freeze({ observedAt: t, id });
  } catch {
    return 'invalid';
  }
}

export function parseSignalsLimit(raw: unknown): number | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return COMPANY_SIGNALS_DEFAULT_LIMIT;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^\d+$/u.test(text)) return 'invalid';
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > COMPANY_SIGNALS_MAX_LIMIT) return 'invalid';
  return value;
}

@Injectable()
export class CompanySignalsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCompany(
    ctx: RequestContext,
    companyId: string,
    query: { limit?: unknown; cursor?: unknown },
  ): Promise<CompanySignalsPage | 'invalid'> {
    const limit = parseSignalsLimit(query.limit);
    if (limit === 'invalid') return 'invalid';
    const cursor = decodeCursor(typeof query.cursor === 'string' ? query.cursor : undefined);
    if (cursor === 'invalid') return 'invalid';

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const cursorFilter = cursor
        ? Prisma.sql`AND (observed_at, id) < (${cursor.observedAt}::timestamptz, ${cursor.id}::uuid)`
        : Prisma.empty;
      const rows = await tx.$queryRaw<
        {
          id: string;
          provider_key: string;
          signal_kind: string;
          source_url: string;
          title: string;
          excerpt: string | null;
          observed_at: Date;
        }[]
      >(Prisma.sql`
        SELECT id::text AS id, provider_key, signal_kind, source_url, title, excerpt, observed_at
        FROM company_signal
        WHERE workspace_id = ${ctx.workspaceId}::uuid
          AND company_id = ${companyId}::uuid
          ${cursorFilter}
        ORDER BY observed_at DESC, id DESC
        LIMIT ${limit + 1}`);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => ({
        id: row.id,
        providerKey: row.provider_key,
        signalKind: row.signal_kind,
        sourceUrl: row.source_url,
        title: row.title,
        excerpt: row.excerpt,
        observedAt: row.observed_at.toISOString(),
      }));
      const last = items[items.length - 1];
      return {
        data: items,
        page: {
          nextCursor: hasMore && last ? encodeCursor({ observedAt: last.observedAt, id: last.id }) : null,
          hasMore,
        },
      };
    });
  }
}
