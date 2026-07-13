import { describe, expect, it, vi } from 'vitest';
import {
  GooglePatentsInventorProvider,
  countryConflicts,
  toReadableName,
  toContactRecord,
  currentYear,
} from './bigquery-patents.provider';
import type { PatentApplicant, PatentRecord } from '../../adapters/bigquery-patents';
import type { GooglePatentsInput, GooglePatentsOutput } from '../../tools/source-tools';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import { ExecutionContext } from '../provider-contract';

const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1' };
const FIXED_NOW = (): number => Date.UTC(2026, 0, 15); // 固定时钟 → currentYear 2026, fromYear 2021

/** 假 Broker：返回 patents，或抛错（闸门拒绝/工具失败）。 */
function fakeBroker(opts: { patents?: () => PatentRecord[]; throwErr?: boolean }): ExecutionBroker & {
  invokeMock: ReturnType<typeof vi.fn>;
} {
  const invokeMock = vi.fn(async (_toolId: string, _input: GooglePatentsInput): Promise<ToolResult<GooglePatentsOutput>> => {
    if (opts.throwErr) throw new Error('gate denied');
    return { data: { patents: opts.patents?.() ?? [] }, costCents: 0 };
  });
  return {
    invokeMock,
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: invokeMock as unknown as ExecutionBroker['invoke'],
  };
}

const appl = (name: string, country?: string): PatentApplicant => ({ name, country });
const patent = (applicants: PatentApplicant[], inventors: string[]): PatentRecord => ({
  applicants,
  inventors: inventors.map((name) => ({ name })),
});

describe('GooglePatents · countryConflicts（国别门）', () => {
  it('都为 alpha-2 且不同 → 冲突', () => {
    expect(countryConflicts('DE', 'US')).toBe(true);
    expect(countryConflicts('de', 'US')).toBe(true);
  });
  it('相同 → 不冲突', () => {
    expect(countryConflicts('DE', 'DE')).toBe(false);
  });
  it('任一非 alpha-2（全称/缺失）→ 不冲突（欠并方向，靠名对齐）', () => {
    expect(countryConflicts('Germany', 'US')).toBe(false);
    expect(countryConflicts(undefined, 'US')).toBe(false);
    expect(countryConflicts('DE', undefined)).toBe(false);
  });
});

describe('GooglePatents · toReadableName', () => {
  it('逗号语序归位 + Title-Case', () => {
    expect(toReadableName('Müller, Hans')).toBe('Hans Müller');
    expect(toReadableName('Schmidt, Anna')).toBe('Anna Schmidt');
  });
  it('自然语序 → Title-Case', () => {
    expect(toReadableName('klaus weber')).toBe('Klaus Weber');
  });
});

describe('GooglePatents · toContactRecord', () => {
  it('发明人 → technical_buyer + personalData + CC BY + 🔴 无 externalIds', () => {
    const rec = toContactRecord('Müller, Hans', 'SIEMENS AG');
    expect(rec.fullName).toBe('Hans Müller');
    expect(rec.title).toBe('Inventor');
    expect(rec.buyingRole).toBe('technical_buyer');
    expect(rec.isTargetRole).toBe(false);
    expect(rec.personalData).toBe(true);
    expect(rec.license).toBe('CC-BY-4.0');
    expect(rec.externalIds).toBeUndefined(); // 🔴 不产 Tier 0 键
  });
});

describe('GooglePatents · currentYear', () => {
  it('注入时钟 → UTC 年', () => {
    expect(currentYear(FIXED_NOW)).toBe(2026);
  });
});

