import { describe, expect, it, vi } from 'vitest';
import {
  InpiRneContactProvider,
  isFrCompany,
  classifyRole,
  toReadableName,
  toContactRecord,
} from './inpi-rne.provider';
import type { FrCompanyHit, FrDirigeant } from '../../adapters/inpi-rne';
import type { InpiRneInput, InpiRneOutput } from '../../tools/source-tools';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import { ExecutionContext } from '../provider-contract';

const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1' };

/** 假 Broker：search 返回法国公司；抛错 = 闸门拒绝/工具失败。 */
function fakeBroker(handlers: {
  search?: () => FrCompanyHit[];
  throwOn?: boolean;
}): ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(async (_toolId: string, _input: InpiRneInput): Promise<ToolResult<InpiRneOutput>> => {
    if (handlers.throwOn) throw new Error('gate denied');
    return { data: { companies: handlers.search?.() ?? [] }, costCents: 0 };
  });
  return {
    invokeMock,
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: invokeMock as unknown as ExecutionBroker['invoke'],
  };
}

const dir = (nom: string, prenoms: string | undefined, qualite: string): FrDirigeant => ({ nom, prenoms, qualite });
const hit = (siren: string, name: string, dirigeants: FrDirigeant[], etatAdministratif = 'A'): FrCompanyHit => ({
  siren,
  name,
  etatAdministratif,
  dirigeants,
});

describe('inpi_rne · isFrCompany（FR 门）', () => {
  it('法国国别归一集命中', () => {
    for (const c of ['FR', 'fra', 'France', 'République française']) expect(isFrCompany(c)).toBe(true);
  });
  it('国别缺失时 .fr 域名作弱兜底 → true', () => {
    expect(isFrCompany(undefined, 'acme.fr')).toBe(true);
    expect(isFrCompany('', 'acme.fr')).toBe(true);
  });
  it('🔴 country 优先：显式非法辖区（.fr 域名）一律 false', () => {
    expect(isFrCompany('DE', 'kaeser.fr')).toBe(false);
    expect(isFrCompany('BE', 'foo.fr')).toBe(false);
    expect(isFrCompany('FR', undefined)).toBe(true);
  });
  it('非法国公司 → false；两者皆空 → false', () => {
    expect(isFrCompany('DE', 'foo.de')).toBe(false);
    expect(isFrCompany(undefined, undefined)).toBe(false);
  });
});

describe('inpi_rne · classifyRole', () => {
  it('执行位（含阴性 Directrice/Administratrice）→ economic_buyer / executive', () => {
    for (const q of [
      'Gérant', 'Gérante', 'Président de SAS', 'Présidente', 'Directeur Général', 'Directrice Générale',
      'Administrateur', 'Administratrice', 'Président du directoire',
    ]) {
      expect(classifyRole(q)).toEqual({ buyingRole: 'economic_buyer', seniority: 'executive' });
    }
  });
  it('其它 personne physique dirigeant → decision_maker（泛，不夸大）', () => {
    expect(classifyRole('Associé')).toEqual({ buyingRole: 'decision_maker' });
  });
});

describe('inpi_rne · toReadableName / toContactRecord', () => {
  it('prénoms + nom → 词首大写', () => {
    expect(toReadableName(dir('ANDRIÈS', 'OLIVIER', 'Directeur Général'))).toBe('Olivier Andriès');
    expect(toReadableName(dir('DUPONT', undefined, 'Gérant'))).toBe('Dupont');
  });
  it('dirigeant → personalData + Licence Ouverte + buyingRole + 🔴 无 externalIds（name-merge）', () => {
    const rec = toContactRecord(dir('ANDRIÈS', 'OLIVIER', 'Directeur Général'), hit('562082909', 'SAFRAN', []));
    expect(rec.fullName).toBe('Olivier Andriès');
    expect(rec.title).toBe('Directeur Général');
    expect(rec.buyingRole).toBe('economic_buyer');
    expect(rec.seniority).toBe('executive');
    expect(rec.personalData).toBe(true);
    expect(rec.license).toBe('Licence-Ouverte-2.0');
    expect(rec.externalIds).toBeUndefined(); // 🔴 无 person id → name-merge，不产 Tier 0 键
    expect(rec.sourcePage).toContain('/entreprise/562082909');
  });
});

