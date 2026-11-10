import { describe, expect, it } from 'vitest';
import {
  companyIdentifierSources,
  LEGAL_LINK_MAX_REQUEST_CANDIDATES,
  parseResolveBody,
} from './legal-links.service';

describe('resolve 请求体校验（W2）', () => {
  it('缺省/空对象合法；未知顶层键非法', () => {
    expect(parseResolveBody(undefined)).toEqual({});
    expect(parseResolveBody(null)).toEqual({});
    expect(parseResolveBody({})).toEqual({});
    expect(parseResolveBody({ candidates: [] })).toEqual({ candidates: [] });
    expect(parseResolveBody({ entities: [] })).toBe('invalid');
    expect(parseResolveBody([])).toBe('invalid');
    expect(parseResolveBody('x')).toBe('invalid');
  });

  it('候选 > 20 条拒绝', () => {
    const candidate = { scheme: 'lei', value: '529900T8BM49AURSDO55', country: 'DE', name: 'X GmbH' };
    expect(parseResolveBody({ candidates: Array.from({ length: LEGAL_LINK_MAX_REQUEST_CANDIDATES }, () => candidate) })).not.toBe('invalid');
    expect(
      parseResolveBody({ candidates: Array.from({ length: LEGAL_LINK_MAX_REQUEST_CANDIDATES + 1 }, () => candidate) }),
    ).toBe('invalid');
  });

  it('候选字段：scheme 词表、value 规范式、country、name、status、证据形态', () => {
    const parsed = parseResolveBody({
      candidates: [
        {
          scheme: 'hrb',
          value: 'hrb 12345',
          country: 'de',
          name: 'Müller GmbH',
          status: 'active',
          sourceProvider: 'handelsregister',
          evidenceUrl: 'https://www.handelsregister.de/x',
          evidenceHash: 'a'.repeat(64),
        },
      ],
    });
    expect(parsed).not.toBe('invalid');
    expect((parsed as { candidates: unknown[] }).candidates).toEqual([
      {
        scheme: 'hrb',
        value: 'HRB12345',
        country: 'DE',
        name: 'Müller GmbH',
        address: null,
        status: 'active',
        sourceProvider: 'handelsregister',
        evidenceUrl: 'https://www.handelsregister.de/x',
        evidenceHash: 'a'.repeat(64),
        evidenceJson: null,
      },
    ]);

    const base = { scheme: 'lei', value: '529900T8BM49AURSDO55', country: 'DE', name: 'X' };
    expect(parseResolveBody({ candidates: [{ ...base, scheme: 'hrx' }] })).toBe('invalid');
    expect(parseResolveBody({ candidates: [{ ...base, value: 'short' }] })).toBe('invalid');
    expect(parseResolveBody({ candidates: [{ ...base, country: 'DEU' }] })).toBe('invalid');
    expect(parseResolveBody({ candidates: [{ ...base, name: '   ' }] })).toBe('invalid');
    expect(parseResolveBody({ candidates: [{ ...base, status: 'gone' }] })).toBe('invalid');
    expect(parseResolveBody({ candidates: [{ ...base, evidenceUrl: 'http://insecure.example' }] })).toBe('invalid');
    expect(parseResolveBody({ candidates: [{ ...base, evidenceHash: 'NOT-HEX' }] })).toBe('invalid');
    expect(parseResolveBody({ candidates: [{ ...base, evidenceJson: [1, 2] }] })).toBe('invalid');
  });
});

describe('公司自带确定性键提取（W2）', () => {
  it('GLEIF：lei/legal_name/registered_country/entity_status 全套 → 自实体登记输入', () => {
    const sources = companyIdentifierSources({
      id: 'c1',
      name: 'Siemens AG',
      country: null,
      attributes: {
        gleif: {
          lei: '529900t8bm49aursdo55',
          legal_name: 'Siemens Aktiengesellschaft',
          registered_country: 'DE',
          entity_status: 'ACTIVE',
        },
      },
    });
    expect(sources.legalName).toBe('Siemens Aktiengesellschaft');
    expect(sources.country).toBe('DE');
    expect(sources.identifiers).toEqual([
      {
        scheme: 'lei',
        value: '529900T8BM49AURSDO55',
        country: 'DE',
        name: 'Siemens Aktiengesellschaft',
        status: 'active',
        sourceProvider: 'gleif',
        evidenceUrl: 'https://search.gleif.org/#/record/529900T8BM49AURSDO55',
      },
    ]);
  });

  it('Wikidata LEI 兜底（无 GLEIF 时），来源标注 wikidata', () => {
    const sources = companyIdentifierSources({
      id: 'c1',
      name: 'Beispiel GmbH',
      country: 'at',
      attributes: { wikidata: { lei: '529900T8BM49AURSDO55' } },
    });
    expect(sources.identifiers).toHaveLength(1);
    expect(sources.identifiers[0]).toMatchObject({ scheme: 'lei', sourceProvider: 'wikidata', country: 'AT' });
  });

  it('官网 VAT（Impressum）→ vat 标识；无 GLEIF 时 legalName 为空', () => {
    const sources = companyIdentifierSources({
      id: 'c1',
      name: 'Müller GmbH',
      country: 'DE',
      attributes: { website_profile: { vat_id: 'DE291499156' } },
    });
    expect(sources.legalName).toBeNull();
    expect(sources.identifiers).toEqual([
      {
        scheme: 'vat',
        value: 'DE291499156',
        country: 'DE',
        name: 'Müller GmbH',
        status: 'unknown',
        sourceProvider: 'website_profile',
        evidenceUrl: null,
      },
    ]);
  });

  it('非法属性值忽略；attributes 缺失不炸', () => {
    expect(companyIdentifierSources({ id: 'c1', name: 'X', country: null, attributes: null }).identifiers).toEqual([]);
    expect(
      companyIdentifierSources({
        id: 'c1',
        name: 'X',
        country: 'DE',
        attributes: { gleif: { lei: 'not-a-lei' }, website_profile: { vat_id: '1234' } },
      }).identifiers,
    ).toEqual([]);
  });

  it('GLEIF registration_status MERGED → dissolved', () => {
    const sources = companyIdentifierSources({
      id: 'c1',
      name: 'Alt GmbH',
      country: 'DE',
      attributes: { gleif: { lei: '529900T8BM49AURSDO55', registration_status: 'MERGED' } },
    });
    expect(sources.identifiers[0]!.status).toBe('dissolved');
  });
});
