import { describe, expect, it, vi } from 'vitest';
import {
  buildChannelRecordRows,
  materializeChannelRecords,
  type ChannelRecordRow,
} from './channel-records';
import type { CrawledRecord } from './channel-crawler';

const CHANNEL_ID = '77777777-7777-4777-8777-777777777777';
const CRAWL_RUN_ID = '88888888-8888-4888-8888-888888888888';

function record(overrides: Partial<CrawledRecord> = {}): CrawledRecord {
  return {
    name: 'Acme Pumpen GmbH',
    website: 'https://acme-pumpen.de/',
    country: 'Germany',
    industry: 'Pumpen',
    products: ['Pumpen', 'Ventile'],
    keywords: ['pump'],
    contactName: 'Max Mustermann',
    contactTitle: 'Sales Manager',
    email: 'sales@acme-pumpen.de',
    phone: '+49 30 123456',
    sourceUrl: 'https://expo.example/exhibitor/acme',
    ...overrides,
  };
}

describe('channel records 物化（buildChannelRecordRows）', () => {
  it('keys by company domain and carries the full field set', () => {
    const rows = buildChannelRecordRows({ channelId: CHANNEL_ID, crawlRunId: CRAWL_RUN_ID, records: [record()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channelId: CHANNEL_ID,
      crawlRunId: CRAWL_RUN_ID,
      dedupeKey: 'd:acme-pumpen.de',
      name: 'Acme Pumpen GmbH',
      website: 'https://acme-pumpen.de/',
      contactName: 'Max Mustermann',
      email: 'sales@acme-pumpen.de',
      phone: '+49 30 123456',
      sourceUrl: 'https://expo.example/exhibitor/acme',
    });
    expect(rows[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('falls back to name+country identity when no website exists', () => {
    // 含空格/非 ASCII 的名称走 name_country 的 ASCII 形式（n:h<sha256>，物化契约要求）；
    // 键只做相等比较，跨轮 upsert 稳定性由同名同键保证。
    const build = () =>
      buildChannelRecordRows({
        channelId: CHANNEL_ID,
        crawlRunId: CRAWL_RUN_ID,
        records: [record({ website: undefined, name: 'Beta Werke GmbH', country: 'Austria' })],
      });
    expect(build()[0]!.dedupeKey).toMatch(/^n:h[0-9a-f]{64}:austria$/u);
    expect(build()[0]!.dedupeKey).toBe(build()[0]!.dedupeKey);
  });

  it('folds duplicates within a run (same dedupe key, first wins)', () => {
    const rows = buildChannelRecordRows({
      channelId: CHANNEL_ID,
      crawlRunId: CRAWL_RUN_ID,
      records: [record({ name: 'Acme Pumpen GmbH' }), record({ name: 'Acme Pumpen', email: 'other@acme-pumpen.de' })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('sales@acme-pumpen.de');
  });

  it('content hash changes when crawled fields change', () => {
    const [a] = buildChannelRecordRows({ channelId: CHANNEL_ID, crawlRunId: CRAWL_RUN_ID, records: [record()] });
    const [b] = buildChannelRecordRows({
      channelId: CHANNEL_ID,
      crawlRunId: CRAWL_RUN_ID,
      records: [record({ email: 'new@acme-pumpen.de' })],
    });
    expect(a!.contentHash).not.toBe(b!.contentHash);
  });
});

describe('materializeChannelRecords', () => {
  it('upserts every folded row and returns the materialized count', async () => {
    const rows: ChannelRecordRow[] = [];
    const writer = {
      upsertByChannelAndDedupe: vi.fn(async (row: ChannelRecordRow, seenAt: Date) => {
        rows.push({ ...row, contentHash: `${row.contentHash}@${seenAt.toISOString()}` });
      }),
    };
    const count = await materializeChannelRecords(writer, {
      channelId: CHANNEL_ID,
      crawlRunId: CRAWL_RUN_ID,
      records: [record(), record({ email: 'other@acme-pumpen.de' }), record({ website: 'https://beta.example/', name: 'Beta Werke' })],
      now: () => Date.UTC(2026, 10, 5, 9, 0, 0),
    });
    expect(count).toBe(2);
    expect(writer.upsertByChannelAndDedupe).toHaveBeenCalledTimes(2);
    expect(rows.every((row) => row.contentHash.endsWith('2026-11-05T09:00:00.000Z'))).toBe(true);
  });
});
