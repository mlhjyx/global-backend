import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../model-gateway/model-gateway';
import {
  collectGroundedFitEvidence,
  IdentityGroupLeadConflictError,
  judgeFitCompany,
  upsertLeadFit,
  validateGroundedFitOutput,
  type FitFieldEvidence,
} from './fit-judge';
import { organizationIdentitySnapshotFingerprint } from './organization-identity-root';

const company = {
  id: 'company-1',
  name: 'Evidence GmbH',
  domain: 'evidence.example',
  country: 'DE',
  industry: null,
  attributes: { wikidata_qid: 'Q123' },
};

const icp = {
  seller: 'Seller GmbH',
  seller_summary: null,
  icp_name: 'German metal manufacturers',
  company_attributes: { industry: 'metal fabrication' },
  target_markets: ['Germany'],
};

function evidence(overrides: Partial<FitFieldEvidence> = {}): FitFieldEvidence {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    field: 'wikidata.industries',
    value: ['metal fabrication'],
    providerKey: 'wikidata',
    allowedActions: ['display', 'match'],
    fetchedAt: new Date('2026-08-12T00:00:00.000Z'),
    ...overrides,
  };
}

describe('fit judge evidence grounding', () => {
  it('returns deterministic weak without a model call when only identity metadata exists', async () => {
    const generateStructured = vi.fn();
    const result = await judgeFitCompany(
      { generateStructured } as unknown as ModelGateway,
      'workspace-1',
      icp,
      { ...company, evidence: [evidence({ field: 'attributes', value: { wikidata_qid: 'Q123' } })] },
    );

    expect(generateStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      verdict: 'weak',
      fitReasons: { evidence_status: 'insufficient', evidence_refs: [] },
    });
  });

  it('extracts only match-authorized, fit-relevant evidence into the model packet', () => {
    const packet = collectGroundedFitEvidence([
      evidence(),
      evidence({ id: '22222222-2222-4222-8222-222222222222', field: 'wikidata.products', value: ['steel monopiles'] }),
      evidence({ id: '33333333-3333-4333-8333-333333333333', field: 'domain', value: 'evidence.example' }),
      evidence({ id: '44444444-4444-4444-8444-444444444444', field: 'wikidata.products', value: ['private'], allowedActions: ['display'] }),
    ]);

    expect(packet).toHaveLength(2);
    expect(packet.map((item) => item.field)).toEqual(['wikidata.industries', 'wikidata.products']);
  });

  it('把结构化发现的行业命中原因作为可引用证据', () => {
    const packet = collectGroundedFitEvidence([
      evidence({
        field: 'attributes',
        value: {
          wikidata_qid: 'Q123',
          discovery_match: {
            industries: ['electronics'],
            industry_qids: ['Q11650'],
          },
        },
      }),
    ]);

    expect(packet).toEqual([
      expect.objectContaining({
        field: 'attributes.discovery_match.industries',
        value: ['electronics'],
        supports: ['role'],
      }),
    ]);
  });

  it('不把空字符串或空数组包装成资格证据', () => {
    const packet = collectGroundedFitEvidence([
      evidence({
        field: 'attributes',
        value: {
          discovery_match: { industries: [], products: ['   '] },
        },
      }),
      evidence({
        id: '22222222-2222-4222-8222-222222222222',
        field: 'wikidata.business_model',
        value: '   ',
      }),
    ]);

    expect(packet).toEqual([]);
  });

  it('官网 Product JSON-LD 只证明产品与角色，不擅自推断工艺或商业模式', () => {
    const packet = collectGroundedFitEvidence([
      evidence({
        providerKey: 'digital_footprint',
        field: 'digital_footprint.structured_products',
        value: ['Laser Cutting Machine X1'],
      }),
    ]);

    expect(packet).toEqual([
      expect.objectContaining({
        field: 'digital_footprint.structured_products',
        value: ['Laser Cutting Machine X1'],
        supports: ['material', 'role'],
      }),
    ]);
    expect(packet[0]?.supports).not.toContain('process');
    expect(packet[0]?.supports).not.toContain('business_model');
  });

  it('只有明确的 process、capability 或 manufacturing_process 字段才支持工艺门', () => {
    const packet = collectGroundedFitEvidence([
      evidence({ field: 'wikidata.processes', value: ['welding'] }),
      evidence({ id: '22222222-2222-4222-8222-222222222222', field: 'official.capabilities', value: ['five-axis machining'] }),
      evidence({ id: '33333333-3333-4333-8333-333333333333', field: 'official.manufacturing_process', value: 'powder coating' }),
    ]);

    expect(packet.map((item) => item.supports)).toEqual([['process'], ['process'], ['process']]);
  });

  it('rejects a match when a passed gate has no supporting source reference', () => {
    const packet = collectGroundedFitEvidence([
      evidence(),
      evidence({ id: '22222222-2222-4222-8222-222222222222', field: 'wikidata.products', value: ['steel monopiles'] }),
      evidence({ id: '33333333-3333-4333-8333-333333333333', field: 'wikidata.processes', value: ['welding'] }),
    ]);
    const refs = packet.map((item) => item.ref);

    expect(() =>
      validateGroundedFitOutput(
        {
          verdict: 'match',
          material_gate: 'pass',
          role_gate: 'pass',
          process_gate: 'pass',
          business_model_gate: 'pass',
          reasons: ['符合'],
          evidence_refs: {
            material: [refs[1]],
            role: [refs[0]],
            process: [refs[2]],
            business_model: [],
          },
        },
        packet,
      ),
    ).toThrow(/business_model.*evidence/i);
  });

  it('does not spend a model call when source evidence covers only part of the four gates', async () => {
    const generateStructured = vi.fn();
    const result = await judgeFitCompany(
      { generateStructured } as unknown as ModelGateway,
      'workspace-1',
      icp,
      {
        ...company,
        evidence: [
          evidence(),
          evidence({ id: '22222222-2222-4222-8222-222222222222', field: 'wikidata.products', value: ['steel monopiles'] }),
        ],
      },
    );

    expect(generateStructured).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      verdict: 'weak',
      fitReasons: {
        evidence_status: 'insufficient',
        role: 'unclear：已有部分来源证据，但不足以确认通过',
        gate_evidence_refs: { business_model: [] },
      },
    });
  });

  it('passes a grounded weak judgment through the model path and preserves evidence refs', async () => {
    const rows = [
      evidence(),
      evidence({ id: '22222222-2222-4222-8222-222222222222', field: 'wikidata.materials', value: ['steel'] }),
      evidence({ id: '33333333-3333-4333-8333-333333333333', field: 'wikidata.processes', value: ['welding'] }),
      evidence({ id: '44444444-4444-4444-8444-444444444444', field: 'wikidata.business_model', value: 'manufacturer with own production' }),
    ];
    const packet = collectGroundedFitEvidence(rows);
    const generateStructured = vi.fn(async (input: { prompt: string; validateOutput?: (data: unknown) => void }) => {
      const data = {
        verdict: 'weak',
        material_gate: 'pass：材质证据显示钢材',
        role_gate: 'pass：行业证据显示制造业',
        process_gate: 'pass：工艺证据显示焊接',
        business_model_gate: 'pass：商业模式证据显示自有生产',
        reasons: ['四门均有来源证据，但仍需结合 ICP 判断'],
        evidence_refs: {
          material: [packet[1].ref],
          role: [packet[0].ref],
          process: [packet[2].ref],
          business_model: [packet[3].ref],
        },
      };
      input.validateOutput?.(data);
      return { data, provider: 'gateway', model: 'gemini-3.5-flash' };
    });

    const result = await judgeFitCompany(
      { generateStructured } as unknown as ModelGateway,
      'workspace-1',
      icp,
      { ...company, evidence: rows },
    );

    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      verdict: 'weak',
      fitReasons: { evidence_status: 'grounded', evidence_refs: expect.arrayContaining(packet.map((item) => item.ref)) },
    });
    const prompt = generateStructured.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain('wikidata.industries');
    expect(prompt).toContain('metal fabrication');
    expect(prompt).not.toContain('wikidata_qid');
  });
});

