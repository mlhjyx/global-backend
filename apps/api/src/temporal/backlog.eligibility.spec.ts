import { describe, expect, it } from 'vitest';
import {
  BACKLOG_WATERMARK_TTL_MS,
  backlogEligibleWhere,
  backlogEligibleOrderBy,
  watermarkCutoff,
  type WatermarkField,
} from './backlog.eligibility';

const NOW = new Date('2026-07-08T00:00:00.000Z');

describe('backlogEligibleWhere（存量下游阶段收缩集谓词）', () => {
  it('恒含 fit=match + 未抑制（漏斗资格门后的处理目标）', () => {
    const where = backlogEligibleWhere({ watermarkField: 'lastEnrichedAt', now: NOW });
    expect(where.fitVerdict).toBe('match');
    expect(where.status).toEqual({ not: 'SUPPRESSED' });
  });

  it('水位收缩：null（从未处理）或 < now-TTL（已过冷却期）才入选', () => {
    const where = backlogEligibleWhere({ watermarkField: 'lastSignalAt', now: NOW });
    const cutoff = new Date(NOW.getTime() - BACKLOG_WATERMARK_TTL_MS.lastSignalAt);
    expect(where.OR).toEqual([{ lastSignalAt: null }, { lastSignalAt: { lt: cutoff } }]);
  });

  it('cutoff = now - 该字段 TTL（watermarkCutoff 与 WHERE 一致）', () => {
    const where = backlogEligibleWhere({ watermarkField: 'lastWatchAt', now: NOW });
    const cutoff = watermarkCutoff('lastWatchAt', NOW);
    expect(cutoff).toEqual(new Date(NOW.getTime() - BACKLOG_WATERMARK_TTL_MS.lastWatchAt));
    expect((where.OR as { lastWatchAt: { lt: Date } }[])[1].lastWatchAt.lt).toEqual(cutoff);
  });

  it('每个水位字段的 OR 锚定自身列（不串字段）', () => {
    const fields: WatermarkField[] = ['lastEnrichedAt', 'lastSignalAt', 'lastWatchAt', 'contactDiscoveryAttemptedAt'];
    for (const field of fields) {
      const where = backlogEligibleWhere({ watermarkField: field, now: NOW });
      const cutoff = watermarkCutoff(field, NOW);
      expect(where.OR).toEqual([{ [field]: null }, { [field]: { lt: cutoff } }]);
    }
  });

  it('TTL 分级：enrich 30d / signal 7d / watch 14d / contact 14d', () => {
    const day = 24 * 3600 * 1000;
    expect(BACKLOG_WATERMARK_TTL_MS.lastEnrichedAt).toBe(30 * day);
    expect(BACKLOG_WATERMARK_TTL_MS.lastSignalAt).toBe(7 * day);
    expect(BACKLOG_WATERMARK_TTL_MS.lastWatchAt).toBe(14 * day);
    expect(BACKLOG_WATERMARK_TTL_MS.contactDiscoveryAttemptedAt).toBe(14 * day);
  });

  it('WHERE 不含 id 键（分页/进度靠 stamp-after-touch + LRU 排序，非 id 游标）', () => {
    const where = backlogEligibleWhere({ watermarkField: 'lastEnrichedAt', now: NOW });
    expect('id' in where).toBe(false);
  });

  it('backlogEligibleOrderBy：水位 ASC NULLS FIRST + id ASC 决胜（最久未处理优先，根除 C×T 跑步机饿死）', () => {
    const fields: WatermarkField[] = ['lastEnrichedAt', 'lastSignalAt', 'lastWatchAt', 'contactDiscoveryAttemptedAt'];
    for (const field of fields) {
      expect(backlogEligibleOrderBy(field)).toEqual([{ [field]: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }]);
    }
  });

  it('requireDomain → domain not null（信号/监控/联系人阶段）；缺省不加', () => {
    const withDomain = backlogEligibleWhere({ watermarkField: 'lastSignalAt', now: NOW, requireDomain: true });
    expect(withDomain.domain).toEqual({ not: null });
    const withoutDomain = backlogEligibleWhere({ watermarkField: 'lastEnrichedAt', now: NOW });
    expect('domain' in withoutDomain).toBe(false);
  });

  it('requireNoContacts → contacts none（联系人阶段，与结果依赖谓词叠加）；缺省不加', () => {
    const withNoContacts = backlogEligibleWhere({
      watermarkField: 'contactDiscoveryAttemptedAt',
      now: NOW,
      requireDomain: true,
      requireNoContacts: true,
    });
    expect(withNoContacts.contacts).toEqual({ none: {} });
    const withoutFlag = backlogEligibleWhere({ watermarkField: 'lastEnrichedAt', now: NOW });
    expect('contacts' in withoutFlag).toBe(false);
  });
});