describe('GooglePatents · discoverContacts', () => {
  const company = { name: 'Siemens', domain: 'siemens.com', country: 'DE' };

  it('name 空 → 空（不调 broker）', async () => {
    const broker = fakeBroker({ patents: () => [] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts({ name: '  ' }, CTX);
    expect(res.contacts).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('无 broker → 空（fail-closed，不出网）', async () => {
    const res = await new GooglePatentsInventorProvider({}).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('对齐命中 → 发明人（technical_buyer，无 externalIds）；tool id/purpose/年区间贯穿', async () => {
    const broker = fakeBroker({
      patents: () => [patent([appl('Siemens AG', 'DE')], ['Müller, Hans', 'Schmidt, Anna'])],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller', 'Anna Schmidt']);
    expect(res.contacts.every((c) => c.buyingRole === 'technical_buyer' && c.externalIds === undefined)).toBe(true);
    const [toolId, input, toolCtx] = broker.invokeMock.mock.calls[0] as [string, GooglePatentsInput, ToolContext];
    expect(toolId).toBe('google_patents.search');
    expect(input).toMatchObject({ applicant: 'Siemens', fromYear: 2021, toYear: 2026 });
    expect(toolCtx.purpose).toBe('discovery');
  });

  it('name 变体同一公司（"Acme"/"Acme Inc" 归一同名）→ 去重后对齐、不误弃', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Acme')], ['A B']),
        patent([appl('Acme Inc')], ['C D']), // 归一同为 'acme' → 应视作同一公司，不自相竞争压 margin
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(
      { name: 'Acme', country: 'US' },
      CTX,
    );
    expect(res.contacts.map((c) => c.fullName)).toEqual(['A B', 'C D']);
  });

  it('🔴 低置信对齐（applicant 完全不像 company）→ 弃（返空，绝不挂错公司）', async () => {
    const broker = fakeBroker({ patents: () => [patent([appl('Globex Industries', 'DE')], ['X Y'])] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('🔴 合著专利：co-applicant（Bosch）的发明人不误挂到对齐公司（Siemens）', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Siemens AG', 'DE'), appl('Bosch GmbH', 'DE')], ['Klaus Weber']), // 合著 → 整条弃
        patent([appl('Siemens AG', 'DE')], ['Hans Müller']), // 独家 → 保留
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller']); // Klaus Weber 被排除
  });

  it('🔴 国别冲突（applicant US vs company DE）→ 弃', async () => {
    const broker = fakeBroker({ patents: () => [patent([appl('Siemens AG', 'US')], ['X Y'])] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('🔴 跨境同名防漏并：DE "Acme" 对齐后，US "Acme Inc"（同归一名）的发明人不被并进德国公司', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Acme', 'DE')], ['German Eng']), // DE 独家 → 对齐锚（首个 'acme'）
        patent([appl('Acme Inc', 'US')], ['US Eng']), // US 独家，归一同为 'acme' → 逐专利国别门弃
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(
      { name: 'Acme', country: 'DE' },
      CTX,
    );
    expect(res.contacts.map((c) => c.fullName)).toEqual(['German Eng']); // US Eng 被排除（不跨境误挂）
  });

  it('只留对齐 applicant 的专利（别家 applicant 的发明人被排除）', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Siemens AG', 'DE')], ['Müller, Hans']),
        patent([appl('SomeOther GmbH', 'DE')], ['Wrong Person']), // 非对齐 applicant → 排除
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller']);
  });

  it('跨专利同一人按归一名去重（"Müller, Hans" ≡ "Hans Müller"）', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Siemens AG', 'DE')], ['Müller, Hans', 'Alice Brown']),
        patent([appl('Siemens AG', 'DE')], ['Hans Müller', 'Bob Green']), // Hans 重复
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller', 'Alice Brown', 'Bob Green']); // 3 非 4
  });

  it('每公司上限 25 位（防大公司爆量）', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Inventor Number${i}`);
    const broker = fakeBroker({ patents: () => [patent([appl('Siemens AG', 'DE')], many)] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts).toHaveLength(25);
  });

  it('fail-safe：闸门拒绝（invoke 抛）→ 空、不抛穿', async () => {
    const broker = fakeBroker({ throwErr: true });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('无命中专利 → 空', async () => {
    const broker = fakeBroker({ patents: () => [] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });
});
