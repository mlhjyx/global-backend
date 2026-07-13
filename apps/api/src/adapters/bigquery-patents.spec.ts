import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BigQueryPatentsClient,
  BigQueryLike,
  assigneeLikeAnchor,
  normalizeRow,
} from './bigquery-patents';

const GB = 1024 ** 3;

/** 假 BigQuery client：返回给定行，并把 query 选项透出供断言。 */
function fakeClient(rows: Array<Record<string, unknown>>, capture?: (opts: Parameters<BigQueryLike['query']>[0]) => void): BigQueryLike {
  return {
    query: async (opts) => {
      capture?.(opts);
      return [rows];
    },
  };
}

describe('BigQueryPatents · assigneeLikeAnchor（SQL 宽预筛锚）', () => {
  it('剥法人后缀，取最长 token，包 %…%', () => {
    expect(assigneeLikeAnchor('Siemens AG')).toBe('%SIEMENS%');
    expect(assigneeLikeAnchor('Robert Bosch GmbH')).toBe('%ROBERT%'); // ROBERT(6) > BOSCH(5)
  });
  it('全为停用词/过短 token → null（不查）', () => {
    expect(assigneeLikeAnchor('The Co')).toBeNull();
    expect(assigneeLikeAnchor('AB')).toBeNull();
    expect(assigneeLikeAnchor('   ')).toBeNull();
  });
  it('LIKE 通配符防御式转义（锚只含 [A-Z0-9]，仍不注入）', () => {
    expect(assigneeLikeAnchor('Acme%_ Corp')).toBe('%ACME%'); // 标点被空格化，% _ 不入锚
  });
});

describe('BigQueryPatents · normalizeRow（🔴 数据最小化）', () => {
  it('inventor 只留 name（丢 country_code）；applicant 留 alpha-2 国别', () => {
    const rec = normalizeRow({
      applicants: [{ name: 'SIEMENS AG', country: 'DE' }],
      inventors: [{ name: 'SCHMIDT, JOHANN', country: 'DE' }], // country 应被丢弃
    });
    expect(rec.applicants).toEqual([{ name: 'SIEMENS AG', country: 'de' }]);
    expect(rec.inventors).toEqual([{ name: 'SCHMIDT, JOHANN' }]); // 🔴 无 country
    expect((rec.inventors[0] as Record<string, unknown>).country).toBeUndefined();
  });
  it('非 alpha-2 国别 → undefined；空名过滤', () => {
    const rec = normalizeRow({
      applicants: [
        { name: 'Foo', country: 'Germany' }, // 非 alpha-2 → undefined
        { name: '', country: 'US' }, // 空名 → 过滤
      ],
      inventors: [{ name: '' }, { name: 'Jane Doe' }],
    });
    expect(rec.applicants).toEqual([{ name: 'Foo', country: undefined }]);
    expect(rec.inventors).toEqual([{ name: 'Jane Doe' }]);
  });
  it('缺字段/非数组 → 空数组（防御式）', () => {
    expect(normalizeRow({})).toEqual({ applicants: [], inventors: [] });
  });
});

describe('BigQueryPatents · searchPatentsByAssignee', () => {
  afterEach(() => vi.restoreAllMocks());

  it('查询参数 + maximumBytesBilled 成本护栏贯穿；行归一', async () => {
    let seen: Parameters<BigQueryLike['query']>[0] | undefined;
    const client = new BigQueryPatentsClient({
      maxGb: 50,
      makeClient: () =>
        fakeClient(
          [{ applicants: [{ name: 'Siemens AG', country: 'DE' }], inventors: [{ name: 'Hans Müller', country: 'DE' }] }],
          (opts) => (seen = opts),
        ),
    });
    const out = await client.searchPatentsByAssignee('Siemens AG', { fromYear: 2021, toYear: 2026 });
    // 结果归一（inventor 丢 country）
    expect(out).toEqual([
      { applicants: [{ name: 'Siemens AG', country: 'de' }], inventors: [{ name: 'Hans Müller' }] },
    ]);
    // 查询参数：日期 INT64 YYYYMMDD + 锚 + 成本硬顶
    expect(seen?.params).toMatchObject({ fromDate: 20210101, toDate: 20261231, assigneeLike: '%SIEMENS%' });
    expect(seen?.maximumBytesBilled).toBe(String(50 * GB)); // 🔴 护 1TB/月免费额度
  });

  it('无锚（公司名全停用词）→ 空、client 不被调', async () => {
    const makeClient = vi.fn();
    const client = new BigQueryPatentsClient({ makeClient });
    expect(await client.searchPatentsByAssignee('The Co', { fromYear: 2021, toYear: 2026 })).toEqual([]);
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('空公司名 → 空', async () => {
    const client = new BigQueryPatentsClient({ makeClient: () => fakeClient([]) });
    expect(await client.searchPatentsByAssignee('  ', { fromYear: 2021, toYear: 2026 })).toEqual([]);
  });

  it('无 creds（无 makeClient 且无 env）→ 空（天然 no-op，同 EPO 无 key）', async () => {
    const saved = {
      sa: process.env.GOOGLE_PATENTS_SA_JSON,
      adc: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      proj: process.env.GOOGLE_PATENTS_PROJECT,
    };
    delete process.env.GOOGLE_PATENTS_SA_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_PATENTS_PROJECT;
    try {
      const client = new BigQueryPatentsClient();
      expect(await client.searchPatentsByAssignee('Siemens', { fromYear: 2021, toYear: 2026 })).toEqual([]);
    } finally {
      if (saved.sa) process.env.GOOGLE_PATENTS_SA_JSON = saved.sa;
      if (saved.adc) process.env.GOOGLE_APPLICATION_CREDENTIALS = saved.adc;
      if (saved.proj) process.env.GOOGLE_PATENTS_PROJECT = saved.proj;
    }
  });

  it('maxRows clamp（超顶 → 内联进 SQL 的 LIMIT 受控）', async () => {
    let seen: Parameters<BigQueryLike['query']>[0] | undefined;
    const client = new BigQueryPatentsClient({ makeClient: () => fakeClient([], (opts) => (seen = opts)) });
    await client.searchPatentsByAssignee('Siemens', { fromYear: 2021, toYear: 2026, maxRows: 99999 });
    expect(seen?.query).toContain('LIMIT 2000'); // clamp 到 MAX_ROWS_CEIL
  });
});
