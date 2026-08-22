import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from './durable-execution-receipt';
import {
  DomainAckService,
  InMemoryDomainAckRepository,
  PostgresDomainAckRepository,
} from './domain-ack';
import {
  DOMAIN_ACK_PRODUCT_CONSUMER_BINDINGS,
  applyDomainAckConsumerTransaction,
  getDomainAckProductConsumerBinding,
} from './domain-ack-consumer-bindings';

const UUID_A = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const UUID_B = '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0';
const UUID_C = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';

function receipt(
  overrides: Partial<DurableExecutionReceipt> = {},
): DurableExecutionReceipt {
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: 'workspace-1',
    authorityId: UUID_A,
    accountId: UUID_B,
    operationId: UUID_C,
    operationKey: 'workspace:model:taxonomy.normalize:request-1',
    resultStrategy: 'typed_projection',
    resultSchema: 'taxonomy-code/v1',
    resultDigest: 'a'.repeat(64),
    artifactId: null,
    usage: {
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      chargedMicrousd: '0',
      upperBoundMicrousd: '0',
    },
    costBasis: 'estimated_upper_bound',
    ...overrides,
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(',')}}`;
}

function opaque(value: string): string {
  return createHash('sha256').update(value.normalize('NFC')).digest('hex');
}

function ackRecord(domainAggregateId = 'taxonomy:cpv:pump', revision = '0') {
  const durableReceipt = receipt();
  const domainAckKey = opaque(domainAggregateId);
  const domainRevision = opaque(revision);
  const ackInput = {
    operationId: durableReceipt.operationId,
    consumer: 'TaxonomyResolver',
    domainAggregateType: 'TermAlias',
    domainAckKey,
    domainRevision,
    resultDigest: durableReceipt.resultDigest,
  };
  return {
    schemaVersion: 'domain-ack/v1',
    ackId: createHash('sha256').update(canonical(ackInput)).digest('hex'),
    operationId: durableReceipt.operationId,
    operationKey: durableReceipt.operationKey,
    authorityId: durableReceipt.authorityId,
    accountId: durableReceipt.accountId,
    scopeKey: durableReceipt.scopeKey,
    consumer: ackInput.consumer,
    domainAggregateType: ackInput.domainAggregateType,
    domainAckKey,
    domainRevision,
    resultStrategy: durableReceipt.resultStrategy,
    resultSchema: durableReceipt.resultSchema,
    resultDigest: durableReceipt.resultDigest,
    artifactId: durableReceipt.artifactId,
    usage: durableReceipt.usage,
    costBasis: durableReceipt.costBasis,
  };
}

describe('DomainAckService', () => {
  it('applies once and replays the same ack without running the consumer twice', async () => {
    const service = new DomainAckService(new InMemoryDomainAckRepository());
    const apply = vi.fn(async () => ({ code: 'CPV-123' }));
    const input = {
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    } as const;

    await expect(service.applyWithAck(input, apply)).resolves.toMatchObject({
      status: 'APPLIED',
      value: { code: 'CPV-123' },
      ack: {
        consumer: 'TaxonomyResolver',
        domainAggregateType: 'TermAlias',
        domainAckKey: opaque('taxonomy:cpv:pump'),
        resultDigest: 'a'.repeat(64),
      },
    });
    await expect(service.applyWithAck(input, apply)).resolves.toMatchObject({
      status: 'REPLAYED',
      value: undefined,
      ack: {
        operationId: UUID_C,
        domainAckKey: opaque('taxonomy:cpv:pump'),
      },
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent ACK attempts so the domain write executes once', async () => {
    const service = new DomainAckService(new InMemoryDomainAckRepository());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = vi.fn(async () => {
      await gate;
      return { code: 'CPV-123' };
    });
    const input = {
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    } as const;

    const first = service.applyWithAck(input, apply);
    const second = service.applyWithAck(input, apply);
    await Promise.resolve();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'APPLIED', value: { code: 'CPV-123' } }),
      expect.objectContaining({ status: 'REPLAYED', value: undefined }),
    ]);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('allows the same settled operation to ACK distinct domain aggregate revisions independently', async () => {
    const service = new DomainAckService(new InMemoryDomainAckRepository());
    const apply = vi.fn(async (value: string) => ({ code: value }));
    const base = {
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    } as const;

    await expect(
      service.applyWithAck({ ...base, domainRevision: '1' } as never, () => apply('CPV-123')),
    ).resolves.toMatchObject({
      status: 'APPLIED',
      ack: {
        domainAckKey: opaque('taxonomy:cpv:pump'),
        domainRevision: opaque('1'),
      },
    });
    await expect(
      service.applyWithAck({ ...base, domainRevision: '2' } as never, () => apply('CPV-456')),
    ).resolves.toMatchObject({
      status: 'APPLIED',
      value: { code: 'CPV-456' },
      ack: {
        domainAckKey: opaque('taxonomy:cpv:pump'),
        domainRevision: opaque('2'),
      },
    });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('throws a stable conflict when the same aggregate revision is acked with a different receipt digest', async () => {
    const service = new DomainAckService(new InMemoryDomainAckRepository());
    const apply = vi.fn(async () => undefined);
    const base = {
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainRevision: '1',
    } as const;

    await service.applyWithAck({ ...base, domainAckKey: 'taxonomy:cpv:pump' } as never, apply);

    await expect(
      service.applyWithAck({
        ...base,
        receipt: receipt({ resultDigest: 'b'.repeat(64) }),
        domainAckKey: 'taxonomy:cpv:pump',
      } as never, apply),
    ).rejects.toMatchObject({ code: 'DOMAIN_ACK_CONFLICT' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rejects PII-like ACK keys and never stores receipt payload fields', async () => {
    const repository = new InMemoryDomainAckRepository();
    const service = new DomainAckService(repository);
    await expect(
      service.applyWithAck({
        receipt: receipt(),
        consumer: 'ContactDecisionMaker',
        domainAggregateType: 'Contact',
        domainAckKey: 'person:ada@example.test',
      }, async () => undefined),
    ).rejects.toThrow('DOMAIN_ACK_INVALID');
    expect(repository.snapshot()).toEqual([]);
  });

  it('keeps product consumer bindings additive and allows non-PII consumer names like EmailVerificationProvider', async () => {
    const repository = new InMemoryDomainAckRepository();
    const service = new DomainAckService(repository);
    const apply = vi.fn(async () => ({ status: 'verified' }));

    expect(DOMAIN_ACK_PRODUCT_CONSUMER_BINDINGS).toHaveLength(28);
    expect(getDomainAckProductConsumerBinding('smtp.rcpt_probe')).toEqual({
      producerId: 'smtp.rcpt_probe',
      consumer: 'EmailVerificationProvider',
      domainAggregateType: 'EmailVerification',
      identity: 'normalized-email-hash',
    });

    await expect(applyDomainAckConsumerTransaction({
      service,
      producerId: 'smtp.rcpt_probe',
      receipt: receipt(),
      domainAckKey: 'smtp-rcpt:sha256:abc123',
      domainRevision: '1',
      apply,
    })).resolves.toMatchObject({
      status: 'APPLIED',
      value: { status: 'verified' },
      ack: {
        consumer: 'EmailVerificationProvider',
        domainAggregateType: 'EmailVerification',
        domainAckKey: opaque('smtp-rcpt:sha256:abc123'),
        domainRevision: opaque('1'),
      },
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('ships a transaction-compatible Postgres ACK schema with row locks and uniqueness', async () => {
    const migration = await readFile(
      new URL(
        '../../../../packages/db/prisma/migrations/20260823000000_execution_domain_ack/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE "execution_domain_ack"');
    expect(migration).toContain('"domain_revision" CHAR(64) NOT NULL');
    expect(migration).not.toContain('UNIQUE ("operation_id")');
    expect(migration).toMatch(
      /UNIQUE \([\s\S]*?"operation_id", "consumer", "domain_aggregate_type",[\s\S]*?"domain_ack_key", "domain_revision"[\s\S]*?\)/,
    );
    expect(migration).toContain('REFERENCES "tool_budget_operation"');
    expect(migration).toContain('REFERENCES "tool_budget_account"');
    expect(migration).toContain('operation."status" IS DISTINCT FROM \'SETTLED\'');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE "execution_domain_ack" FROM PUBLIC');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('"ack_json" ?& ARRAY[');
    expect(migration).toContain('"ack_json" - ARRAY[');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('apply_execution_domain_ack_v1');
    expect(migration).toContain('jsonb_typeof');
    expect(migration).toContain('DOMAIN_ACK_CONFLICT');
    expect(migration).toContain('p_reservation_microusd BIGINT');
    expect(migration).not.toContain('operation."reserved_cents" * 10000');
    expect(migration).toContain('operation."reserved_microusd"');
    expect(migration).not.toContain("session_user <> 'app_user'");
    expect(migration).toContain('PERFORM assert_execution_budget_platform_writer_principal()');
    expect(migration).toMatch(
      /ELSIF session_user IS DISTINCT FROM 'app_user'[\s\S]*?current_setting\('role', true\) IS DISTINCT FROM 'none'[\s\S]*?current_workspace_id\(\)::text/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?apply_execution_domain_ack_v1\([\s\S]*?FROM PUBLIC/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*?apply_execution_domain_ack_v1\([\s\S]*?TO app_user, execution_budget_platform_writer/,
    );
    expect(migration).not.toContain("p_ack->>'resultStrategy'");
    expect(migration).not.toContain("p_ack->>'artifactId'");
    expect(migration).not.toContain("p_ack->>'ackId'");
    expect(migration).toContain('operation."result_schema_version"');
    expect(migration).toContain("operation.\"result_json\"->>'artifactId'");
    expect(migration).toContain('public.digest');
  });

  it('passes the same database transaction object into the domain mutation callback', async () => {
    const transaction = {
      $queryRaw: vi.fn(async (_query: unknown) => [{
        status: 'APPLIED',
        ack_json: ackRecord(),
      }]),
    };
    const service = new DomainAckService(new PostgresDomainAckRepository(transaction));
    const apply = vi.fn(async (tx) => {
      expect(tx).toBe(transaction);
      return { code: 'CPV-123' };
    });

    await expect(service.applyWithAck({
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    }, apply)).resolves.toMatchObject({
      status: 'APPLIED',
      value: { code: 'CPV-123' },
    });
    expect(apply).toHaveBeenCalledTimes(1);
    const query = transaction.$queryRaw.mock.calls[0]?.[0] as {
      readonly values: readonly unknown[];
    };
    expect(query.values).toEqual([
      'workspace-1',
      UUID_C,
      'TaxonomyResolver',
      'TermAlias',
      opaque('taxonomy:cpv:pump'),
      opaque('0'),
    ]);
    expect(query.values).not.toContainEqual(expect.objectContaining({
      resultStrategy: expect.anything(),
    }));
  });

  it('returns APPLIED from the transaction repository only after the domain callback succeeds', async () => {
    const service = new DomainAckService(new PostgresDomainAckRepository({
      $queryRaw: vi.fn(async () => [{
        status: 'APPLIED',
        ack_json: ackRecord(),
      }]),
    }));
    const apply = vi.fn(async () => ({ code: 'CPV-123' }));

    await expect(service.applyWithAck({
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    }, apply)).resolves.toMatchObject({
      status: 'APPLIED',
      value: { code: 'CPV-123' },
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('replays a transaction ACK without invoking the domain callback', async () => {
    const service = new DomainAckService(new PostgresDomainAckRepository({
      $queryRaw: vi.fn(async () => [{
        status: 'REPLAYED',
        ack_json: ackRecord(),
      }]),
    }));
    const apply = vi.fn(async () => ({ code: 'CPV-123' }));

    await expect(service.applyWithAck({
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    }, apply)).resolves.toMatchObject({
      status: 'REPLAYED',
      value: undefined,
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('fails closed when a transaction ACK row does not match the expected domain identity', async () => {
    const service = new DomainAckService(new PostgresDomainAckRepository({
      $queryRaw: vi.fn(async () => [{
        status: 'REPLAYED',
        ack_json: ackRecord('taxonomy:cpv:other'),
      }]),
    }));
    const apply = vi.fn(async () => undefined);

    await expect(service.applyWithAck({
      receipt: receipt(),
      consumer: 'TaxonomyResolver',
      domainAggregateType: 'TermAlias',
      domainAckKey: 'taxonomy:cpv:pump',
    }, apply)).rejects.toMatchObject({ code: 'DOMAIN_ACK_CONFLICT' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('wires actual product consumers to the receipt-aware helper inside their domain transaction', async () => {
    const consumers = [
      ['../icp/icp.service.ts', ['icp.design', 'discovery.query_plan']],
      ['../discovery/taxonomy-resolver.ts', ['taxonomy.normalize']],
      ['../discovery/fit-judge.ts', ['discovery.qualify_fit']],
      ['../temporal/understanding.activities.ts', [
        'company_understanding.extract_claims',
        'company_understanding.extract_profile',
        'company_understanding.extract_offerings',
      ]],
      ['../temporal/discovery.activities.ts', [
        'companies_house.search', 'crawl4ai.fetch', 'crawl4ai.render',
        'gleif.fetch', 'http.get', 'inpi_rne.search', 'mapyourshow.fetch',
        'openfda.search', 'osm.overpass', 'searxng.search', 'smtp.rcpt_probe',
        'tradefair.algolia', 'wikidata.entity', 'wikidata.sparql',
        'discovery.extract_company', 'discovery.extract_list',
        'contact.find_decision_makers',
      ]],
      ['../temporal/patents-cache.activities.ts', ['google_patents.search']],
      ['../sanctions/sanctions-refresh.service.ts', ['sanctions.download']],
      ['../signals/signal-ingest.service.ts', ['ted.search', 'openfda.search', 'samgov.search']],
      ['../intent/intent-projection.service.ts', ['http.get']],
    ] as const;
    const sources = await Promise.all(consumers.map(([path]) => readFile(
      new URL(path, import.meta.url),
      'utf8',
    )));

    for (const [index, source] of sources.entries()) {
      const [path, producerIds] = consumers[index]!;
      expect(source, path).toContain('applyDomainAckConsumerTransaction');
      expect(source, path).toContain('durableReceipt');
      for (const producerId of producerIds) {
        expect(source, `${path}:${producerId}`).toContain(producerId);
      }
    }
  });
});
