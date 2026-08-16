import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MonitoredSourceRawBridgeError,
  persistMonitoredSourceRawBridge,
  prepareMonitoredSourceRawBridge,
} from './monitored-source-raw-bridge';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

const source = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceKey: 'fair:example-2026',
  providerKey: 'mapyourshow',
  config: {
    host: 'example.mapyourshow.com',
  },
};

const entity = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  externalId: 'EX-42',
  name: 'Example Maschinenbau GmbH',
  domain: 'example.test',
  country: 'DE',
  cleaned: { products: ['press brake'], stand: 'A42' },
  contentHash: 'a'.repeat(64),
  lastSeenAt: new Date('2026-08-12T16:31:00.000Z'),
  lastSeenFetchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

const fetch = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  status: 'DONE',
  parserVersion: 'acquisition/v1',
  finishedAt: new Date('2026-08-12T16:31:00.000Z'),
};

const policies = [
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    domain: 'mapyourshow.com',
    retentionDays: 365,
    reviewStatus: 'APPROVED',
    allowedPurpose: ['discovery', 'enrichment'],
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  },
];

describe('monitored source -> RawSourceRecord bridge', () => {
  it('creates a stable snapshot receipt and maps the MapYourShow adapter to the governed trade_fair identity authority', () => {
    const first = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
      attributes: { products: ['press brake'], stand: 'A42' },
    });
    const repeated = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
      attributes: { stand: 'A42', products: ['press brake'] },
    });

    expect(repeated.row.ingestKey).toBe(first.row.ingestKey);
    expect(repeated.row.payloadHash).toBe(first.row.payloadHash);
    expect(first.identityProviderKey).toBe('trade_fair');
    expect(first.row).toMatchObject({
      ingestStatus: 'ACCEPTED',
      sourceUrl: 'https://example.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm',
      fetchedAt: entity.lastSeenAt,
      contentHash: entity.contentHash,
      parserVersion: fetch.parserVersion,
    });
    expect(first.record).toMatchObject({
      name: entity.name,
      domain: entity.domain,
      country: entity.country,
      license: 'SOURCE_SPECIFIC_RESTRICTED',
      monitoredSource: { sourceFetchId: fetch.id },
    });
  });

  it('derives source class and license from the governed provider profile, ignoring arbitrary source config claims', () => {
    const prepared = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source: {
        ...source,
        config: { host: 'example.mapyourshow.com', license: 'UNTRUSTED', sourceClass: 'email_verification' },
      },
      entity,
      fetch,
      policies,
      attributes: {},
    });

    expect(prepared.sourceClass).toBe('industry_data');
    expect(prepared.license).toBe('SOURCE_SPECIFIC_RESTRICTED');

    const registry = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../docs/governance/provider-registry.json'), 'utf8'),
    ) as { providers: Array<{ key: string; source_classes: string[]; license: { classification: string } }> };
    const governed = registry.providers.find((provider) => provider.key === 'trade_fair');
    expect(governed).toBeDefined();
    expect(governed?.source_classes).toContain(prepared.sourceClass);
    expect(governed?.license.classification).toBe(prepared.license);
  });

  it('accepts the existing trade-fair seed shape without adding license or sourceClass to config', () => {
    const prepared = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source: {
        ...source,
        providerKey: 'trade_fair',
        config: {
          fairSlug: 'interphex-2026',
          algolia: {
            appId: 'PUBLICAPP',
            indexName: 'public-exhibitors-index',
          },
        },
      },
      entity,
      fetch,
      policies: [{ ...policies[0], domain: 'algolia.net' }],
      attributes: {},
    });

    expect(prepared).toMatchObject({
      identityProviderKey: 'trade_fair',
      sourceClass: 'industry_data',
      license: 'SOURCE_SPECIFIC_RESTRICTED',
      row: { sourceUrl: 'https://publicapp-dsn.algolia.net/1/indexes/public-exhibitors-index' },
    });
  });

  it('creates a new immutable Raw observation for a later fetch even when the company content is unchanged', () => {
    const first = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
      attributes: {},
    });
    const laterFetch = {
      ...fetch,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      finishedAt: new Date('2026-08-13T16:30:00.000Z'),
    };
    const later = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity: { ...entity, lastSeenFetchId: laterFetch.id, lastSeenAt: new Date('2026-08-13T16:30:00.000Z') },
      fetch: laterFetch,
      policies,
      attributes: {},
    });

    expect(later.uniqueWhere.ingestKey).not.toBe(first.uniqueWhere.ingestKey);
    expect(later.record.monitoredSource.sourceFetchId).toBe(laterFetch.id);
  });

  it('scopes the persistence key to the workspace while preserving the same source snapshot identity', () => {
    const left = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
      attributes: {},
    });
    const right = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_B,
      source,
      entity,
      fetch,
      policies,
      attributes: {},
    });

    expect(left.uniqueWhere.workspaceId).toBe(WORKSPACE_A);
    expect(right.uniqueWhere.workspaceId).toBe(WORKSPACE_B);
    expect(left.uniqueWhere.sourceEntityId).toBe(right.uniqueWhere.sourceEntityId);
    expect(left.uniqueWhere.ingestKey).toBe(right.uniqueWhere.ingestKey);
  });

  it('uses one atomic compound upsert for concurrent repeats of the same workspace snapshot', async () => {
    const prepared = prepareMonitoredSourceRawBridge({
      workspaceId: WORKSPACE_A,
      source,
      entity,
      fetch,
      policies,
      attributes: {},
    });
    const rows = new Map<string, { id: string; payloadHash: string; ingestStatus: string }>();
    const tx = {
      rawSourceRecord: {
        upsert: async ({ where, create }: any) => {
          await Promise.resolve();
          const key = JSON.stringify(where.workspaceId_sourceEntityId_ingestKey);
          const existing = rows.get(key);
          if (existing) return existing;
          const created = { id: `raw-${rows.size + 1}`, payloadHash: create.payloadHash, ingestStatus: create.ingestStatus };
          rows.set(key, created);
          return created;
        },
      },
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        persistMonitoredSourceRawBridge(tx as never, { workspaceId: WORKSPACE_A, prepared }),
      ),
    );

    expect(rows.size).toBe(1);
    expect(new Set(results.map((result) => result.id))).toEqual(new Set(['raw-1']));
  });

  it.each([
    ['missing parser version', { fetch: { ...fetch, parserVersion: null } }],
    ['missing observed time', { entity: { ...entity, lastSeenAt: null } }],
    ['missing entity fetch provenance', { entity: { ...entity, lastSeenFetchId: null } }],
    ['mismatched entity fetch provenance', { entity: { ...entity, lastSeenFetchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }],
    ['mismatched observation time', { entity: { ...entity, lastSeenAt: new Date('2026-08-12T16:30:00.000Z') } }],
    ['incomplete fetch', { fetch: { ...fetch, status: 'RUNNING', finishedAt: null } }],
    ['dynamic contact email in Raw attributes', { attributes: { contact_email: 'sales@example.test' } }],
    ['unknown provider profile', { source: { ...source, providerKey: 'unregistered_source' } }],
    ['unapproved source policy', { policies: [{ ...policies[0], reviewStatus: 'SUSPENDED' }] }],
  ])('fails closed for %s', (_name, override) => {
    expect(() =>
      prepareMonitoredSourceRawBridge({
        workspaceId: WORKSPACE_A,
        source: override.source ?? source,
        entity: override.entity ?? entity,
        fetch: override.fetch ?? fetch,
        policies: override.policies ?? policies,
        attributes: override.attributes ?? {},
      }),
    ).toThrow(MonitoredSourceRawBridgeError);
  });
});
