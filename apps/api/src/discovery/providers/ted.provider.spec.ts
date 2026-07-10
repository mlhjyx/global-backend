import { describe, expect, it, vi } from 'vitest';
import { TedDiscoveryProvider, mapNoticeToRecords, toAlpha2 } from './ted.provider';
import { TedAwardNotice } from '../../adapters/ted-api';
import { companyIdentity } from '../identity';
import { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import type { TedSearchOutput } from '../../tools/source-tools';

const NOW = '2026-07-08T00:00:00.000Z';
const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1' };

/** 假 Broker：记录 invoke 调用；impl 抛错=闸门拒绝/工具失败。 */
function fakeBroker(impl: () => Promise<TedSearchOutput>): ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(async (_toolId: string, _input: unknown, _ctx: ToolContext): Promise<ToolResult<unknown>> => {
    return { data: await impl(), costCents: 0 };
  });
  return {
    invokeMock,
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: invokeMock as ExecutionBroker['invoke'],
  };
}

function notice(overrides: Partial<TedAwardNotice> = {}): TedAwardNotice {
  return {
    publicationNumber: '123456-2026',
    publicationDate: '2026-07-08+02:00',
    noticeType: 'can-standard',
    formType: 'result',
    cpvCodes: ['42120000'],
    buyerNames: ['City of Munich'],
    buyerCountries: ['DEU'],
    winners: [],
    ...overrides,
  };
}

function q(filters: Record<string, unknown>): CompanyDiscoveryQuery {
  return { sourceClass: 'public_intelligence', filters, keywords: [], limit: 25 };
}

describe('TED 中标方 → ProviderCompanyRecord（mapNoticeToRecords）', () => {
  it('单中标方带官网 → 域名可解析 + ted 命名空间事实 + 署名', () => {
    const recs = mapNoticeToRecords(
      notice({ winners: [{ name: 'Acme Pumps Ltd', country: 'DEU', identifier: 'DE111', internetAddress: 'https://acme-pumps.example' }] }),
      NOW,
    );
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.name).toBe('Acme Pumps Ltd');
    expect(r.domain).toBe('acme-pumps.example');
    expect(r.country).toBe('DE'); // §8.3：ISO-3 DEU → alpha-2 DE
    const ted = r.attributes?.ted as Record<string, unknown>;
    expect(ted.publication_number).toBe('123456-2026');
    expect(ted.cpv).toEqual(['42120000']);
    expect(ted.winner_identifier).toBe('DE111');
    expect(ted.license).toBe('CC-BY-4.0');
    expect(String(ted.attribution)).toMatch(/European Union/i);
    expect(r.provenance?.parserVersion).toBe('ted/v1');
    // §8.5 top-level 记录许可（写入 field_evidence.license）+ §8.4 provider 标识（税号）
    expect(r.license).toBe('CC BY 4.0');
    expect(r.identifier).toEqual({ scheme: 'ted-natid:de', value: 'DE111' }); // §8.4 scheme 国别限定（DEU→de）
  });

  it('🔴 合规：绿事实记录里绝不含具名邮箱/个人联系点', () => {
    const recs = mapNoticeToRecords(
      notice({ winners: [{ name: 'Acme Pumps Ltd', country: 'DEU', identifier: 'DE111' }] }),
      NOW,
    );
    const serialized = JSON.stringify(recs);
    expect(serialized).not.toMatch(/email/i);
    expect(serialized).not.toContain('@');
  });

  it('多中标方无官网 → 走 name+country（domain 不臆造，绝不贴错身份）', () => {
    const recs = mapNoticeToRecords(
      notice({ winners: [
        { name: 'Alpha AG', country: 'DEU' },
        { name: 'Beta SA', country: 'FRA' },
      ] }),
      NOW,
    );
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.domain === undefined)).toBe(true);
    expect(recs.map((r) => r.externalId)).toEqual(['ted:123456-2026:0', 'ted:123456-2026:1']);
  });

  it('中标方无 identifier → winner_identifier 字段被裁剪（不落空值）', () => {
    const recs = mapNoticeToRecords(notice({ winners: [{ name: 'Gamma GmbH', country: 'DEU' }] }), NOW);
    const ted = recs[0].attributes?.ted as Record<string, unknown>;
    expect('winner_identifier' in ted).toBe(false);
    expect(recs[0].identifier).toBeUndefined(); // §8.4 无标识 → 不设 top-level identifier
  });

  it('§8.4 identifier scheme 按国别限定 → 不同国同号的不同法人不跨境误并（审查修正）', () => {
    const de = mapNoticeToRecords(notice({ winners: [{ name: 'Müller Bau GmbH', country: 'DEU', identifier: '12345678' }] }), NOW);
    const pt = mapNoticeToRecords(notice({ winners: [{ name: 'Silva Lda', country: 'PRT', identifier: '12345678' }] }), NOW);
    expect(de[0].identifier).toEqual({ scheme: 'ted-natid:de', value: '12345678' });
    expect(pt[0].identifier).toEqual({ scheme: 'ted-natid:pt', value: '12345678' });
    const kDe = companyIdentity({ name: de[0].name, country: de[0].country, identifier: de[0].identifier }).dedupeKey;
    const kPt = companyIdentity({ name: pt[0].name, country: pt[0].country, identifier: pt[0].identifier }).dedupeKey;
    expect(kDe).not.toBe(kPt); // 跨境同号 → 不同 dedupeKey（绝不贴错身份）
  });

  it('空名中标方被过滤', () => {
    const recs = mapNoticeToRecords(notice({ winners: [{ name: '  ' }, { name: 'Real Co' }] }), NOW);
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe('Real Co');
  });

  it('§8.3 国别 ISO-3 → alpha-2（canonical 一致，防跨源 dedupe 裂键）', () => {
    const recs = mapNoticeToRecords(notice({ winners: [{ name: 'Acme AG', country: 'DEU' }] }), NOW);
    expect(recs[0].country).toBe('DE');
  });
});

