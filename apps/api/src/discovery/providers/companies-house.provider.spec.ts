import { describe, expect, it, vi } from 'vitest';
import {
  CompaniesHouseContactProvider,
  isUkCompany,
  toReadableName,
  toContactRecord,
} from './companies-house.provider';
import type { ChCompanyHit, ChOfficer } from '../../adapters/companies-house';
import type { CompaniesHouseInput, CompaniesHouseOutput } from '../../tools/source-tools';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import { ExecutionContext } from '../provider-contract';

const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1' };

/** 假 Broker：按 op 分发 search/officers；抛错 = 闸门拒绝/工具失败。 */
function fakeBroker(handlers: {
  search?: () => ChCompanyHit[];
  officers?: () => ChOfficer[];
  throwOn?: 'search' | 'officers';
}): ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(async (_toolId: string, input: CompaniesHouseInput): Promise<ToolResult<CompaniesHouseOutput>> => {
    if (input.op === 'search') {
      if (handlers.throwOn === 'search') throw new Error('gate denied');
      return { data: { companies: handlers.search?.() ?? [] }, costCents: 0 };
    }
    if (handlers.throwOn === 'officers') throw new Error('gate denied');
    return { data: { officers: handlers.officers?.() ?? [] }, costCents: 0 };
  });
  return {
    invokeMock,
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: invokeMock as unknown as ExecutionBroker['invoke'],
  };
}

const hit = (companyNumber: string, title: string, companyStatus = 'active'): ChCompanyHit => ({ companyNumber, title, companyStatus });
const officer = (name: string, officerRole = 'director', extra: Partial<ChOfficer> = {}): ChOfficer => ({ name, officerRole, ...extra });

describe('CH · isUkCompany（GB 门）', () => {
  it('英国国别归一集命中', () => {
    for (const c of ['GB', 'uk', 'GBR', 'United Kingdom', 'England']) expect(isUkCompany(c)).toBe(true);
  });
  it('国别缺失时 .uk/.co.uk 域名作弱兜底 → true', () => {
    expect(isUkCompany(undefined, 'foo.co.uk')).toBe(true);
    expect(isUkCompany('', 'foo.uk')).toBe(true);
  });
  it('🔴 HIGH-2 country 优先：显式非英辖区（.uk 域名）一律 false', () => {
    // 新加坡公司买 .uk 营销域名 → 绝不当英国公司搜（.uk 自 2014 全球开放注册 ≠ 英国辖区）
    expect(isUkCompany('SG', 'precisiontools.uk')).toBe(false);
    expect(isUkCompany('DE', 'foo.co.uk')).toBe(false);
    expect(isUkCompany('GB', undefined)).toBe(true); // country=GB 无域名 → true
  });
  it('非英公司（DE + .de）→ false；两者皆空 → false', () => {
    expect(isUkCompany('DE', 'foo.de')).toBe(false);
    expect(isUkCompany(undefined, undefined)).toBe(false);
  });
});

describe('CH · toReadableName（SURNAME, Given → 可读 + 词首大写）', () => {
  it('逗号语序归位 + Title-Case', () => {
    expect(toReadableName('SMITH, John David')).toBe('John David Smith');
    expect(toReadableName("O'BRIEN, Sean")).toBe("Sean O'Brien");
    expect(toReadableName('SMITH-JONES, Anne')).toBe('Anne Smith-Jones');
  });
  it('无逗号 → 整体 Title-Case', () => {
    expect(toReadableName('JOHN SMITH')).toBe('John Smith');
  });
});

