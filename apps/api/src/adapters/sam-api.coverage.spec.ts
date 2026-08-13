import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourcesSought, samDateToIso, mapSamRow } from './sam-api';

describe('samDateToIso —— SAM 日期归一 ISO（§8.6 防 NaN 静默）', () => {
  // 🔴 精确 UTC 断言（非仅前缀/年）——无时区字面量一律当 UTC，绝不经运行时本地时区。
  // 旧实现在正 UTC 偏移环境（如 Asia/Shanghai）会把这些整体拨回前一天；这些用例锁定契约、防回归。
  it('YYYY-MM-DD → UTC 午夜（当 UTC，不经本地时区）', () => {
    expect(samDateToIso('2026-01-08')).toBe('2026-01-08T00:00:00.000Z');
  });
  it('YYYY-MM-DD HH:mm:ss（无时区）→ 当 UTC（不按本地时区偏移）', () => {
    expect(samDateToIso('2026-01-08 15:30:00')).toBe('2026-01-08T15:30:00.000Z');
  });
  it('🔴 午夜无时区串不跨日错位（旧 bug：Asia/Shanghai 会变 01-07）', () => {
    expect(samDateToIso('2026-01-08 00:00:00')).toBe('2026-01-08T00:00:00.000Z');
  });
  it('MM/DD/YYYY → UTC 午夜同一日历日（旧 bug：本地构造 → 01-07）', () => {
    expect(samDateToIso('01/08/2026')).toBe('2026-01-08T00:00:00.000Z');
  });
  it('MM/DD/YYYY HH:mm（带时间）→ 当 UTC', () => {
    expect(samDateToIso('01/08/2026 09:30')).toBe('2026-01-08T09:30:00.000Z');
  });
  it('ISO 带 Z → 原样归一（真实 SAM 主路，保持不变）', () => {
    expect(samDateToIso('2026-07-12T23:28:27.462Z')).toBe('2026-07-12T23:28:27.462Z');
  });
  it('ISO 带 ±offset → 正确换算 UTC', () => {
    expect(samDateToIso('2026-07-12T23:28:27-04:00')).toBe('2026-07-13T03:28:27.000Z');
  });
  // 🔴 SAM 真实格式（curl 实探）——PostedDate=空格分隔+裸 -04；ResponseDeadLine=T+-05:00。都带显式 offset。
  it('SAM 真实 PostedDate：空格分隔 + 裸 -04 offset → 正确 UTC', () => {
    expect(samDateToIso('2026-07-13 23:28:13.676-04')).toBe('2026-07-14T03:28:13.676Z');
  });
  it('SAM 真实 ResponseDeadLine：T + -05:00 offset → 正确 UTC', () => {
    expect(samDateToIso('2026-07-14T18:00:00-05:00')).toBe('2026-07-14T23:00:00.000Z');
  });
  it('空/undefined/非法 → null', () => {
    expect(samDateToIso('')).toBeNull();
    expect(samDateToIso(undefined)).toBeNull();
    expect(samDateToIso('not-a-date')).toBeNull();
  });
});

describe('mapSamRow —— CSV 行 → 绿字段（🔴 PII 结构性剔除）', () => {
  const row: Record<string, string> = {
    NoticeId: 'abc123',
    Title: 'Pump maintenance services',
    'Department/Ind.Agency': 'VETERANS AFFAIRS, DEPARTMENT OF',
    'Sub-Tier': 'VETERANS HEALTH ADMINISTRATION',
    Office: 'NETWORK CONTRACTING OFFICE 1',
    PostedDate: '2026-01-08 09:00:00',
    Type: 'Sources Sought',
    NaicsCode: '333914',
    ResponseDeadLine: '2026-02-08 17:00:00',
    PopCountry: 'USA',
    Link: 'https://sam.gov/opp/abc123',
    // 🔴 PII 列（必须被结构性剔除）
    PrimaryContactFullname: 'Jane Doe',
    PrimaryContactEmail: 'jane.doe@va.gov',
    PrimaryContactPhone: '555-1234',
    SecondaryContactFullname: 'John Smith',
    SecondaryContactEmail: 'john.smith@va.gov',
    Awardee: 'Should Not Appear Inc',
  };

  it('只取绿字段（机构/公告事实）', () => {
    const out = mapSamRow(row);
    expect(out.noticeId).toBe('abc123');
    expect(out.department).toBe('VETERANS AFFAIRS, DEPARTMENT OF');
    expect(out.subTier).toBe('VETERANS HEALTH ADMINISTRATION');
    expect(out.naicsCode).toBe('333914');
    expect(out.postedDateIso).toMatch(/^2026-01-08T/);
    expect(out.responseDeadlineIso).toMatch(/^2026-02-08T/);
  });

  it('🔴 输出绝不含任何 PII/联系人/中标方（值层面）', () => {
    const out = mapSamRow(row);
    const serialized = JSON.stringify(out).toLowerCase();
    for (const leak of ['jane', 'doe', '@va.gov', '555-1234', 'john smith', 'should not appear']) {
      expect(serialized, `泄漏 "${leak}"`).not.toContain(leak);
    }
  });

  it('🔴 输出键层面无 contact/email/phone/awardee 字段', () => {
    const out = mapSamRow(row);
    expect(Object.keys(out).some((k) => /contact|email|phone|awardee/i.test(k))).toBe(false);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchSourcesSought bounded CSV ingestion', () => {
  it('filters type/window, preserves unknown dates, sorts newest first and applies maxRecords', async () => {
    const csv = [
      'NoticeId,Title,Department/Ind.Agency,Sub-Tier,Office,PostedDate,Type,NaicsCode,ResponseDeadLine,PopCountry,Link,PrimaryContactEmail',
      'old,Old,D,S,O,01/01/2020,Sources Sought,333914,,,,secret@example.test',
      'other,Other,D,S,O,08/01/2026,Solicitation,333914,,,,secret@example.test',
      'unknown,Unknown,D,S,O,not-a-date,Sources Sought,333914,,,,secret@example.test',
      'new,New,D,S,O,08/07/2026,Sources Sought,333914,,USA,https://sam.gov/new,secret@example.test',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(csv, { status: 200 })));

    await expect(fetchSourcesSought({ sinceDays: 120, maxRecords: 1 })).resolves.toEqual([
      expect.objectContaining({ noticeId: 'new', postedDateIso: '2026-08-07T00:00:00.000Z' }),
    ]);
    const all = await fetchSourcesSought({ sinceDays: 120, maxRecords: 10 });
    expect(all.map(({ noticeId }) => noticeId)).toEqual(['new', 'unknown']);
    expect(JSON.stringify(all)).not.toContain('secret@example.test');
  });

  it('uses default limits and rejects non-success or missing bodies', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 503 }))
      .mockResolvedValueOnce({ ok: true, status: 200, body: null });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSourcesSought()).rejects.toThrow('sam.gov CSV 503');
    await expect(fetchSourcesSought()).rejects.toThrow('sam.gov CSV 200');
  });

  it('converts source-stream failures into an ordinary caller-visible parsing error', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error('stream-reset');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body })));
    await expect(fetchSourcesSought({ maxRecords: 2 })).rejects.toThrow('sam.gov CSV');
  });
});
