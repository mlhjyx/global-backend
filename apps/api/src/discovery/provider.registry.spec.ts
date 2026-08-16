import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ModelGateway } from '../model-gateway/model-gateway';
import { DiscoveryProviderRegistry } from './provider.registry';

describe('DiscoveryProviderRegistry SourceClass governance', () => {
  it('binds both structured/sandbox and gateway-backed adapters to the manifest', () => {
    expect(() => new DiscoveryProviderRegistry()).not.toThrow();
    expect(
      () =>
        new DiscoveryProviderRegistry({
          gateway: {} as ModelGateway,
        }),
    ).not.toThrow();
  });

  it('资格门前路由身份事实与官网证据，但不放大招聘收割', async () => {
    const registry = new DiscoveryProviderRegistry();
    const db = {
      dataProvider: {
        findMany: async () => [
          { key: 'wikidata' },
          { key: 'gleif' },
          { key: 'sec_edgar' },
          { key: 'digital_footprint' },
          { key: 'structured_harvest' },
        ],
      },
    } as never;

    await expect(registry.routeFitEvidenceEnrichment(db)).resolves.toEqual([
      expect.objectContaining({ key: 'wikidata' }),
      expect.objectContaining({ key: 'gleif' }),
      expect.objectContaining({ key: 'sec_edgar' }),
      expect.objectContaining({ key: 'digital_footprint' }),
    ]);
    await expect(registry.routeEnrichment(db)).resolves.toEqual([
      expect.objectContaining({ key: 'wikidata' }),
      expect.objectContaining({ key: 'gleif' }),
    ]);
  });

  it('enables USAspending for new environments with a historical-award source policy', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    const registry = new DiscoveryProviderRegistry();
    await registry.seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);

    const providerCreates = providerUpsert.mock.calls.map(([input]) => input.create);
    expect(providerCreates).toContainEqual(expect.objectContaining({
      key: 'usaspending_awards', status: 'ENABLED', class: 'public_intelligence',
    }));
    const policyCreates = policyUpsert.mock.calls.map(([input]) => input.create);
    expect(policyCreates).toContainEqual(expect.objectContaining({
      domain: 'api.usaspending.gov',
      sourceType: 'gov_award',
      personalData: true,
      allowedPurpose: ['discovery'],
    }));
    const usaPolicyCall = policyUpsert.mock.calls.map(([input]) => input).find((input) => input.where.domain === 'api.usaspending.gov');
    expect(usaPolicyCall?.update).toEqual(expect.objectContaining({
      sourceType: 'gov_award', personalData: true,
    }));
    expect(providerCreates).toContainEqual(expect.objectContaining({ key: 'singapore_gebiz', status: 'DISABLED' }));
    const gebizPolicyCall = policyUpsert.mock.calls.map(([input]) => input).find((input) => input.where.domain === 'data.gov.sg');
    expect(gebizPolicyCall?.update).toEqual(expect.objectContaining({
      sourceType: 'gov_award', personalData: true,
    }));
  });

  it('enables Contracts Finder for new environments without overwriting an existing status', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    const registry = new DiscoveryProviderRegistry();
    await registry.seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);

    const contractsFinderCall = providerUpsert.mock.calls
      .map(([input]) => input)
      .find((input) => input.where.key === 'uk_contracts_finder');

    expect(contractsFinderCall?.create).toEqual(expect.objectContaining({
      key: 'uk_contracts_finder',
      status: 'ENABLED',
      class: 'public_intelligence',
    }));
    expect(contractsFinderCall?.update).toEqual({});

    const contractsFinderPolicy = policyUpsert.mock.calls
      .map(([input]) => input)
      .find((input) => input.where.domain === 'www.contractsfinder.service.gov.uk');
    expect(contractsFinderPolicy?.create).toEqual(expect.objectContaining({
      sourceType: 'gov_opportunity',
      notes: expect.stringMatching(/低额采购买方/u),
    }));
    expect(contractsFinderPolicy?.create.notes).not.toContain('默认关闭');
    expect(contractsFinderPolicy?.update).toEqual(expect.objectContaining({
      sourceType: 'gov_opportunity',
      personalData: true,
      notes: expect.stringMatching(/低额采购买方/u),
    }));
  });

  it('keeps PNCP disabled and documents the validated CNPJ authority gate', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    const registry = new DiscoveryProviderRegistry();
    await registry.seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);

    const pncpProvider = providerUpsert.mock.calls
      .map(([input]) => input)
      .find((input) => input.where.key === 'brazil_pncp');
    expect(pncpProvider?.create).toEqual(expect.objectContaining({ status: 'DISABLED' }));
    expect(pncpProvider?.update).toEqual({ status: 'DISABLED' });

    const pncpPolicy = policyUpsert.mock.calls
      .map(([input]) => input)
      .find((input) => input.where.domain === 'pncp.gov.br');
    expect(pncpPolicy?.create.notes).toMatch(/纯数字 14 位.*校验位正确.*numeroControlePNCP 前缀完全一致/u);
    expect(pncpPolicy?.create.notes).toMatch(/Provider 保持 DISABLED/u);
    expect(pncpPolicy?.update.notes).toBe(pncpPolicy?.create.notes);
  });

  it('keeps ROR disabled behind explicit organization scope and a company-only SourcePolicy', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);
    const provider = providerUpsert.mock.calls.map(([input]) => input).find((input) => input.where.key === 'ror');
    expect(provider?.create).toEqual(expect.objectContaining({ class: 'company_registry', status: 'DISABLED' }));
    expect(provider?.update).toEqual({ status: 'DISABLED' });
    const policy = policyUpsert.mock.calls.map(([input]) => input).find((input) => input.where.domain === 'api.ror.org');
    expect(policy?.create).toEqual(expect.objectContaining({
      sourceType: 'company_registry', personalData: false, allowedPurpose: ['discovery'],
      notes: expect.stringMatching(/source_hint=ror.*checksum.*DISABLED/u),
    }));
    expect(policy?.update).toEqual(expect.objectContaining({ personalData: false, allowedPurpose: ['discovery'] }));
  });

  it('keeps FMCSA disabled behind an authenticated organization-only SourcePolicy', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);
    const provider = providerUpsert.mock.calls.map(([input]) => input).find((input) => input.where.key === 'fmcsa_qcmobile');
    expect(provider?.create).toEqual(expect.objectContaining({ class: 'company_registry', status: 'DISABLED' }));
    expect(provider?.update).toEqual({ status: 'DISABLED' });
    const policy = policyUpsert.mock.calls.map(([input]) => input).find((input) => input.where.domain === 'mobile.fmcsa.dot.gov');
    expect(policy?.create).toEqual(expect.objectContaining({
      sourceType: 'company_registry', personalData: true, allowedPurpose: ['discovery'],
      reviewStatus: 'SUSPENDED', termsStatus: 'UNREVIEWED',
      allowedPaths: ['/qc/services/carriers/name/'],
      notes: expect.stringMatching(/source_hint=fmcsa_qcmobile.*结构性删除.*WebKey.*DISABLED/u),
    }));
    expect(policy?.update).toEqual(expect.objectContaining({
      personalData: true, allowedPurpose: ['discovery'], reviewStatus: 'SUSPENDED', termsStatus: 'UNREVIEWED',
    }));
  });

  it('seeds paid public_web search backends suspended until terms and real-key acceptance are complete', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);

    for (const domain of ['google.serper.dev', 'api.search.brave.com']) {
      const policy = policyUpsert.mock.calls.map(([input]) => input)
        .find((input) => input.where.domain === domain);
      expect(policy?.create).toEqual(expect.objectContaining({
        sourceType: 'search_index',
        accessMode: 'api',
        reviewStatus: 'SUSPENDED',
        termsStatus: 'UNREVIEWED',
        personalData: false,
        allowedPurpose: ['discovery'],
      }));
      expect(policy?.update).toEqual({});
    }
  });

  it('keeps EU Ecolabel disabled behind an exact organization-only SourcePolicy', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);
    const provider = providerUpsert.mock.calls.map(([input]) => input).find((input) => input.where.key === 'eu_ecolabel');
    expect(provider?.create).toEqual(expect.objectContaining({ class: 'public_intelligence', status: 'DISABLED' }));
    expect(provider?.update).toEqual({ status: 'DISABLED' });
    const policy = policyUpsert.mock.calls.map(([input]) => input)
      .find((input) => input.where.domain === 'apps.data.env.service.ec.europa.eu');
    expect(policy?.create).toEqual(expect.objectContaining({
      sourceType: 'certification', personalData: true, allowedPurpose: ['discovery'], reviewStatus: 'APPROVED',
      termsStatus: 'REVIEWED_OK', allowedPaths: ['/dataquery/v2/ecolabel/products'],
      notes: expect.stringMatching(/source_hint=eu_ecolabel.*结构性删除.*不提升为企业身份.*DISABLED/u),
    }));
    expect(policy?.update).toEqual(expect.objectContaining({
      personalData: true, allowedPurpose: ['discovery'], reviewStatus: 'APPROVED', termsStatus: 'REVIEWED_OK',
    }));
  });

  it('keeps SBIR/STTR disabled and suspended while the official API is under maintenance', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);
    const provider = providerUpsert.mock.calls.map(([input]) => input)
      .find((input) => input.where.key === 'sbir_sttr_companies');
    expect(provider?.create).toEqual(expect.objectContaining({ class: 'public_intelligence', status: 'DISABLED' }));
    expect(provider?.update).toEqual({ status: 'DISABLED' });
    const policy = policyUpsert.mock.calls.map(([input]) => input)
      .find((input) => input.where.domain === 'api.www.sbir.gov');
    expect(policy?.create).toEqual(expect.objectContaining({
      sourceType: 'gov_award', personalData: true, allowedPurpose: ['discovery'], reviewStatus: 'SUSPENDED',
      termsStatus: 'UNREVIEWED', allowedPaths: ['/public/api/firm'],
      notes: expect.stringMatching(/source_hint=sbir_sttr_companies.*维护中.*SUSPENDED.*DISABLED/u),
    }));
  });

  it('keeps the KONEPS buyer subset disabled until a key and persistent acceptance exist', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);
    const provider = providerUpsert.mock.calls.map(([input]) => input).find((input) => input.where.key === 'koneps');
    expect(provider?.create).toEqual(expect.objectContaining({ class: 'public_intelligence', status: 'DISABLED' }));
    expect(provider?.update).toEqual({ status: 'DISABLED' });
    const policy = policyUpsert.mock.calls.map(([input]) => input)
      .find((input) => input.where.domain === 'apis.data.go.kr');
    expect(policy?.create).toEqual(expect.objectContaining({
      sourceType: 'gov_award', personalData: true, allowedPurpose: ['discovery'], reviewStatus: 'SUSPENDED',
      termsStatus: 'UNREVIEWED',
      allowedPaths: ['/1230000/ao/CntrctInfoService/getCntrctInfoListThngPPSSrch'],
      notes: expect.stringMatching(/source_hint=koneps.*31 天.*结构性删除.*DISABLED.*KONEPS_SERVICE_KEY/u),
    }));
  });

  it('keeps SEC disabled and seeds separate directory and submissions policies', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);

    const provider = providerUpsert.mock.calls.map(([input]) => input).find((input) => input.where.key === 'sec_edgar');
    expect(provider?.create).toEqual(expect.objectContaining({
      key: 'sec_edgar', class: 'company_registry', status: 'DISABLED', costPerCallCents: 0,
    }));
    expect(provider?.update).toEqual({ status: 'DISABLED' });

    const directoryPolicy = policyUpsert.mock.calls.map(([input]) => input)
      .find((input) => input.where.domain === 'www.sec.gov');
    expect(directoryPolicy?.create).toEqual(expect.objectContaining({
      domain: 'www.sec.gov', sourceType: 'company_registry', personalData: false,
      allowedPurpose: ['discovery'], reviewStatus: 'APPROVED',
      notes: expect.stringMatching(/company_tickers.*精确.*ticker.*规范名.*DISABLED/iu),
    }));
    const submissionPolicy = policyUpsert.mock.calls.map(([input]) => input)
      .find((input) => input.where.domain === 'data.sec.gov');
    expect(submissionPolicy?.create).toEqual(expect.objectContaining({
      domain: 'data.sec.gov', sourceType: 'company_registry', personalData: true,
      allowedPurpose: ['enrichment'], reviewStatus: 'APPROVED',
      notes: expect.stringMatching(/已有.*目录.*CIK.*operating.*不.*创建/iu),
    }));
  });

  it('publishes the same fail-closed SEC contract in the machine Provider Registry', () => {
    const registry = JSON.parse(readFileSync(
      resolve(process.cwd(), '../../docs/governance/provider-registry.json'),
      'utf8',
    )) as { providers: Record<string, unknown>[] };
    const sec = registry.providers.find((provider) => provider.key === 'sec_edgar');
    expect(sec).toEqual(expect.objectContaining({
      key: 'sec_edgar',
      status: 'IMPLEMENTED',
      source_classes: ['company_registry'],
      default_enablement: 'DISABLED',
      personal_data_class: 'RESTRICTED_POSSIBLE',
      call_gates: expect.arrayContaining([
        'data_provider_status', 'source_policy', 'tool_broker', 'explicit_source_hint', 'bounded_response',
      ]),
      identity_authority: {
      profile_version: 'identity-authority-v2',
        rules: [{ scheme: 'cik', jurisdictions: ['US'], validator: 'cik-v1' }],
      },
    }));
  });
});
