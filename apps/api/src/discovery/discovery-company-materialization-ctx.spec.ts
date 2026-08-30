import { describe, expect, it } from 'vitest';

const MODULE = './discovery-company-materialization-ctx';
const OUTCOMES = Object.freeze([
  'CANONICALIZED', 'RAW_QUARANTINED', 'RAW_REJECTED',
  'RESTRICTED_PROCESSING', 'SUPPRESSED', 'NOT_CANONICALIZABLE',
  'EXPIRED_BEFORE_CANONICALIZATION',
] as const);
const UUID = Object.freeze({
  workspace: '10000000-0000-4000-8000-000000000001',
  admission: '11000000-0000-4000-8000-000000000001',
  run: '20000000-0000-4000-8000-000000000001',
  queryItem: '30000000-0000-4000-8000-000000000001',
  raw: '40000000-0000-4000-8000-000000000001',
  rawSubject: '41000000-0000-4000-8000-000000000001',
  qRelation: '42000000-0000-4000-8000-000000000001',
  operation: '43000000-0000-4000-8000-000000000001',
  canonical: '50000000-0000-4000-8000-000000000001',
  identityLink: '51000000-0000-4000-8000-000000000001',
  canonicalSubject: '52000000-0000-4000-8000-000000000001',
  cRelation: '53000000-0000-4000-8000-000000000001',
  disposition: '60000000-0000-4000-8000-000000000001',
});
const SHA = Object.freeze({ contract: 'a'.repeat(64), evidence: 'c'.repeat(64),
  suppression: '8b89bd0745b48bd624a216a76f9109eef686746e21dffcbbc6e72ff6e2c93686' });

type Module = Readonly<{
  DISCOVERY_COMPANY_MATERIALIZATION_OUTCOMES: readonly string[];
  buildDiscoveryCompanyMaterializationBatchPlanV1(value: unknown): Readonly<{
    schemaVersion: 'discovery-company-materialization-batch-plan/v1';
    batchOrdinal: number;
    firstItemKey: string | null;
    lastItemKey: string | null;
    itemSetSha256: string;
    items: readonly Readonly<Record<string, unknown>>[];
  }>;
}>;

async function load(): Promise<Module> {
  try { return await import(MODULE) as Module; }
  catch (error) {
    if (error instanceof Error && /Cannot find module|Failed to resolve import|ERR_MODULE_NOT_FOUND/u.test(error.message))
      throw new Error('C_TX_MODULE_MISSING', { cause: error });
    throw error;
  }
}

function qItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { queryItemId: UUID.queryItem, queryKey: 'e'.repeat(64), queryOrdinal: 0,
    providerKey: 'public_web', recordIndex: 0, operationId: UUID.operation,
    rawRecordId: UUID.raw, rawGovernedSubjectId: UUID.rawSubject,
    qRelationId: UUID.qRelation, qIngestStatus: 'ACCEPTED', ...overrides };
}
function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { rawStatus: 'ACCEPTED', rawExpiredAt: null, restrictedDispositionId: null,
    suppressionRecordIds: [], product: { name: 'Acme Pumps GmbH', domain: 'acme.example',
      country: 'DE', region: null, industry: 'industrial pumps', employeeCount: null,
      revenueUsd: null, attributes: {}, identifier: null, license: 'public' }, ...overrides };
}
function canonical(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { canonicalCompanyId: UUID.canonical, identityLinkId: UUID.identityLink,
    identityCanonicalType: 'company', canonicalGovernedSubjectId: UUID.canonicalSubject,
    cRelationId: UUID.cRelation, cRelationKey: 'discovery.canonical_company:0',
    matchRule: 'domain_exact', confidence: 1, mutationClass: 'CREATED', evidenceCount: 2,
    evidenceManifestSha256: SHA.evidence, ...overrides };
}
function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const item = (overrides.qItem as Record<string, unknown> | undefined) ?? qItem();
  return { qItem: item, lockedFacts: facts(), exactExistingOutcome: null,
    reusableIdentity: null, reusableManifestCandidates: [],
    companyParse: { status: 'VALID', dedupeKey: 'domain:acme.example' },
    canonicalWrite: canonical({
      cRelationKey: `discovery.canonical_company:${String(item.recordIndex)}`,
    }), ...overrides };
}
function batch(items: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 'discovery-company-materialization-builder-input/v1',
    workspaceId: UUID.workspace, admissionId: UUID.admission, runId: UUID.run,
    queryKey: 'e'.repeat(64), batchOrdinal: 0, contractSha256: SHA.contract, items, ...overrides };
}
function terminal(outcome: string): Record<string, unknown> {
  return { canonicalCompanyId: null, identityLinkId: null, identityCanonicalType: null,
    canonicalGovernedSubjectId: null, cRelationId: null, cRelationKey: null,
    matchRule: null, confidence: null, mutationClass: null, evidenceCount: null,
    evidenceManifestSha256: null,
    restrictedDispositionId: outcome === 'RESTRICTED_PROCESSING' ? UUID.disposition : null,
    suppressionMatchSha256: outcome === 'SUPPRESSED' ? SHA.suppression : null,
    suppressionMatchCount: outcome === 'SUPPRESSED' ? 1 : null,
    rawExpiredAt: outcome === 'EXPIRED_BEFORE_CANONICALIZATION' ? '2026-08-31T00:00:00.000Z' : null,
    notCanonicalizableReasonCode: outcome === 'NOT_CANONICALIZABLE' ? 'COMPANY_IDENTITY_INVALID' : null };
}
function storedOutcome(outcome: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...qItem(), outcome, contractSha256: SHA.contract, ...terminal(outcome),
    ...(outcome === 'CANONICALIZED' ? canonical() : {}), ...overrides };
}

