import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { buildRunResultView, QUALIFICATION_BATCH_SCORED_EVENT } from './run-result-view';

const RUN = {
  id: 'run-1',
  icpId: 'icp-1',
  status: 'DONE',
  completedAt: new Date('2026-11-13T00:00:00.000Z'),
};

const JOBS = [
  {
    canonicalCompanyId: 'company-1',
    stage: 'done',
    verdictQuick: 'match',
    verdictDeep: 'match',
    lastErrorCode: null,
  },
  {
    canonicalCompanyId: 'company-2',
    stage: 'failed',
    verdictQuick: 'weak',
    verdictDeep: null,
    lastErrorCode: 'PROVIDER_TIMEOUT',
  },
];

const COMPANIES = [
  { id: 'company-1', name: 'Alpha GmbH', domain: 'alpha.example', country: 'DE' },
  { id: 'company-2', name: 'Beta SAS', domain: null, country: 'FR' },
];

type FixtureOverrides = {
  run?: unknown;
  total?: number;
  jobs?: unknown[];
  companies?: unknown[];
  events?: unknown[];
  leads?: unknown[];
};

function txFixture(overrides: FixtureOverrides = {}) {
  return {
    discoveryRun: {
      findUnique: vi.fn(async () => ('run' in overrides ? overrides.run : RUN)),
    },
    discoveryCompanyJob: {
      count: vi.fn(async () => overrides.total ?? JOBS.length),
      findMany: vi.fn(async () => overrides.jobs ?? JOBS),
    },
    canonicalCompany: { findMany: vi.fn(async () => overrides.companies ?? COMPANIES) },
    runEvent: { findMany: vi.fn(async () => overrides.events ?? []) },
    lead: { findMany: vi.fn(async () => overrides.leads ?? []) },
  };
}

function asTx(tx: ReturnType<typeof txFixture>): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

function batchEvent(
  seq: number,
  payload: Record<string, unknown>,
  at = '2026-11-13T01:00:00.000Z',
) {
  return { seq: BigInt(seq), payload, at: new Date(at) };
}

