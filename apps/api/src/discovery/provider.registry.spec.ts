import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import type { ModelGateway } from '../model-gateway/model-gateway';
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