describe('C-TX pure Q-item batch builder', () => {
  it('keeps the approved outcome and canonical item-order reference unambiguous', () => {
    expect(OUTCOMES).toHaveLength(7);
    expect(new Set(OUTCOMES).size).toBe(7);
    const keys = [
      'trade_fair:0:40000000-0000-4000-8000-000000000002:30000000-0000-4000-8000-000000000002',
      'public_web:0:40000000-0000-4000-8000-000000000001:30000000-0000-4000-8000-000000000001',
    ];
    expect([...keys].sort()).toEqual([keys[1], keys[0]]);
  });

  it('exports the seven approved outcomes and no run admission or transaction fence API', async () => {
    const module = await load();
    expect(module.DISCOVERY_COMPANY_MATERIALIZATION_OUTCOMES).toEqual(OUTCOMES);
    expect(Object.isFrozen(module.DISCOVERY_COMPANY_MATERIALIZATION_OUTCOMES)).toBe(true);
    expect(module).not.toHaveProperty('buildDiscoveryCompanyMaterializationAdmissionV1');
    expect(module).not.toHaveProperty('lockDiscoveryCompanyMaterializationTransaction');
  });

  it('derives provider/index/raw/item canonical batches of 128, never a Raw-ID cursor', async () => {
    const module = await load();
    const items = Array.from({ length: 130 }, (_, index) => candidate({ qItem: qItem({
      queryItemId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      providerKey: index % 2 === 0 ? 'public_web' : 'trade_fair', recordIndex: Math.floor(index / 2),
      rawRecordId: `40000000-0000-4000-8000-${String(130 - index).padStart(12, '0')}`,
    }) })).reverse();
    const first = module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch(items.slice(0, 128)));
    expect(first.items).toHaveLength(128); expect(first.batchOrdinal).toBe(0);
    const firstItem = first.items[0]!;
    expect(first.firstItemKey).toBe(
      `${String(firstItem.providerKey)}:${String(firstItem.recordIndex)}:${String(firstItem.rawRecordId)}:${String(firstItem.queryItemId)}`,
    );
    expect(first.lastItemKey).not.toBeNull(); expect(first.itemSetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toHaveProperty('nextRawRecordId'); expect(first).not.toHaveProperty('afterRawRecordId');
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.items)).toBe(true);
    expect(module.buildDiscoveryCompanyMaterializationBatchPlanV1(
      batch(items.slice(128), { batchOrdinal: 1 }),
    ).items).toHaveLength(2);
  });

  it('represents a zero-item query without inventing one physical batch', async () => {
    const module = await load();
    expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([])))
      .toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  });

  it('sorts record index numerically so index 2 precedes index 10', async () => {
    const module = await load();
    const at10 = candidate({ qItem: qItem({ recordIndex: 10,
      queryItemId: '30000000-0000-4000-8000-000000000010' }) });
    const at2 = candidate({ qItem: qItem({ recordIndex: 2,
      queryItemId: '30000000-0000-4000-8000-000000000002' }) });
    const result = module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([at10, at2]));
    expect(result.items.map((item) => item.recordIndex)).toEqual([2, 10]);
  });
});