describe('buildRunResultView (PR-06a)', () => {
  it('returns null when the run does not exist (caller maps to 404)', async () => {
    const tx = txFixture({ run: null });
    await expect(buildRunResultView(asTx(tx), { runId: 'missing' })).resolves.toBeNull();
  });

  it('joins candidates with canonical company facts and reports truncation from the full count', async () => {
    const tx = txFixture({ total: 502 });
    const view = await buildRunResultView(asTx(tx), { runId: RUN.id });

    expect(view).toMatchObject({
      runId: RUN.id,
      icpId: RUN.icpId,
      status: 'DONE',
      completedAt: '2026-11-13T00:00:00.000Z',
      candidates: {
        total: 502,
        truncated: true,
        items: [
          {
            companyId: 'company-1',
            name: 'Alpha GmbH',
            domain: 'alpha.example',
            country: 'DE',
            stage: 'done',
            verdictQuick: 'match',
            verdictDeep: 'match',
            lastErrorCode: null,
          },
          {
            companyId: 'company-2',
            name: 'Beta SAS',
            domain: null,
            country: 'FR',
            stage: 'failed',
            lastErrorCode: 'PROVIDER_TIMEOUT',
          },
        ],
      },
    });
  });

  it('separates this-run scoring snapshots from the lead latest projection', async () => {
    const tx = txFixture({
      events: [
        batchEvent(1, {
          batchRef: 'qualify:run-1:0',
          scoredAt: '2026-11-13T01:00:00.000Z',
          items: [
            {
              companyId: 'company-1',
              leadId: 'lead-1',
              totalScore: 0.4,
              scores: { fit: 0.4 },
              queue: 'needs_review',
              fitVerdict: 'weak',
              ruleVersion: 'additive-6dim-v3',
              candidateBatchRef: 'qualify:run-1:0',
            },
          ],
        }),
        batchEvent(
          2,
          {
            batchRef: 'qualify:run-1:1',
            scoredAt: '2026-11-13T02:00:00.000Z',
            items: [
              {
                companyId: 'company-1',
                leadId: 'lead-1',
                totalScore: 0.8,
                scores: { fit: 0.8 },
                queue: 'recommended',
                fitVerdict: 'match',
                ruleVersion: 'additive-6dim-v3',
                candidateBatchRef: 'qualify:run-1:1',
              },
              {
                companyId: 'company-3',
                leadId: 'lead-3',
                totalScore: 0.6,
                scores: { fit: 0.6 },
                queue: 'needs_review',
                fitVerdict: 'weak',
                ruleVersion: 'additive-6dim-v3',
                candidateBatchRef: 'qualify:run-1:1',
              },
            ],
          },
          '2026-11-13T02:00:00.000Z',
        ),
      ],
      leads: [
        {
          id: 'lead-1',
          canonicalCompanyId: 'company-1',
          status: 'REVIEW',
          queue: 'recommended',
          totalScore: 0.9,
          scores: { fit: 0.9 },
          fitVerdict: 'match',
          scoredAt: new Date('2026-11-13T03:00:00.000Z'),
        },
      ],
    });

    const view = await buildRunResultView(asTx(tx), { runId: RUN.id });

    expect(tx.runEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: RUN.id, type: QUALIFICATION_BATCH_SCORED_EVENT },
        orderBy: { seq: 'asc' },
      }),
    );
    expect(view?.scoring.thisRun).toMatchObject({
      available: true,
      label: 'this_run',
      batches: 2,
      scoredCompanies: 2,
      truncated: false,
      scoredAt: '2026-11-13T02:00:00.000Z',
    });
    // 同一公司出现两次 → 后批覆盖（run 内最新一次计分）。
    expect(view?.scoring.thisRun.items).toEqual([
      expect.objectContaining({ companyId: 'company-1', totalScore: 0.8, queue: 'recommended' }),
      expect.objectContaining({ companyId: 'company-3', totalScore: 0.6 }),
    ]);
    // 最新分单独一列，并明确标注不一定是本 run（这里是 0.9，高于本 run 的 0.8）。
    expect(view?.scoring.latest).toEqual({
      label: 'latest_not_necessarily_this_run',
      items: [
        expect.objectContaining({
          companyId: 'company-1',
          leadId: 'lead-1',
          totalScore: 0.9,
          scoredAt: '2026-11-13T03:00:00.000Z',
        }),
      ],
    });
  });

  it('never backfills this-run scoring when the run has no batch events', async () => {
    const tx = txFixture({
      leads: [
        {
          id: 'lead-1',
          canonicalCompanyId: 'company-1',
          status: 'REVIEW',
          queue: 'needs_review',
          totalScore: 0.5,
          scores: { fit: 0.5 },
          fitVerdict: 'weak',
          scoredAt: new Date('2026-11-13T03:00:00.000Z'),
        },
      ],
    });

    const view = await buildRunResultView(asTx(tx), { runId: RUN.id });

    expect(view?.scoring.thisRun).toMatchObject({
      available: false,
      label: 'not_scored_in_run',
      batches: 0,
      scoredCompanies: 0,
      items: [],
    });
    // 最新分仍单独可见（可能来自其他触发），但不冒充本轮评分。
    expect(view?.scoring.latest.items).toHaveLength(1);
  });

  it('tolerates malformed historical payloads without failing the view', async () => {
    const tx = txFixture({
      events: [
        batchEvent(1, { items: 'not-an-array' }),
        batchEvent(2, { scoredAt: '2026-11-13T01:00:00.000Z', items: [{ companyId: 42 }] }),
      ],
    });

    const view = await buildRunResultView(asTx(tx), { runId: RUN.id });

    expect(view?.scoring.thisRun).toMatchObject({
      available: true,
      batches: 2,
      scoredCompanies: 0,
      items: [],
    });
  });
});
