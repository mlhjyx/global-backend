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
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts({ name: '  ' }, CTX);
    expect(res.contacts).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('无 broker → 空（fail-closed，不出网）', async () => {
    const res = await new GooglePatentsInventorProvider({ mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('对齐命中 → 发明人（technical_buyer，无 externalIds）；tool id/purpose/年区间贯穿', async () => {
    const broker = fakeBroker({
      patents: () => [patent([appl('Siemens AG', 'DE')], ['Müller, Hans', 'Schmidt, Anna'])],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
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
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(
      { name: 'Acme', country: 'US' },
      CTX,
    );
    expect(res.contacts.map((c) => c.fullName)).toEqual(['A B', 'C D']);
  });

  it('🔴 低置信对齐（applicant 完全不像 company）→ 弃（返空，绝不挂错公司）', async () => {
    const broker = fakeBroker({ patents: () => [patent([appl('Globex Industries', 'DE')], ['X Y'])] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('🔴 合著专利：co-applicant（Bosch）的发明人不误挂到对齐公司（Siemens）', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Siemens AG', 'DE'), appl('Bosch GmbH', 'DE')], ['Klaus Weber']), // 合著 → 整条弃
        patent([appl('Siemens AG', 'DE')], ['Hans Müller']), // 独家 → 保留
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller']); // Klaus Weber 被排除
  });

  it('🔴 国别冲突（applicant US vs company DE）→ 弃', async () => {
    const broker = fakeBroker({ patents: () => [patent([appl('Siemens AG', 'US')], ['X Y'])] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('🔴 跨境同名防漏并：DE "Acme" 对齐后，US "Acme Inc"（同归一名）的发明人不被并进德国公司', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Acme', 'DE')], ['German Eng']), // DE 独家 → 对齐锚（首个 'acme'）
        patent([appl('Acme Inc', 'US')], ['US Eng']), // US 独家，归一同为 'acme' → 逐专利国别门弃
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(
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
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller']);
  });

  it('跨专利同一人按归一名去重（"Müller, Hans" ≡ "Hans Müller"）', async () => {
    const broker = fakeBroker({
      patents: () => [
        patent([appl('Siemens AG', 'DE')], ['Müller, Hans', 'Alice Brown']),
        patent([appl('Siemens AG', 'DE')], ['Hans Müller', 'Bob Green']), // Hans 重复
      ],
    });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller', 'Alice Brown', 'Bob Green']); // 3 非 4
  });

  it('每公司上限 25 位（防大公司爆量）', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Inventor Number${i}`);
    const broker = fakeBroker({ patents: () => [patent([appl('Siemens AG', 'DE')], many)] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts).toHaveLength(25);
  });

  it('fail-safe：闸门拒绝（invoke 抛）→ 空、不抛穿', async () => {
    const broker = fakeBroker({ throwErr: true });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('无命中专利 → 空', async () => {
    const broker = fakeBroker({ patents: () => [] });
    const res = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });
});

describe('GooglePatents · 模式切换（cache/direct/off）', () => {
  const company = { name: 'Siemens', domain: 'siemens.com', country: 'DE' };
  const fixture = (): PatentRecord[] => [patent([appl('Siemens AG', 'DE')], ['Müller, Hans', 'Schmidt, Anna'])];

  it('off（默认，无 mode 且无 env）→ 空，绝不出网/读缓存', async () => {
    const broker = fakeBroker({ patents: fixture });
    const cacheReader = vi.fn(async () => fixture());
    const res = await new GooglePatentsInventorProvider({ broker, cacheReader, now: FIXED_NOW }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
    expect(cacheReader).not.toHaveBeenCalled();
  });

  it('cache 命中 → 读缓存产联系人，绝不经 broker（零 egress）', async () => {
    const broker = fakeBroker({ patents: () => [] });
    const cacheReader = vi.fn(async (name: string, opts: { fromYear: number; toYear: number }) => {
      expect(name).toBe('Siemens');
      expect(opts).toMatchObject({ fromYear: 2021, toYear: 2026 });
      return fixture();
    });
    const enqueue = vi.fn(async () => {});
    const res = await new GooglePatentsInventorProvider({ broker, cacheReader, enqueue, now: FIXED_NOW, mode: 'cache' }).discoverContacts(company, CTX);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Hans Müller', 'Anna Schmidt']);
    expect(broker.invokeMock).not.toHaveBeenCalled(); // 缓存路径不经 broker
    expect(enqueue).not.toHaveBeenCalled(); // 命中不 enqueue
  });

  it('cache miss → enqueue 预热（best-effort），本次返空', async () => {
    const cacheReader = vi.fn(async () => [] as PatentRecord[]);
    const enqueue = vi.fn(async () => {});
    const res = await new GooglePatentsInventorProvider({ cacheReader, enqueue, now: FIXED_NOW, mode: 'cache' }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
    expect(enqueue).toHaveBeenCalledWith('Siemens', 'DE');
  });

  it('cache 模式无 cacheReader → 降级空（不抛）', async () => {
    const res = await new GooglePatentsInventorProvider({ now: FIXED_NOW, mode: 'cache' }).discoverContacts(company, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('🔴 多国同名（缓存路径）：首见他国组不误弃整源——step1 偏好本公司国别代表，本国发明人仍产出', async () => {
    // 缓存 readPatentCache 按 (norm,country) 双键分组 → 一家跨国公司出多组同 norm。若 step1 首见即定且恰为他国，
    // step2 的 country 门会误弃整源。修复：step1 偏好与本公司国别不冲突的代表；step3 仍逐记录国别门（护栏③不放松）。
    const cacheReader = async (): Promise<PatentRecord[]> => [
      patent([appl('Siemens Inc', 'US')], ['Foreign Person']), // 首见 US 组（norm 'siemens'）
      patent([appl('Siemens AG', 'DE')], ['Home Person']), // 后见 DE 组（同 norm）
    ];
    const res = await new GooglePatentsInventorProvider({ cacheReader, now: FIXED_NOW, mode: 'cache' }).discoverContacts(
      { name: 'Siemens', country: 'DE' },
      CTX,
    );
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Home Person']); // Foreign Person 逐记录国别门排除；不因首见 US 整源弃
  });

  it('🔴 cache 路径 ≡ direct 路径产同一 contacts（同一专利 fixture）', async () => {
    const broker = fakeBroker({ patents: fixture });
    const direct = await new GooglePatentsInventorProvider({ broker, now: FIXED_NOW, mode: 'direct' }).discoverContacts(company, CTX);
    const cacheReader = async () => fixture();
    const cached = await new GooglePatentsInventorProvider({ cacheReader, now: FIXED_NOW, mode: 'cache' }).discoverContacts(company, CTX);
    expect(cached.contacts.map((c) => c.fullName)).toEqual(direct.contacts.map((c) => c.fullName));
    expect(cached.contacts.map((c) => c.buyingRole)).toEqual(direct.contacts.map((c) => c.buyingRole));
  });
});