describe('CH · toContactRecord', () => {
  it('董事 → externalIds(uk-ch-officer) + personalData + OGL license + 无 DOB', () => {
    const rec = toContactRecord(officer('SMITH, John', 'director', { officerId: 'OID1' }), hit('02723534', 'ASTRAZENECA PLC'));
    expect(rec.fullName).toBe('John Smith');
    expect(rec.title).toBe('Director');
    expect(rec.seniority).toBe('director');
    expect(rec.buyingRole).toBe('economic_buyer');
    expect(rec.personalData).toBe(true);
    expect(rec.externalIds).toEqual([{ scheme: 'uk-ch-officer', value: 'OID1' }]);
    expect(rec.license).toBe('OGL-UK-3.0');
    expect(rec.sourcePage).toContain('/company/02723534');
    expect(JSON.stringify(rec)).not.toMatch(/date_of_birth|nationality/i);
  });
  it('无 officerId → externalIds undefined（退 Tier 2 名，不臆造键）', () => {
    expect(toContactRecord(officer('SMITH, John'), hit('1', 'X')).externalIds).toBeUndefined();
  });
});

describe('CH · discoverContacts', () => {
  const ukCompany = { name: 'AstraZeneca', domain: 'astrazeneca.com', country: 'GB' };

  it('🔴 GB 门：非英公司 → 空（不搜、不调 broker）', async () => {
    const broker = fakeBroker({ search: () => [hit('1', 'AstraZeneca')] });
    const provider = new CompaniesHouseContactProvider({ broker });
    const res = await provider.discoverContacts({ name: 'AstraZeneca', domain: 'astra.de', country: 'DE' }, CTX);
    expect(res.contacts).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('无 broker → 空（fail-closed，不出网）', async () => {
    const res = await new CompaniesHouseContactProvider({}).discoverContacts(ukCompany, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('公司对齐命中（高置信）+ 只留 active director → ProviderContactRecord', async () => {
    const broker = fakeBroker({
      search: () => [hit('02723534', 'ASTRAZENECA PLC', 'active'), hit('99', 'ASTRAZENECA UK LIMITED', 'dissolved')],
      officers: () => [
        officer('SMITH, John', 'director', { officerId: 'OID1' }),
        officer('DOE, Jane', 'secretary', { officerId: 'OID2' }), // 剔除（非 director）
        officer('OLD, Bob', 'director', { officerId: 'OID3', resignedOn: '2020-01-01' }), // 剔除（已卸任）
      ],
    });
    const provider = new CompaniesHouseContactProvider({ broker });
    const res = await provider.discoverContacts(ukCompany, CTX);
    expect(res.contacts).toHaveLength(1);
    expect(res.contacts[0].fullName).toBe('John Smith');
    expect(res.contacts[0].externalIds).toEqual([{ scheme: 'uk-ch-officer', value: 'OID1' }]);
    // purpose='discovery' 贯穿（用途门按本次调用判）
    const searchCtx = broker.invokeMock.mock.calls[0][2] as ToolContext;
    expect(searchCtx.purpose).toBe('discovery');
  });

  it('🔴 歧义/低置信公司对齐 → 弃（返空，绝不挂错公司）', async () => {
    // 两个同前缀候选（margin 小）：pickBestByName 分不出突出者
    const broker = fakeBroker({
      search: () => [hit('1', 'Acme'), hit('2', 'Acme')],
      officers: () => [officer('SMITH, John', 'director', { officerId: 'OID1' })],
    });
    const provider = new CompaniesHouseContactProvider({ broker });
    const res = await provider.discoverContacts({ name: 'Acme', domain: 'acme.co.uk', country: 'GB' }, CTX);
    expect(res.contacts).toEqual([]);
    // 只调了 search，未取 officers（对齐失败即止）
    expect(broker.invokeMock).toHaveBeenCalledTimes(1);
  });

  it('只留 active 公司：命中的是 dissolved → 无 active 候选 → 空', async () => {
    const broker = fakeBroker({ search: () => [hit('1', 'AstraZeneca', 'dissolved')], officers: () => [officer('SMITH, John', 'director', { officerId: 'X' })] });
    const res = await new CompaniesHouseContactProvider({ broker }).discoverContacts(ukCompany, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('fail-safe：闸门拒绝（invoke 抛）→ 空、不抛穿', async () => {
    const broker = fakeBroker({ throwOn: 'search' });
    const res = await new CompaniesHouseContactProvider({ broker }).discoverContacts(ukCompany, CTX);
    expect(res.contacts).toEqual([]);
  });
});