describe('C-TX exact outcome precedence and row matrix', () => {
  it.each([
    ['RAW_QUARANTINED', { qItem: qItem({ qIngestStatus: 'QUARANTINED' }) }],
    ['RAW_REJECTED', { qItem: qItem({ qIngestStatus: 'REJECTED' }) }],
    ['RESTRICTED_PROCESSING', { lockedFacts: facts({ restrictedDispositionId: UUID.disposition }) }],
    ['SUPPRESSED', { lockedFacts: facts({ suppressionRecordIds: [UUID.disposition] }) }],
    ['EXPIRED_BEFORE_CANONICALIZATION', { lockedFacts: facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }), canonicalWrite: null }],
    ['NOT_CANONICALIZABLE', { companyParse: { status: 'INVALID', reasonCode: 'COMPANY_IDENTITY_INVALID' }, canonicalWrite: null }],
    ['CANONICALIZED', {}],
  ] as const)('emits exact %s and approved CANONICALIZED/terminal columns', async (outcome, change) => {
    const module = await load();
    const row = module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([candidate(change as Record<string, unknown>)])).items[0]!;
    expect(row).toMatchObject({ outcome, queryItemId: UUID.queryItem, rawRecordId: UUID.raw,
      rawGovernedSubjectId: UUID.rawSubject, ...(outcome === 'CANONICALIZED' ? canonical() : terminal(outcome)) });
  });

  it('locks existing > Q terminal > restriction > suppression > reuse > expiry > invalid > canonicalized', async () => {
    const module = await load();
    const reuse = canonical({ mutationClass: 'REUSED' });
    const vectors = [
      [candidate({ exactExistingOutcome: storedOutcome('RAW_REJECTED', { qIngestStatus: 'REJECTED' }), qItem: qItem({ qIngestStatus: 'REJECTED' }),
        lockedFacts: facts({ restrictedDispositionId: UUID.disposition }) }), 'RAW_REJECTED'],
      [candidate({ qItem: qItem({ qIngestStatus: 'QUARANTINED' }), lockedFacts: facts({ restrictedDispositionId: UUID.disposition }) }), 'RAW_QUARANTINED'],
      [candidate({ lockedFacts: facts({ restrictedDispositionId: UUID.disposition, suppressionRecordIds: [UUID.disposition], rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }) }), 'RESTRICTED_PROCESSING'],
      [candidate({ lockedFacts: facts({ suppressionRecordIds: [UUID.disposition], rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }), reusableIdentity: reuse }), 'SUPPRESSED'],
      [candidate({ lockedFacts: facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }), reusableIdentity: reuse }), 'EXPIRED_BEFORE_CANONICALIZATION'],
      [candidate({ lockedFacts: facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }), canonicalWrite: null }), 'EXPIRED_BEFORE_CANONICALIZATION'],
      [candidate({ companyParse: { status: 'INVALID', reasonCode: 'COMPANY_IDENTITY_INVALID' }, canonicalWrite: null }), 'NOT_CANONICALIZABLE'],
      [candidate(), 'CANONICALIZED'],
    ] as const;
    for (const [item, outcome] of vectors)
      expect(module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([item])).items[0]).toMatchObject({ outcome });
  });

  it.each(['CREATED', 'UPDATED', 'LINKED', 'REUSED'] as const)('allows mutation class %s only for CANONICALIZED', async (mutationClass) => {
    const module = await load();
    expect(module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ canonicalWrite: canonical({ mutationClass }) }),
    ])).items[0]).toMatchObject({ outcome: 'CANONICALIZED', mutationClass });
    for (const outcome of OUTCOMES.filter((value) => value !== 'CANONICALIZED'))
      expect(terminal(outcome).mutationClass).toBeNull();
  });

  it('returns an exact existing outcome without recomputing it from changed current facts', async () => {
    const module = await load();
    const existing = Object.freeze(storedOutcome('CANONICALIZED', canonical({ mutationClass: 'LINKED' })));
    const row = module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([candidate({
      exactExistingOutcome: existing,
      lockedFacts: facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z',
        restrictedDispositionId: UUID.disposition, suppressionRecordIds: [UUID.disposition], product: null }),
      companyParse: new Proxy({}, {}), canonicalWrite: null,
    })])).items[0];
    expect(row).toEqual(existing);
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('holds contradictory Q/outcome causality and relation-index drift', async () => {
    const module = await load();
    for (const exactExistingOutcome of [
      storedOutcome('CANONICALIZED', { qIngestStatus: 'QUARANTINED' }),
      storedOutcome('RAW_REJECTED', { qIngestStatus: 'ACCEPTED' }),
      storedOutcome('CANONICALIZED', { cRelationKey: 'discovery.canonical_company:99' }),
    ]) expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ qItem: qItem({ qIngestStatus: exactExistingOutcome.qIngestStatus }),
        exactExistingOutcome }),
    ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
    expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ canonicalWrite: canonical({ cRelationKey: 'discovery.canonical_company:99' }) }),
    ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
  });
});

