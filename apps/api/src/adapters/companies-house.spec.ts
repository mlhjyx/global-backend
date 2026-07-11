import { describe, expect, it, vi } from 'vitest';
import {
  extractOfficerId,
  mapCompanyHit,
  mapOfficer,
  searchCompanies,
  listOfficers,
} from './companies-house';

describe('CH · extractOfficerId（纯函数）', () => {
  it('从 /officers/{ID}/appointments 抽 id', () => {
    expect(extractOfficerId('/officers/abc123XYZ/appointments')).toBe('abc123XYZ');
  });
  it('缺/畸形 → undefined', () => {
    expect(extractOfficerId(undefined)).toBeUndefined();
    expect(extractOfficerId('/company/00048839')).toBeUndefined();
  });
});

describe('CH · mapCompanyHit（🟢 公司事实）', () => {
  it('取 company_number/title/status（status 归一小写）', () => {
    expect(mapCompanyHit({ company_number: '02723534', title: 'ASTRAZENECA PLC', company_status: 'Active' })).toEqual({
      companyNumber: '02723534',
      title: 'ASTRAZENECA PLC',
      companyStatus: 'active',
    });
  });
  it('缺 company_number 或 title → null（主键缺失不臆造）', () => {
    expect(mapCompanyHit({ title: 'X' })).toBeNull();
    expect(mapCompanyHit({ company_number: '1' })).toBeNull();
  });
});

describe('CH · mapOfficer（🔴 具名个人，数据最小化）', () => {
  const raw = {
    name: 'SMITH, John David',
    officer_role: 'Director',
    resigned_on: undefined,
    // 🔴 下列个人数据字段真实存在于 CH 响应 —— 断言 mapOfficer 绝不摄入它们
    date_of_birth: { month: 5, year: 1970 },
    nationality: 'British',
    occupation: 'Engineer',
    address: { locality: 'London', postal_code: 'EC1A 1AA' },
    links: { officer: { appointments: '/officers/OID999/appointments' } },
  };

  it('只映射 name/role/resigned/officer_id（role 归一小写）', () => {
    expect(mapOfficer(raw)).toEqual({
      name: 'SMITH, John David',
      officerRole: 'director',
      resignedOn: undefined,
      officerId: 'OID999',
    });
  });

  it('🔴 数据最小化：结果绝不含 DOB / nationality / occupation / address', () => {
    const out = mapOfficer(raw)!;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/date_of_birth|1970|nationality|British|occupation|Engineer|address|London|EC1A/i);
    expect(Object.keys(out).sort()).toEqual(['name', 'officerId', 'officerRole', 'resignedOn'].sort());
  });

  it('resigned_on 保留（provider 据此过滤已卸任）', () => {
    expect(mapOfficer({ ...raw, resigned_on: '2020-01-01' })?.resignedOn).toBe('2020-01-01');
  });

  it('缺 name 或 role → null', () => {
    expect(mapOfficer({ officer_role: 'director' })).toBeNull();
    expect(mapOfficer({ name: 'X' })).toBeNull();
  });
});

describe('CH · searchCompanies（注入假 fetch，不真打网）', () => {
  it('Basic auth（key:空pw base64）+ items_per_page + 解析', async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      // 断言 URL + Basic auth 头
      expect(String(url)).toContain('/search/companies?');
      expect(String(url)).toContain('q=AstraZeneca');
      expect(String(url)).toContain('items_per_page=5');
      return new Response(
        JSON.stringify({ items: [{ company_number: '02723534', title: 'ASTRAZENECA PLC', company_status: 'active' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const out = await searchCompanies('AstraZeneca', 5, { fetchImpl, apiKey: 'KEY123' });
    expect(out).toEqual([{ companyNumber: '02723534', title: 'ASTRAZENECA PLC', companyStatus: 'active' }]);
    // 校验 Authorization: Basic base64("KEY123:")
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from('KEY123:').toString('base64')}`);
  });

  it('无 key → 抛（provider fail-safe 捕获）', async () => {
    await expect(searchCompanies('X', 5, { fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch, apiKey: '' })).rejects.toThrow(
      /COMPANIES_HOUSE_API_KEY/,
    );
  });

  it('404 → 空数组（非抛）', async () => {
    const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await searchCompanies('X', 5, { fetchImpl, apiKey: 'K' })).toEqual([]);
  });
});

describe('CH · listOfficers（注入假 fetch）', () => {
  it('URL + 数据最小化解析（secretary/无效行照常映射，过滤交 provider）', async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      expect(String(url)).toContain('/company/02723534/officers');
      return new Response(
        JSON.stringify({
          items: [
            { name: 'SMITH, John', officer_role: 'director', date_of_birth: { year: 1970 }, links: { officer: { appointments: '/officers/OID1/appointments' } } },
            { name: 'DOE, Jane', officer_role: 'secretary', links: { officer: { appointments: '/officers/OID2/appointments' } } },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await listOfficers('02723534', 50, { fetchImpl, apiKey: 'K' });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'SMITH, John', officerRole: 'director', resignedOn: undefined, officerId: 'OID1' });
    expect(JSON.stringify(out)).not.toMatch(/1970|date_of_birth/);
  });
});