describe('§8.3 toAlpha2 国别归一', () => {
  it('TED 覆盖集 ISO-3 → alpha-2', () => {
    expect(toAlpha2('DEU')).toBe('DE');
    expect(toAlpha2('FRA')).toBe('FR');
    expect(toAlpha2('GBR')).toBe('GB');
  });
  it('未收录码保留原值（best-effort，不静默出错）', () => {
    expect(toAlpha2('ZZZ')).toBe('ZZZ');
  });
  it('空值透传', () => {
    expect(toAlpha2(undefined)).toBeUndefined();
  });
});

describe('§8.8 合规门（收口②：Broker 单点 fail-closed，provider 不再自建镜像）', () => {
  const gq = q({ cpv: '42120000', buyer_country: 'DEU' });

  it('Broker 拒绝（SUSPENDED/未登记/用途门 → invoke 抛错）→ fail-safe 空结果', async () => {
    const broker = fakeBroker(async () => {
      throw new Error('tool ted.search denied: source_policy unregistered: api.ted.europa.eu');
    });
    const p = new TedDiscoveryProvider({ broker });
    expect(await p.discoverCompanies(gq, CTX)).toEqual({ records: [], costCents: 0 });
    expect(broker.invokeMock).toHaveBeenCalledOnce(); // 拒绝发生在 Broker 内（单点），provider 只管 fail-safe
  });

  it('无 broker → fail-closed：空且零出网（旧「无 reader fail-open」缺陷已反转）', async () => {
    const p = new TedDiscoveryProvider();
    expect(await p.discoverCompanies(gq, CTX)).toEqual({ records: [], costCents: 0 });
  });

  it('Broker 放行 → 经 ted.search 工具发请求并映射，透传真 workspace/run 归属', async () => {
    const broker = fakeBroker(async () => ({
      awards: [notice({ winners: [{ name: 'Acme AG', country: 'DEU', identifier: 'DE1' }] })],
    }));
    const p = new TedDiscoveryProvider({ broker });
    const res = await p.discoverCompanies(gq, CTX);
    expect(broker.invokeMock).toHaveBeenCalledOnce();
    const [toolId, input, toolCtx] = broker.invokeMock.mock.calls[0] as [string, { kind: string }, ToolContext];
    expect(toolId).toBe('ted.search');
    expect(input.kind).toBe('award');
    expect(toolCtx).toMatchObject({ workspaceId: 'ws-1', runId: 'run-1' });
    expect(res.records).toHaveLength(1);
    expect(res.records[0].name).toBe('Acme AG');
  });
});

describe('TedDiscoveryProvider 契约', () => {
  it('key=ted，class=public_intelligence（复用类，无需新 SourceClass）', () => {
    const p = new TedDiscoveryProvider();
    expect(p.key).toBe('ted');
    expect(p.classes).toEqual(['public_intelligence']);
  });

  it('无 CPV 过滤 → 直接返回空（fail-safe，不发网络请求、不裸拉全库）', async () => {
    const broker = fakeBroker(async () => ({ awards: [] }));
    const p = new TedDiscoveryProvider({ broker });
    const res = await p.discoverCompanies(q({}), CTX);
    expect(res).toEqual({ records: [], costCents: 0 });
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });
});