describe('inpi_rne · discoverContacts', () => {
  const frCompany = { name: 'SAFRAN', domain: 'safran-group.com', country: 'FR' };

  it('🔴 FR 门：非法国公司 → 空（不搜、不调 broker）', async () => {
    const broker = fakeBroker({ search: () => [hit('1', 'SAFRAN', [dir('X', 'Y', 'Gérant')])] });
    const res = await new InpiRneContactProvider({ broker }).discoverContacts(
      { name: 'KAESER', domain: 'kaeser.de', country: 'DE' },
      CTX,
    );
    expect(res.contacts).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('无 broker → 空（fail-closed，不出网）', async () => {
    const res = await new InpiRneContactProvider({}).discoverContacts(frCompany, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('公司对齐命中（高置信）+ 只留 active → dirigeants → ProviderContactRecord', async () => {
    const broker = fakeBroker({
      search: () => [
        hit('562082909', 'SAFRAN', [dir('ANDRIÈS', 'OLIVIER', 'Directeur Général'), dir('AUBERT', 'ANNE', 'Administrateur')]),
        hit('99', 'SAFRAN ELECTRONICS', [], 'C'), // ceased —— 被剔除
      ],
    });
    const res = await new InpiRneContactProvider({ broker }).discoverContacts(frCompany, CTX);
    expect(res.contacts).toHaveLength(2);
    expect(res.contacts.map((c) => c.fullName)).toEqual(['Olivier Andriès', 'Anne Aubert']);
    expect(res.contacts.every((c) => c.personalData && c.license === 'Licence-Ouverte-2.0')).toBe(true);
    // 🔴 §8.8 用途门绑定：必须走 required 工具 inpi_rne.search（policyDomain=recherche-entreprises.api.gouv.fr）
    //    且以公司名（非域名）为查询、purpose='discovery' 贯穿——否则用途门/对齐会错。
    expect(broker.invokeMock.mock.calls[0][0]).toBe('inpi_rne.search');
    expect(broker.invokeMock.mock.calls[0][1]).toEqual({ op: 'search', query: 'SAFRAN', limit: 10 });
    const searchCtx = broker.invokeMock.mock.calls[0][2] as ToolContext;
    expect(searchCtx.purpose).toBe('discovery');
  });

  it('归一名去重：同公司同名 dirigeant 只采一条（cap 前去重）', async () => {
    const broker = fakeBroker({
      search: () => [hit('1', 'ACME', [dir('MARTIN', 'JEAN', 'Gérant'), dir('MARTIN', 'JEAN', 'Président')])],
    });
    const res = await new InpiRneContactProvider({ broker }).discoverContacts(
      { name: 'ACME', domain: 'acme.fr', country: 'FR' },
      CTX,
    );
    expect(res.contacts).toHaveLength(1); // 同名归一去重（name-merge 内在语义）
  });

  it('🔴 歧义/低 margin 公司对齐 → 弃（返空，绝不挂错公司）', async () => {
    const broker = fakeBroker({ search: () => [hit('1', 'Acme', [dir('X', 'Y', 'Gérant')]), hit('2', 'Acme', [dir('Z', 'W', 'Gérant')])] });
    const res = await new InpiRneContactProvider({ broker }).discoverContacts(
      { name: 'Acme', domain: 'acme.fr', country: 'FR' },
      CTX,
    );
    expect(res.contacts).toEqual([]);
  });

  it('🔴 低名分（<0.9）单候选：margin 过门但 score 不过 → 弃（score 门独立守，绝不挂错公司）', async () => {
    // 单候选 → margin=score；'WILO FRANCE' vs 'WILO IMMOBILIER' token Jaccard≈0.33：过 margin 门(≥0.1)、被 score 门(≥0.9)拦。
    // 若 score 门被松动/删除，这家不相干公司的 dirigeant 会被误挂 → 正是红线禁止的错挂。
    const broker = fakeBroker({ search: () => [hit('1', 'WILO IMMOBILIER', [dir('DUBOIS', 'PAUL', 'Gérant')])] });
    const res = await new InpiRneContactProvider({ broker }).discoverContacts(
      { name: 'WILO FRANCE', domain: 'wilo.fr', country: 'FR' },
      CTX,
    );
    expect(res.contacts).toEqual([]);
  });

  it('只留 active：命中的是 cessée → 无 active 候选 → 空', async () => {
    const broker = fakeBroker({ search: () => [hit('1', 'SAFRAN', [dir('X', 'Y', 'Gérant')], 'C')] });
    const res = await new InpiRneContactProvider({ broker }).discoverContacts(frCompany, CTX);
    expect(res.contacts).toEqual([]);
  });

  it('fail-safe：闸门拒绝（invoke 抛）→ 空、不抛穿', async () => {
    const broker = fakeBroker({ throwOn: true });
    const res = await new InpiRneContactProvider({ broker }).discoverContacts(frCompany, CTX);
    expect(res.contacts).toEqual([]);
  });
});
