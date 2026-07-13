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

/** 假 BigQuery client（真 client 形态）：createQueryJob → getQueryResults + getMetadata（totalBytesProcessed 在完成后刷新）。 */
function fakeJobClient(rows: Array<Record<string, unknown>>, totalBytes?: string | number): BigQueryLike {
  return {
    query: async () => [rows],
    createQueryJob: async () => [
      {
        getQueryResults: async () => [rows],
        // createQueryJob 时 statistics 未含最终字节；getMetadata 完成后刷新（镜像真 @google-cloud/bigquery）
        metadata: { statistics: {} },
        getMetadata: async () => [{ statistics: { query: { totalBytesProcessed: totalBytes } } }],
      },
    ],
  };
}

describe('BigQueryPatents · assigneeLikeAnchor（SQL 宽预筛锚）', () => {
  it('剥法人后缀，取最长 token，包 %…%', () => {
    expect(assigneeLikeAnchor('Siemens AG')).toBe('%SIEMENS%');
    expect(assigneeLikeAnchor('Robert Bosch GmbH')).toBe('%ROBERT%'); // ROBERT(6) > BOSCH(5)
  });
  it('🔴 剥**全拼**法人形式（否则最长 token 会选中它们→无区分度谓词漏采）', () => {
    expect(assigneeLikeAnchor('Microsoft Corporation')).toBe('%MICROSOFT%'); // 非 %CORPORATION%
    expect(assigneeLikeAnchor('Siemens Aktiengesellschaft')).toBe('%SIEMENS%'); // 非 %AKTIENGESELLSCHAFT%
    expect(assigneeLikeAnchor('Acme Limited')).toBe('%ACME%'); // 非 %LIMITED%
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

describe('BigQueryPatents · maximumBytesBilled 成本护栏（env/默认路径）', () => {
  const saved = process.env.GOOGLE_PATENTS_MAX_GB;
  afterEach(() => {
    if (saved === undefined) delete process.env.GOOGLE_PATENTS_MAX_GB;
    else process.env.GOOGLE_PATENTS_MAX_GB = saved;
  });

  async function capturedMaxBytes(): Promise<string | undefined> {
    let seen: Parameters<BigQueryLike['query']>[0] | undefined;
    const client = new BigQueryPatentsClient({ makeClient: () => fakeClient([], (opts) => (seen = opts)) });
    await client.searchPatentsByAssignee('Siemens', { fromYear: 2021, toYear: 2026 });
    return seen?.maximumBytesBilled;
  }

  it('零配置（无 deps.maxGb、无 env）→ 默认 200GB', async () => {
    delete process.env.GOOGLE_PATENTS_MAX_GB;
    expect(await capturedMaxBytes()).toBe(String(200 * GB));
  });

  it('env 有效正值 → 尊重运维意图', async () => {
    process.env.GOOGLE_PATENTS_MAX_GB = '75';
    expect(await capturedMaxBytes()).toBe(String(75 * GB));
  });

  it('env=0（或负/NaN）→ 回落默认 200GB（不静默放行 0 字节顶）', async () => {
    process.env.GOOGLE_PATENTS_MAX_GB = '0';
    expect(await capturedMaxBytes()).toBe(String(200 * GB));
    process.env.GOOGLE_PATENTS_MAX_GB = 'not-a-number';
    expect(await capturedMaxBytes()).toBe(String(200 * GB));
  });
});

describe('BigQueryPatents · searchInventorsForAnchorsWithStats（bytesScanned 捕获）', () => {
  const OPTS = { fromYear: 2021, toYear: 2026 };
  const anchorRows = [{ assignee_name: 'Siemens AG', assignee_country: 'DE', inventor_name: 'MUELLER, HANS' }];

  it('真 client（createQueryJob）→ getMetadata 刷新后取 totalBytesProcessed', async () => {
    const client = new BigQueryPatentsClient({ makeClient: () => fakeJobClient(anchorRows, '48318382080') });
    const res = await client.searchInventorsForAnchorsWithStats(['%SIEMENS%'], OPTS);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].inventorName).toBe('MUELLER, HANS');
    expect(res.bytesScanned).toBe(48318382080); // 字符串字节 → number
  });

  it('查询缓存命中（totalBytesProcessed=0）→ bytesScanned=0（非 null，机制仍捕获）', async () => {
    const client = new BigQueryPatentsClient({ makeClient: () => fakeJobClient(anchorRows, 0) });
    const res = await client.searchInventorsForAnchorsWithStats(['%SIEMENS%'], OPTS);
    expect(res.bytesScanned).toBe(0);
  });

  it('仅 query 的旧/mock client（无 createQueryJob）→ 回退 query，bytesScanned=null，行为不变', async () => {
    const client = new BigQueryPatentsClient({ makeClient: () => fakeClient(anchorRows) });
    const res = await client.searchInventorsForAnchorsWithStats(['%SIEMENS%'], OPTS);
    expect(res.rows).toHaveLength(1);
    expect(res.bytesScanned).toBeNull();
  });

  it('无 creds（无 makeClient/env）→ 空 + bytesScanned=null（天然 no-op）', async () => {
    const client = new BigQueryPatentsClient();
    const res = await client.searchInventorsForAnchorsWithStats(['%SIEMENS%'], OPTS);
    expect(res).toEqual({ rows: [], bytesScanned: null });
  });
});
