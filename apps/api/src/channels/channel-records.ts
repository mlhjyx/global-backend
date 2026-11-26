/**
 * 渠道抓取记录物化（2026-11-05 设计；MT-P2 加固联系人列级加密）：
 *
 * - 平台级 source_channel_record：(channelId, dedupeKey) 跨轮 upsert，last_seen 前移、content_hash 基于明文快照；
 * - 联系人字段（contactName/contactTitle/email/phone）经 platform:source_channel_record 作用域
 *   `enc:v2:<keyId>:` 随机 IV 密文存储（写路径 fail-closed；读路径默认拒绝明文回退，仅显式迁移窗口兼容明文）；
 * - 幂等：同一批记录重复写入无害（唯一键 + upsert），活动重试不产生重复行；
 * - 同轮内同名折叠（首条为准），返回写入条数（recordsMaterialized 的口径）。
 */
import { createHash } from 'node:crypto';
import {
  decryptPlatformPii,
  encryptPlatformPii,
  PII_PURPOSE,
} from '../compliance/pii-crypto';
import { companyIdentity } from '../discovery/identity';
import type { CrawledRecord } from './channel-crawler';

export interface ChannelRecordRow {
  channelId: string;
  crawlRunId: string;
  dedupeKey: string;
  name: string;
  website: string | null;
  country: string | null;
  industry: string | null;
  products: string[] | null;
  keywords: string[] | null;
  contactName: string | null;
  contactTitle: string | null;
  email: string | null;
  phone: string | null;
  sourceUrl: string;
  contentHash: string;
}

export interface ChannelRecordWriter {
  upsertByChannelAndDedupe(row: ChannelRecordRow, seenAt: Date): Promise<void>;
}

const CHANNEL_RECORD_PII_FIELDS = [
  ['contactName', PII_PURPOSE.SOURCE_CHANNEL_CONTACT_NAME],
  ['contactTitle', PII_PURPOSE.SOURCE_CHANNEL_CONTACT_TITLE],
  ['email', PII_PURPOSE.SOURCE_CHANNEL_EMAIL],
  ['phone', PII_PURPOSE.SOURCE_CHANNEL_PHONE],
] as const;

export function encryptChannelRecordPii(row: ChannelRecordRow): ChannelRecordRow {
  const encrypted: ChannelRecordRow = { ...row };
  for (const [field, purpose] of CHANNEL_RECORD_PII_FIELDS) {
    const value = encrypted[field];
    if (typeof value === 'string') {
      encrypted[field] = encryptPlatformPii(value, {
        scope: 'source_channel_record',
        purpose,
        deterministic: false,
      });
    }
  }
  return encrypted;
}

export function decryptChannelRecordPii<
  T extends {
    contactName: string | null;
    contactTitle: string | null;
    email: string | null;
    phone: string | null;
  },
>(row: T): T {
  const decrypted: T = { ...row };
  for (const [field, purpose] of CHANNEL_RECORD_PII_FIELDS) {
    const value = decrypted[field];
    if (typeof value === 'string') {
      decrypted[field] = decryptPlatformPii(value, {
        scope: 'source_channel_record',
        purpose,
      }) as T[typeof field];
    }
  }
  return decrypted;
}

export interface ChannelRecordListRow {
  id: string;
  crawlRunId: string;
  name: string;
  website: string | null;
  country: string | null;
  industry: string | null;
  products: unknown;
  keywords: unknown;
  contactName: string | null;
  contactTitle: string | null;
  email: string | null;
  phone: string | null;
  sourceUrl: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  contentHash: string | null;
  reviewStatus: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  materializedCompanyId: string | null;
}

export function formatChannelRecordListItem<T extends ChannelRecordListRow>(row: T) {
  const pii = decryptChannelRecordPii(row);
  return {
    id: row.id,
    crawlRunId: row.crawlRunId,
    name: row.name,
    website: row.website,
    country: row.country,
    industry: row.industry,
    products: row.products as T['products'],
    keywords: row.keywords as T['keywords'],
    contactName: pii.contactName,
    contactTitle: pii.contactTitle,
    email: pii.email,
    phone: pii.phone,
    sourceUrl: row.sourceUrl,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    contentHash: row.contentHash,
    reviewStatus: row.reviewStatus,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    materializedCompanyId: row.materializedCompanyId,
  };
}

export function recordContentHash(row: ChannelRecordRow): string {
  const fields = [
    row.name,
    row.website,
    row.country,
    row.industry,
    row.products,
    row.keywords,
    row.contactName,
    row.contactTitle,
    row.email,
    row.phone,
    row.sourceUrl,
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** 把爬虫记录转成 (channelId, dedupeKey) 唯一键的行集合；同轮同名折叠。 */
export function buildChannelRecordRows(input: {
  channelId: string;
  crawlRunId: string;
  records: readonly CrawledRecord[];
}): ChannelRecordRow[] {
  const rows = new Map<string, ChannelRecordRow>();
  for (const record of input.records) {
    const dedupeKey = companyIdentity({
      name: record.name,
      domain: record.website ?? null,
      country: record.country ?? null,
    }).dedupeKey;
    if (!dedupeKey || dedupeKey.length > 200) continue;
    if (rows.has(dedupeKey)) continue;
    const row: ChannelRecordRow = {
      channelId: input.channelId,
      crawlRunId: input.crawlRunId,
      dedupeKey,
      name: record.name.slice(0, 300),
      website: record.website?.slice(0, 2048) ?? null,
      country: record.country?.slice(0, 100) ?? null,
      industry: record.industry?.slice(0, 200) ?? null,
      products: record.products && record.products.length > 0 ? record.products.slice(0, 20) : null,
      keywords: record.keywords && record.keywords.length > 0 ? record.keywords.slice(0, 20) : null,
      contactName: record.contactName?.slice(0, 200) ?? null,
      contactTitle: record.contactTitle?.slice(0, 200) ?? null,
      email: record.email?.slice(0, 320) ?? null,
      phone: record.phone?.slice(0, 64) ?? null,
      sourceUrl: record.sourceUrl.slice(0, 2048),
      contentHash: '',
    };
    row.contentHash = recordContentHash(row);
    rows.set(dedupeKey, row);
  }
  return [...rows.values()];
}

/** 逐行 upsert 物化；返回写入条数（同轮折叠后的行数）。 */
export async function materializeChannelRecords(
  writer: ChannelRecordWriter,
  input: {
    channelId: string;
    crawlRunId: string;
    records: readonly CrawledRecord[];
    now?: () => number;
  },
): Promise<number> {
  const rows = buildChannelRecordRows(input);
  const seenAt = new Date(input.now ? input.now() : Date.now());
  for (const row of rows) {
    await writer.upsertByChannelAndDedupe(row, seenAt);
  }
  return rows.length;
}