describe('identity-group Lead fit projection', () => {
  const identityFingerprint = organizationIdentitySnapshotFingerprint({
    rootCompanyId: 'root-b',
    relatedCompanyIds: ['alias-a', 'root-b'],
    identifiers: [],
  });
  const judgment = {
    verdict: 'match' as const,
    fitReasons: {
      material: 'pass',
      role: 'pass',
      process: 'pass',
      business_model: 'pass',
      reasons: ['grounded'],
    },
  };

  it('updates the unique alias Lead instead of creating a second root Lead', async () => {
    const update = vi.fn(async () => ({}));
    const upsert = vi.fn(async () => ({}));
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => []),
      organizationCanonicalMapping: {
        findFirst: async () => null,
        findMany: async () => [{ sourceCompanyId: 'alias-a', canonicalCompanyId: 'root-b' }],
      },
      organizationIdentifier: { findMany: async () => [] },
      organizationIdentityConflictParty: { count: async () => 0 },
      canonicalCompany: {
        findMany: async () => [
          { id: 'alias-a', name: 'Alias', domain: 'alias.test', status: 'ENRICHED' },
          { id: 'root-b', name: 'Root', domain: 'root.test', status: 'ENRICHED' },
        ],
      },
      suppressionRecord: { findMany: async () => [] },
      lead: {
        findMany: async () => [{ id: 'lead-a', canonicalCompanyId: 'alias-a' }],
        update,
        upsert,
      },
    };

    await upsertLeadFit(tx as never, 'workspace-1', 'icp-x', 'root-b', judgment, identityFingerprint);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'lead-a' },
      data: expect.objectContaining({ fitVerdict: 'match', version: { increment: 1 } }),
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('fails closed when one identity group already has multiple Leads for the same ICP', async () => {
    const update = vi.fn();
    const upsert = vi.fn();
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => []),
      organizationCanonicalMapping: {
        findFirst: async () => null,
        findMany: async () => [{ sourceCompanyId: 'alias-a', canonicalCompanyId: 'root-b' }],
      },
      organizationIdentifier: { findMany: async () => [] },
      organizationIdentityConflictParty: { count: async () => 0 },
      canonicalCompany: {
        findMany: async () => [
          { id: 'alias-a', name: 'Alias', domain: 'alias.test', status: 'ENRICHED' },
          { id: 'root-b', name: 'Root', domain: 'root.test', status: 'ENRICHED' },
        ],
      },
      suppressionRecord: { findMany: async () => [] },
      lead: {
        findMany: async () => [
          { id: 'lead-a', canonicalCompanyId: 'alias-a' },
          { id: 'lead-b', canonicalCompanyId: 'root-b' },
        ],
        update,
        upsert,
      },
    };

    await expect(upsertLeadFit(tx as never, 'workspace-1', 'icp-x', 'root-b', judgment, identityFingerprint)).rejects.toBeInstanceOf(
      IdentityGroupLeadConflictError,
    );
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
