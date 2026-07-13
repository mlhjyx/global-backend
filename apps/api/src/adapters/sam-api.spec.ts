import { describe, expect, it } from 'vitest';
import { samDateToIso, mapSamRow } from './sam-api';

describe('samDateToIso —— SAM 日期归一 ISO（§8.6 防 NaN 静默）', () => {
  it('YYYY-MM-DD → ISO', () => {
    expect(samDateToIso('2026-01-08')).toMatch(/^2026-01-08T/);
  });
  it('YYYY-MM-DD HH:mm:ss → ISO', () => {
    expect(samDateToIso('2026-01-08 15:30:00')).toMatch(/^2026-01-08T/);
  });
  it('MM/DD/YYYY → ISO', () => {
    const iso = samDateToIso('01/08/2026');
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getUTCFullYear()).toBe(2026);
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
