import { describe, expect, it, vi } from 'vitest';
import { FEEDBACK_EMA_ALPHA, IcpFeedbackService } from './icp-feedback.service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ICP_ID = '22222222-2222-4222-8222-222222222222';
const CTX = { workspaceId: WORKSPACE_ID, userId: 'u1', roles: [] } as never;

function makeService(state: {
  leads?: Array<{ id: string; canonicalCompanyId: string }>;
  decisions?: Array<{ leadId: string; action: string; reasonCode: string | null; createdAt: Date }>;
  companies?: Array<{ id: string; industry: string | null; country: string | null }>;
  links?: Array<{ canonicalId: string; rawRecordId: string }>;
  raws?: Array<{ id: string; sourceClass: string }>;
  sightings?: Array<{ companyId: string; channelId: string | null }>;
  channels?: Array<{ id: string; name: string }>;
  previousFamilies?: Array<{ queryFamily: string; qualityEma: number }>;
  feedbackRows?: Array<Record<string, unknown>>;
} = {}) {
  const written = { feedback: [] as Array<Record<string, unknown>>, performance: [] as Array<Record<string, unknown>> };
  const tx = {
    lead: { findMany: vi.fn(async () => state.leads ?? []) },
    leadDecision: { findMany: vi.fn(async () => state.decisions ?? []) },
    canonicalCompany: { findMany: vi.fn(async () => state.companies ?? []) },
    identityLink: { findMany: vi.fn(async () => state.links ?? []) },
    rawSourceRecord: { findMany: vi.fn(async () => state.raws ?? []) },
    companyChannelSighting: { findMany: vi.fn(async () => state.sightings ?? []) },
    sourceChannel: { findMany: vi.fn(async () => state.channels ?? []) },
    icpFeedback: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        written.feedback.push(data);
        return data;
      }),
      findMany: vi.fn(async () => state.feedbackRows ?? []),
    },
    icpQueryPerformance: {
      findMany: vi.fn(async () => state.previousFamilies ?? []),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        written.performance.push(create);
        return create;
      }),
    },
  };
  const prisma = { withWorkspace: async <T>(_ws: string, fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx) };
  return { service: new IcpFeedbackService(prisma as never), tx, written };
}

const NOW = new Date('2026-11-04T06:00:00Z');

describe('M2 反馈闭环：聚合重算', () => {
  it('aggregates accept/reject by industry, country, source and channel with reason counts', async () => {
    const { service, written } = makeService({
      leads: [
        { id: 'l1', canonicalCompanyId: 'c1' },
        { id: 'l2', canonicalCompanyId: 'c2' },
        { id: 'l3', canonicalCompanyId: 'c1' },
      ],
      decisions: [
        { leadId: 'l1', action: 'reject', reasonCode: 'WRONG_INDUSTRY', createdAt: NOW },
        { leadId: 'l2', action: 'accept', reasonCode: null, createdAt: NOW },
        { leadId: 'l3', action: 'accept', reasonCode: null, createdAt: NOW },
      ],
      companies: [
        { id: 'c1', industry: 'industrial pumps', country: 'DE' },
        { id: 'c2', industry: 'valves', country: 'AT' },
      ],
      links: [
        { canonicalId: 'c1', rawRecordId: 'r1' },
        { canonicalId: 'c2', rawRecordId: 'r2' },
      ],
      raws: [
        { id: 'r1', sourceClass: 'public_web' },
        { id: 'r2', sourceClass: 'trade_fair' },
      ],
      sightings: [{ companyId: 'c1', channelId: 'ch1' }],
      channels: [{ id: 'ch1', name: 'Hannover Messe' }],
    });

    const result = await service.recompute(CTX, ICP_ID);
    expect(result.dimensions).toBeGreaterThanOrEqual(6);
    const byKey = new Map(
      written.feedback.map((row) => [`${row.dimension}:${row.dimensionKey}`, row]),
    );
    expect(byKey.get('industry:industrial pumps')).toMatchObject({ accepted: 1, rejected: 1 });
    expect(byKey.get('country:DE')).toMatchObject({ rejected: 1, reasonCounts: { WRONG_INDUSTRY: 1 } });
    expect(byKey.get('source:public_web')).toMatchObject({ accepted: 1, rejected: 1 });
    expect(byKey.get('channel:Hannover Messe')).toMatchObject({ rejected: 1 });
    const publicWebFamily = written.performance.find((row) => row.queryFamily === 'source:public_web');
    expect(publicWebFamily).toMatchObject({ samples: 2, accepted: 1 });
  });

  it('blends the previous EMA with the fresh acceptance rate', async () => {
    const { service, written } = makeService({
      leads: [{ id: 'l1', canonicalCompanyId: 'c1' }],
      decisions: [{ leadId: 'l1', action: 'accept', reasonCode: null, createdAt: NOW }, { leadId: 'l1', action: 'accept', reasonCode: null, createdAt: new Date('2026-11-04T05:00:00Z') }],
      companies: [{ id: 'c1', industry: 'pumps', country: 'DE' }],
      links: [{ canonicalId: 'c1', rawRecordId: 'r1' }],
      raws: [{ id: 'r1', sourceClass: 'public_web' }],
      previousFamilies: [{ queryFamily: 'source:public_web', qualityEma: 0.8 }],
    });
    await service.recompute(CTX, ICP_ID);
    const row = written.performance.find((entry) => entry.queryFamily === 'source:public_web')!;
    // latest decision wins → rate 1; EMA = 0.3*1 + 0.7*0.8
    expect(row.qualityEma as number).toBeCloseTo(FEEDBACK_EMA_ALPHA + (1 - FEEDBACK_EMA_ALPHA) * 0.8, 4);
  });
});

describe('M2 反馈闭环：建议卡与规划加权', () => {
  it('suggests removing a zero-accept industry and doubling down on a strong channel', async () => {
    const { service } = makeService({
      feedbackRows: [
        { dimension: 'industry', dimensionKey: 'textiles', accepted: 0, rejected: 6, reasonCounts: { WRONG_INDUSTRY: 6 } },
        { dimension: 'channel', dimensionKey: 'Hannover Messe', accepted: 4, rejected: 1, reasonCounts: {} },
        { dimension: 'country', dimensionKey: 'DE', accepted: 1, rejected: 1, reasonCounts: {} },
      ],
    });
    const report = await service.suggestions(CTX, ICP_ID);
    expect(report.suggestions.map((card) => card.type)).toEqual([
      'industry_zero_accept',
      'channel_strong_segment',
    ]);
    expect(report.suggestions[0]!.message).toContain('textiles');
  });

  it('formats a planner note only when enough samples exist', async () => {
    const empty = makeService();
    await expect(empty.service.plannerNote(CTX, ICP_ID)).resolves.toBeNull();
    const withData = makeService({
      previousFamilies: [
        { queryFamily: 'source:public_web', qualityEma: 0.2 },
        { queryFamily: 'source:trade_fair', qualityEma: 0.9 },
      ],
    });
    // plannerNote reads icpQueryPerformance.findMany with samples>=5 — the fake returns previousFamilies
    const note = await withData.service.plannerNote(CTX, ICP_ID);
    expect(note).toContain('source:trade_fair');
    expect(note).toContain('90%');
  });
});
