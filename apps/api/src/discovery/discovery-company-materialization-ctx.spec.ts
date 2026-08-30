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
const SHA = Object.freeze({ contract: 'a'.repeat(64), evidence: 'c'.repeat(64), suppression: 'd'.repeat(64) });

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
  return { qItem: qItem(), lockedFacts: facts(), exactExistingOutcome: null,
    reusableIdentity: null, reusableManifestCandidates: [],
    companyParse: { status: 'VALID', dedupeKey: 'domain:acme.example' },
    canonicalWrite: canonical(), ...overrides };
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
    const first = module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch(items));
    expect(first.items).toHaveLength(128); expect(first.batchOrdinal).toBe(0);
    expect(first.firstItemKey).toBe('public_web:0:40000000-0000-4000-8000-000000000130:30000000-0000-4000-8000-000000000001');
    expect(first.lastItemKey).not.toBeNull(); expect(first.itemSetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toHaveProperty('nextRawRecordId'); expect(first).not.toHaveProperty('afterRawRecordId');
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.items)).toBe(true);
    expect(module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch(items, { batchOrdinal: 1 })).items).toHaveLength(2);
  });

  it('represents a zero-item query without inventing one physical batch', async () => {
    const module = await load();
    expect(module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([]))).toMatchObject({
      batchOrdinal: 0, firstItemKey: null, lastItemKey: null, items: [],
    });
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
      [candidate({ exactExistingOutcome: { outcome: 'RAW_REJECTED', queryItemId: UUID.queryItem, contractSha256: SHA.contract }, qItem: qItem({ qIngestStatus: 'QUARANTINED' }) }), 'RAW_REJECTED'],
      [candidate({ qItem: qItem({ qIngestStatus: 'QUARANTINED' }), lockedFacts: facts({ restrictedDispositionId: UUID.disposition }) }), 'RAW_QUARANTINED'],
      [candidate({ lockedFacts: facts({ restrictedDispositionId: UUID.disposition, suppressionRecordIds: [UUID.disposition], rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }) }), 'RESTRICTED_PROCESSING'],
      [candidate({ lockedFacts: facts({ suppressionRecordIds: [UUID.disposition], rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }), reusableIdentity: reuse }), 'SUPPRESSED'],
      [candidate({ lockedFacts: facts({ rawStatus: 'EXPIRED', rawExpiredAt: '2026-08-31T00:00:00.000Z' }), reusableIdentity: reuse }), 'CANONICALIZED'],
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
      coveringBatchReceipt: true };
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
      { evidenceCount: 1 }, { evidenceManifestSha256: 'f'.repeat(64) }, { coveringBatchReceipt: false }])
      expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([
        candidate({ reusableManifestCandidates: [{ ...shared, ...priorA, ...mutation }] }),
      ]))).toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
  });

  it('rejects open, proxy, accessor, symbol, sparse and oversized candidate shapes', async () => {
    const module = await load(); const item = candidate(); const accessor = { ...item };
    Object.defineProperty(accessor, 'qItem', { enumerable: true, get: () => qItem() });
    const sparse = new Array(2); sparse[0] = item;
    for (const value of [{ ...item, extra: true }, new Proxy(item, {}), accessor, { ...item, [Symbol('secret')]: true }])
      expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch([value])))
        .toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    for (const items of [sparse, new Proxy([item], {}), Array.from({ length: 129 }, () => item)])
      expect(() => module.buildDiscoveryCompanyMaterializationBatchPlanV1(batch(items)))
        .toThrow('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  });
});