describe('C-TX shared manifest reuse and hostile reflection', () => {
  it('compares only shared tuple/manifest and always creates new item-specific A identity', async () => {
    const module = await load();
    const shared = { workspaceId: UUID.workspace, admissionId: UUID.admission, runId: UUID.run,
      rawRecordId: UUID.raw, identityLinkId: UUID.identityLink, canonicalCompanyId: UUID.canonical,
      contractSha256: SHA.contract, evidenceCount: 2, evidenceManifestSha256: SHA.evidence };
    const priorA = { queryItemId: '30000000-0000-4000-8000-000000000099',
      operationId: '43000000-0000-4000-8000-000000000099',
      cRelationId: '53000000-0000-4000-8000-000000000099',
      cRelationKey: 'discovery.canonical_company:99', sourceRefUuid: '30000000-0000-4000-8000-000000000099',
      recordIndex: 99, coveringBatchReceipt: true };
    const plan = module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([candidate({
      lockedFacts: facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z', product: null }),
      reusableIdentity: canonical({ mutationClass: 'REUSED' }), reusableManifestCandidates: [{ ...shared, ...priorA }],
    })]));
    expect(plan.items[0]).toMatchObject({ outcome: 'CANONICALIZED', mutationClass: 'REUSED',
      evidenceCount: 2, evidenceManifestSha256: SHA.evidence, queryItemId: UUID.queryItem,
      operationId: UUID.operation, cRelationKey: 'discovery.canonical_company:0' });
    expect(plan.items[0]).not.toMatchObject({ cRelationId: priorA.cRelationId });
    for (const mutation of [{ rawRecordId: '40000000-0000-4000-8000-000000000002' },
      { identityLinkId: '51000000-0000-4000-8000-000000000002' },
      { canonicalCompanyId: '50000000-0000-4000-8000-000000000002' }, { contractSha256: 'f'.repeat(64) },
      { evidenceCount: 1 }, { evidenceManifestSha256: 'f'.repeat(64) }, { coveringBatchReceipt: false },
      { sourceRefUuid: '30000000-0000-4000-8000-000000000098' }, { recordIndex: 98 }])
      expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
        candidate({ reusableManifestCandidates: [{ ...shared, ...priorA, ...mutation }] }),
      ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
  });

  it('enforces expiry/status, ordinal provider keys and record-index bounds', async () => {
    const module = await load();
    for (const lockedFacts of [
      facts({ rawStatus: 'EXPIRED', rawExpiredAt: null }),
      facts({ rawStatus: 'ACCEPTED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }),
      facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-02-30T00:00:00.000Z' }),
      facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00Z' }),
    ]) expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ lockedFacts }),
    ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ exactExistingOutcome: storedOutcome('EXPIRED_BEFORE_CANONICALIZATION', {
        rawExpiredAt: '2026-08-31T00:00:00Z',
      }) }),
    ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
    const punctuation = module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ qItem: qItem({ providerKey: 'a_b', queryItemId: '30000000-0000-4000-8000-000000000002' }) }),
      candidate({ qItem: qItem({ providerKey: 'a-b', queryItemId: '30000000-0000-4000-8000-000000000001' }) }),
    ]));
    expect(punctuation.items.map((item) => item.providerKey)).toEqual(['a-b', 'a_b']);
    expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ qItem: qItem({ recordIndex: 1_000_000 }) }),
    ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  });

  it('rejects open, proxy, accessor, symbol, sparse and oversized candidate shapes', async () => {
    const module = await load(); const item = candidate(); const accessor = { ...item };
    Object.defineProperty(accessor, 'qItem', { enumerable: true, get: () => qItem() });
    const sparse = new Array(2); sparse[0] = item;
    for (const value of [{ ...item, extra: true }, new Proxy(item, {}), accessor, { ...item, [Symbol('secret')]: true }])
      expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([value])))
        .toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    for (const product of [
      Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, index])),
      { oversized: 'x'.repeat(1_048_577) },
    ]) expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ lockedFacts: facts({ product }) }),
    ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    for (const items of [sparse, new Proxy([item], {}), Array.from({ length: 129 }, () => item)])
      expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch(items)))
        .toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    const parserAccessor = { status: 'VALID', dedupeKey: 'domain:acme.example' };
    Object.defineProperty(parserAccessor, 'dedupeKey', { enumerable: true, get: () => 'domain:acme.example' });
    for (const nested of [
      candidate({ exactExistingOutcome: new Proxy(storedOutcome('RAW_REJECTED'), {}) }),
      candidate({ companyParse: parserAccessor }),
      candidate({ lockedFacts: facts({ product: new Proxy({}, {}) }) }),
      candidate({ lockedFacts: facts({ product: { attributes: Array.from({ length: 1_025 }, () => 1) } }) }),
    ]) expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([nested])))
      .toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    const nearOneMiB = 'x'.repeat(900_000);
    expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch(
      Array.from({ length: 5 }, (_, index) => candidate({
        qItem: qItem({ queryItemId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }),
        lockedFacts: facts({ product: { description: nearOneMiB } }),
      })),
    ))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
      candidate({ lockedFacts: facts({ product: { ['k'.repeat(1_048_577)]: true } }) }),
    ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  });
});
