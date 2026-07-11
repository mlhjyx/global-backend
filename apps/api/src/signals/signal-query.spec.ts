import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INGEST_WINDOW_MS,
  canonicalFdaSpec,
  canonicalTedSpec,
  ingestWindowMs,
  queryFingerprint,
  windowKeyFor,
} from './signal-query';

describe('canonicalTedSpec / canonicalFdaSpec —— 查询规范化（码序/国序/重复/大小写无关）', () => {
  it('TED：码与国别排序去重、大写归一，默认 sinceDays=30 / maxRecords=100', () => {
    const spec = canonicalTedSpec({ cpvCodes: ['42122000', '42120000', '42122000'], buyerCountries: ['deu', 'FRA'] });
    expect(spec).toEqual({
      provider: 'ted',
      kind: 'contract',
      cpvCodes: ['42120000', '42122000'],
      buyerCountries: ['DEU', 'FRA'].sort(),
      sinceDays: 30,
      maxRecords: 100,
    });
  });

  it('openFDA：产品码大写排序去重，默认 sinceDays=365 / maxRecords=200，国别可空', () => {
    const spec = canonicalFdaSpec({ productCodes: ['llz', 'IYN', 'LLZ'] });
    expect(spec).toEqual({
      provider: 'openfda',
      kind: '510k',
      productCodes: ['IYN', 'LLZ'],
      applicantCountries: [],
      sinceDays: 365,
      maxRecords: 200,
    });
  });
});

describe('queryFingerprint —— ingest-once 的拉取键（收口⑤验收：跨 workspace 同参共享一次拉取）', () => {
  it('同参不同序/重复/大小写 → 同指纹（sha256 hex）', () => {
    const f1 = queryFingerprint(canonicalTedSpec({ cpvCodes: ['42122000', '42961000'], buyerCountries: ['DEU'] }));
    const f2 = queryFingerprint(canonicalTedSpec({ cpvCodes: ['42961000', '42122000', '42122000'], buyerCountries: ['deu'] }));
    expect(f1).toBe(f2);
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('参数不同 → 指纹不同（码集/国别/sinceDays 都参与）', () => {
    const base = canonicalTedSpec({ cpvCodes: ['42122000'], buyerCountries: ['DEU'] });
    expect(queryFingerprint(canonicalTedSpec({ cpvCodes: ['42122001'], buyerCountries: ['DEU'] }))).not.toBe(queryFingerprint(base));
    expect(queryFingerprint(canonicalTedSpec({ cpvCodes: ['42122000'], buyerCountries: ['FRA'] }))).not.toBe(queryFingerprint(base));
    expect(queryFingerprint(canonicalTedSpec({ cpvCodes: ['42122000'], buyerCountries: ['DEU'], sinceDays: 7 }))).not.toBe(queryFingerprint(base));
  });

  it('provider 参与指纹（ted 与 openfda 绝不撞键）', () => {
    const ted = queryFingerprint(canonicalTedSpec({ cpvCodes: ['X'], buyerCountries: ['DEU'] }));
    const fda = queryFingerprint(canonicalFdaSpec({ productCodes: ['X'] }));
    expect(ted).not.toBe(fda);
  });
});

describe('windowKeyFor —— 时间窗桶（收口⑤「同一时间窗」的可测定义：对齐的 UTC 桶起点 ISO）', () => {
  const W = 6 * 3600_000;

  it('同窗同键、跨窗异键，键=桶起点 ISO', () => {
    const t0 = Date.UTC(2026, 6, 11, 7, 30);
    expect(windowKeyFor(t0, W)).toBe('2026-07-11T06:00:00.000Z');
    expect(windowKeyFor(Date.UTC(2026, 6, 11, 11, 59), W)).toBe(windowKeyFor(t0, W));
    expect(windowKeyFor(Date.UTC(2026, 6, 11, 12, 0), W)).not.toBe(windowKeyFor(t0, W));
  });

  it('窗口默认 6h、env SIGNAL_INGEST_WINDOW_MS 可调（非法值回退默认）', () => {
    expect(DEFAULT_INGEST_WINDOW_MS).toBe(6 * 3600_000);
    const prev = process.env.SIGNAL_INGEST_WINDOW_MS;
    try {
      process.env.SIGNAL_INGEST_WINDOW_MS = '3600000';
      expect(ingestWindowMs()).toBe(3_600_000);
      process.env.SIGNAL_INGEST_WINDOW_MS = 'not-a-number';
      expect(ingestWindowMs()).toBe(DEFAULT_INGEST_WINDOW_MS);
      process.env.SIGNAL_INGEST_WINDOW_MS = '0'; // 0/负值会令所有时刻同桶或除零 → 回退默认
      expect(ingestWindowMs()).toBe(DEFAULT_INGEST_WINDOW_MS);
    } finally {
      if (prev === undefined) delete process.env.SIGNAL_INGEST_WINDOW_MS;
      else process.env.SIGNAL_INGEST_WINDOW_MS = prev;
    }
  });
});
