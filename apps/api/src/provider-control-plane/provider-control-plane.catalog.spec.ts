import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_CONTROL_CATALOG } from './provider-control-plane.catalog';

describe('provider control-plane catalog governance', () => {
  it('covers every machine-registry provider and isolates sandbox as test-only', () => {
    const registry = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../docs/governance/provider-registry.json'),
        'utf8',
      ),
    ) as { providers: Array<{ key: string; status: string; source_classes: string[] }> };
    const governed = registry.providers
      .filter(({ status }) => status === 'IMPLEMENTED' || status === 'PARTIAL')
      .map(({ key }) => key)
      .sort();
    const catalogued = PROVIDER_CONTROL_CATALOG.map(({ key }) => key).sort();

    expect(catalogued).toEqual(governed);
    expect(PROVIDER_CONTROL_CATALOG.filter(({ exposure }) => exposure === 'REAL')).toHaveLength(33);
    expect(PROVIDER_CONTROL_CATALOG.find(({ key }) => key === 'sandbox')).toMatchObject({
      exposure: 'TEST_ONLY',
      route: { status: 'TEST_ONLY' },
    });
    expect(PROVIDER_CONTROL_CATALOG.find(({ key }) => key === 'singapore_gebiz')).toMatchObject({
      policy: { domains: ['data.gov.sg'] },
    });
    expect(PROVIDER_CONTROL_CATALOG.find(({ key }) => key === 'google_patents')).toMatchObject({
      credentialEvaluation: 'UNKNOWN',
      credentials: [
        { envKey: 'GOOGLE_PATENTS_SA_JSON' },
        { envKey: 'GOOGLE_APPLICATION_CREDENTIALS' },
        { envKey: 'GOOGLE_PATENTS_PROJECT' },
      ],
    });
    expect(PROVIDER_CONTROL_CATALOG.find(({ key }) => key === 'public_web')).toMatchObject({
      credentialRequirement: 'OPTIONAL',
      credentials: [
        { key: 'serperApiKey', envKey: 'SERPER_API_KEY', secret: true, writeOnly: true },
        { key: 'braveSearchApiKey', envKey: 'BRAVE_SEARCH_API_KEY', secret: true, writeOnly: true },
      ],
    });

    for (const provider of registry.providers.filter(({ source_classes }) => source_classes.length === 1)) {
      expect(
        PROVIDER_CONTROL_CATALOG.find(({ key }) => key === provider.key)?.category,
        `${provider.key} control-plane category must match its sole routed SourceClass`,
      ).toBe(provider.source_classes[0]);
    }
  });

  it('uses closed provider keys and never embeds a credential value', () => {
    expect(new Set(PROVIDER_CONTROL_CATALOG.map(({ key }) => key)).size).toBe(
      PROVIDER_CONTROL_CATALOG.length,
    );
    for (const provider of PROVIDER_CONTROL_CATALOG) {
      expect(provider.key).toMatch(/^[a-z0-9_]+$/u);
      expect(provider.policy.domains).toEqual([...new Set(provider.policy.domains)]);
      for (const credential of provider.credentials) {
        expect(credential.envKey).toMatch(/^[A-Z][A-Z0-9_]+$/u);
        expect(credential).not.toHaveProperty('value');
        expect(credential).not.toHaveProperty('defaultValue');
      }
    }
  });
});
