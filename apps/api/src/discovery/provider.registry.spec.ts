import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import type { ModelGateway } from '../model-gateway/model-gateway';
import { isDiscoveryCompanyLineageProviderKey } from './company-discovery-lineage';
import { isDiscoveryQueryLineageProviderKey } from './discovery-query-governed-lineage';
import { DiscoveryProviderRegistry } from './provider.registry';
import { PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN } from './source-policy-scope';

describe('DiscoveryProviderRegistry SourceClass governance', () => {
  it('binds structured and gateway-backed product adapters to the manifest', () => {
    expect(() => new DiscoveryProviderRegistry()).not.toThrow();
    expect(
      () =>
        new DiscoveryProviderRegistry({
          gateway: {} as ModelGateway,
        }),
    ).not.toThrow();
  });

  it('never registers a synthetic sandbox adapter when the gateway is absent or an old opt-in is set', async () => {
    const previous = process.env.DISCOVERY_ALLOW_SANDBOX;
    process.env.DISCOVERY_ALLOW_SANDBOX = 'true';
    try {
      const registry = new DiscoveryProviderRegistry();
      const db = {
        dataProvider: {
          findMany: async () => [{ key: 'sandbox' }],
        },
      };
      const routed = await Promise.all([
        registry.routeCompanyDiscovery(db as never, 'public_intelligence'),
        registry.routeContactDiscovery(db as never),
        registry.routeEmailVerification(db as never),
      ]);
      expect(routed.flat().map((adapter) => adapter.key)).not.toContain('sandbox');
    } finally {
      if (previous === undefined) delete process.env.DISCOVERY_ALLOW_SANDBOX;
      else process.env.DISCOVERY_ALLOW_SANDBOX = previous;
    }
  });

  it('never seeds a sandbox provider into the product control plane', async () => {
    const previous = process.env.DISCOVERY_ALLOW_SANDBOX;
    process.env.DISCOVERY_ALLOW_SANDBOX = 'true';
    try {
      const upsert = async (args: unknown) => {
        calls.push(args);
        return args;
      };
      const calls: unknown[] = [];
      await new DiscoveryProviderRegistry().seed({
        dataProvider: { upsert },
      } as never);
      expect(
        calls.some((entry) =>
          JSON.stringify(entry).includes('"key":"sandbox"'),
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DISCOVERY_ALLOW_SANDBOX;
      else process.env.DISCOVERY_ALLOW_SANDBOX = previous;
    }
  });

  it('seeds the public_web company-site source policy once and never overwrites a later change', async () => {
    const policies: Array<{
      where: unknown;
      update: unknown;
      create: Record<string, unknown>;
    }> = [];
    await new DiscoveryProviderRegistry().seed({
      dataProvider: { upsert: async (args: unknown) => args },
      sourcePolicy: {
        upsert: async (args: (typeof policies)[number]) => {
          policies.push(args);
          return args;
        },
      },
    } as never);

    const companySite = policies.filter(
      (entry) => entry.create.domain === PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
    );
    expect(companySite).toEqual([
      {
        where: { domain: PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN },
        // An operator's SUSPENDED or retention change survives every later startup seed.
        update: {},
        create: {
          domain: PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
          sourceType: 'official_website',
          accessMode: 'crawl',
          reviewStatus: 'APPROVED',
          robotsStatus: 'UNREVIEWED',
          termsStatus: 'UNREVIEWED',
          personalData: true,
          allowedPurpose: ['discovery', 'enrichment'],
          retentionDays: 365,
          notes: expect.stringContaining('public_web'),
        },
      },
    ]);
  });

  it('seeds the BI-14 company_contact switch DISABLED and never overwrites a later change', async () => {
    const providers: Array<{ where: unknown; update: unknown; create: Record<string, unknown> }> = [];
    await new DiscoveryProviderRegistry().seed({
      dataProvider: {
        upsert: async (args: (typeof providers)[number]) => {
          providers.push(args);
          return args;
        },
      },
    } as never);

    expect(providers.filter((entry) => entry.create.key === 'company_contact')).toEqual([
      {
        where: { key: 'company_contact' },
        update: {},
        create: { key: 'company_contact', class: 'public_intelligence', status: 'DISABLED', costPerCallCents: 0 },
      },
    ]);
  });

  it('lists every company discovery source a plan query can route to, in registration order (BI-30)', () => {
    const sources = new DiscoveryProviderRegistry({ gateway: {} as ModelGateway })
      .companyDiscoverySources();

    expect(sources).toEqual([
      { sourceClass: 'public_intelligence', providerKey: 'public_web', hasCompanyLineage: true },
      { sourceClass: 'industry_data', providerKey: 'public_web', hasCompanyLineage: true },
      { sourceClass: 'industry_data', providerKey: 'directory', hasCompanyLineage: true },
      { sourceClass: 'company_registry', providerKey: 'wikidata', hasCompanyLineage: true },
      { sourceClass: 'industry_data', providerKey: 'wikidata', hasCompanyLineage: true },
      { sourceClass: 'industry_data', providerKey: 'openstreetmap', hasCompanyLineage: true },
      { sourceClass: 'industry_data', providerKey: 'trade_fair', hasCompanyLineage: true },
      { sourceClass: 'public_intelligence', providerKey: 'ted', hasCompanyLineage: true },
      { sourceClass: 'public_intelligence', providerKey: 'openfda', hasCompanyLineage: true },
      // WEB-1 模型联网搜索：env 开关默认 off 时 fail-safe 返回有效空血缘，路由身份不因开关变化。
      { sourceClass: 'public_intelligence', providerKey: 'model_web_search', hasCompanyLineage: true },
      // T3-09 注册面：本地 registry frame 枚举注册为 company_registry 源，但**刻意不声明**
      // 公司血缘（零出网=无 durable 回执），执行面等 local_query 变体获批
      // （design: docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md）。
      { sourceClass: 'company_registry', providerKey: 'registry_frame', hasCompanyLineage: false },
    ]);
    // Contact, email and enrichment adapters are never plan query sources.
    expect(sources.map((source) => source.providerKey)).not.toEqual(
      expect.arrayContaining(['gleif']),
    );
    expect(
      new DiscoveryProviderRegistry().companyDiscoverySources().map((s) => s.providerKey),
    ).not.toContain('public_web');
  });

  it('reads the ENABLED company discovery sources from the data_provider kill switch (BI-30)', async () => {
    const findMany = async (args: unknown) => {
      expect(args).toEqual({ where: { status: 'ENABLED' }, select: { key: true } });
      return [{ key: 'public_web' }, { key: 'gleif' }, { key: 'ted' }];
    };

    const enabled = await new DiscoveryProviderRegistry({ gateway: {} as ModelGateway })
      .enabledCompanyDiscoverySources({ dataProvider: { findMany } } as never);

    expect(enabled).toEqual([
      { sourceClass: 'public_intelligence', providerKey: 'public_web', hasCompanyLineage: true },
      { sourceClass: 'industry_data', providerKey: 'public_web', hasCompanyLineage: true },
      { sourceClass: 'public_intelligence', providerKey: 'ted', hasCompanyLineage: true },
    ]);
  });

  it('never routes an ENABLED company discovery adapter without governed lineage (lineage gate)', async () => {
    const registry = new DiscoveryProviderRegistry({ gateway: {} as ModelGateway });
    const keys = [...new Set(registry.companyDiscoverySources().map((source) => source.providerKey))];
    const db = { dataProvider: { findMany: async () => keys.map((key) => ({ key })) } };

    const routed = async (sourceClass: 'industry_data' | 'company_registry' | 'public_intelligence') =>
      (await registry.routeCompanyDiscovery(db as never, sourceClass)).map((adapter) => adapter.key);

    expect(await routed('industry_data')).toEqual([
      'public_web', 'directory', 'wikidata', 'openstreetmap', 'trade_fair',
    ]);
    expect(await routed('company_registry')).toEqual(['wikidata']);
    expect(await routed('public_intelligence')).toEqual([
      'public_web', 'ted', 'openfda', 'model_web_search',
    ]);
  });

  it('registers registry_frame as a company_registry source that the lineage gate keeps unrouted (T3-09)', async () => {
    const registry = new DiscoveryProviderRegistry({ gateway: {} as ModelGateway });
    const db = { dataProvider: { findMany: async () => [{ key: 'registry_frame' }, { key: 'wikidata' }] } };

    const enabled = await registry.enabledCompanyDiscoverySources(db as never);
    expect(enabled).toContainEqual({
      sourceClass: 'company_registry',
      providerKey: 'registry_frame',
      hasCompanyLineage: false,
    });
    // 注册 ≠ 可执行：无血缘声明时路由闸门必须排除它（预期行为，不是缺陷）。
    expect(
      (await registry.routeCompanyDiscovery(db as never, 'company_registry')).map((adapter) => adapter.key),
    ).toEqual(['wikidata']);
  });

  it('seeds registry_frame DISABLED as the second kill switch (T3-09)', async () => {
    const providers: Array<{ where: unknown; update: unknown; create: Record<string, unknown> }> = [];
    await new DiscoveryProviderRegistry().seed({
      dataProvider: {
        upsert: async (args: (typeof providers)[number]) => {
          providers.push(args);
          return args;
        },
      },
    } as never);
    expect(providers.filter((entry) => entry.create.key === 'registry_frame')).toEqual([
      {
        where: { key: 'registry_frame' },
        update: {},
        create: {
          key: 'registry_frame',
          class: 'company_registry',
          status: 'DISABLED',
          costPerCallCents: 0,
        },
      },
    ]);
  });

  it('reads lineage from the adapter declaration, which matches both lineage contracts', () => {
    const sources = new DiscoveryProviderRegistry({ gateway: {} as ModelGateway })
      .companyDiscoverySources();

    expect(
      [...new Set(sources.filter((source) => source.hasCompanyLineage).map((source) => source.providerKey))],
    ).toEqual([
      'public_web', 'directory', 'wikidata', 'openstreetmap', 'trade_fair', 'ted', 'openfda',
      'model_web_search',
    ]);
    // A declared source that either contract rejects would fail its governed query instead of running it.
    for (const source of sources) {
      if (source.hasCompanyLineage) {
        expect(isDiscoveryCompanyLineageProviderKey(source.providerKey), source.providerKey).toBe(true);
        expect(isDiscoveryQueryLineageProviderKey(source.providerKey), source.providerKey).toBe(true);
      }
    }
    // A 方案（local_query）：registry_frame 已在两份封闭契约白名单内；默认 off 不声明血缘，
    // REGISTRY_FRAME_PROVIDER=on 才声明（就地回滚开关）。
    expect(isDiscoveryCompanyLineageProviderKey('registry_frame')).toBe(true);
    expect(isDiscoveryQueryLineageProviderKey('registry_frame')).toBe(true);
  });

  it('writes the company-site seed as one brace-free create body, as the provider registry parse expects', () => {
    // scripts/governance-evidence-provider-contracts.mjs reads each `create: {...}` without nested
    // braces and keeps only bodies with a provider key, class and status, so this one stays out.
    const source = readFileSync(new URL('./provider.registry.ts', import.meta.url), 'utf8');
    const bodies = [...source.matchAll(/create:\s*\{([^{}]*)\}/gsu)].map((match) => match[1]!);
    const companySite = bodies.filter((body) =>
      body.includes('PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN'),
    );

    expect(companySite).toHaveLength(1);
    expect(companySite[0]).not.toMatch(/\bkey:|\bclass:|\bstatus:/u);
  });
});
