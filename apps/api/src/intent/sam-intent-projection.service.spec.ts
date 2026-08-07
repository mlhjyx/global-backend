import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { provisionalReviewCanonicalKey } from '../discovery/identity';
import {
  SAM_DISCLAIMER,
  SAM_LICENSE,
  SamIntentProjectionService,
  SOURCES_SOUGHT_STRENGTH,
  US_FED_SOURCES_SOUGHT,
  naicsOverlap,
} from './sam-intent-projection.service';
import { mergeIntent, type IntentAttr } from './intent-projection.service';

const WS = 'ws-1';
const DAY_MS = 86_400_000;
const NOW = new Date('2026-08-08T00:00:00.000Z');

interface SamSignal {
  id: string;
  providerKey: string;
  signalType: string;
  externalId: string;
  subjectName: string;
  subjectCountry: string;
  subjectKey: string;
  taxonomyKeys: string[];
  strength: number;
  occurredAt: Date;
  observedAt: Date;
  payload: Record<string, unknown>;
  license: string;
  jurisdiction: string;
  status: string;
  expiresAt: Date;
}

function samSignal(
  over: Partial<SamSignal> & { subjectKey: string; occurredAt: Date },
): SamSignal {
  return {
    id: over.id ?? `sig-${over.subjectKey}-${over.occurredAt.getTime()}`,
    providerKey: over.providerKey ?? 'samgov',
    signalType: over.signalType ?? US_FED_SOURCES_SOUGHT,
    externalId: over.externalId ?? `notice-${over.occurredAt.getTime()}`,
    subjectName: over.subjectName ?? over.subjectKey,
    subjectCountry: 'US',
    subjectKey: over.subjectKey,
    taxonomyKeys: over.taxonomyKeys ?? ['naics:333914'],
    strength: SOURCES_SOUGHT_STRENGTH,
    occurredAt: over.occurredAt,
    observedAt: over.observedAt ?? over.occurredAt,
    payload: over.payload ?? {
      naics: ['333914'],
      notice: over.externalId ?? `notice-${over.occurredAt.getTime()}`,
    },
    license: SAM_LICENSE,
    jurisdiction: 'US',
    status: over.status ?? 'ACTIVE',
    expiresAt: over.expiresAt ?? new Date(over.occurredAt.getTime() + 120 * DAY_MS),
  };
}

interface FakeCompany {
  id: string;
  workspaceId: string;
  dedupeKey: string;
  name: string;
  country: string;
  status: string;
  attributes: Record<string, unknown>;
  version: number;
}

function fakeSamPrisma(signals: SamSignal[]) {
  const companies = new Map<string, FakeCompany>();
  const evidence: Record<string, unknown>[] = [];
  const upsert = vi.fn(
    async ({ where, create, update }: {
      where: { workspaceId_dedupeKey: { dedupeKey: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = where.workspaceId_dedupeKey.dedupeKey;
      const prior = companies.get(key);
      if (prior) {
        const next = {
          ...prior,
          attributes: update.attributes as Record<string, unknown>,
          version: prior.version + 1,
        };
        companies.set(key, next);
        return { id: next.id };
      }
      const created: FakeCompany = {
        id: `co-${companies.size}`,
        workspaceId: WS,
        dedupeKey: key,
        name: create.name as string,
        country: create.country as string,
        status: create.status as string,
        attributes: create.attributes as Record<string, unknown>,
        version: 1,
      };
      companies.set(key, created);
      return { id: created.id };
    },
  );
  const fieldEvidenceCreate = vi.fn(
    async ({ data }: { data: Record<string, unknown> }) => {
      evidence.push(data);
      return { id: `fe-${evidence.length}` };
    },
  );
  const tx = {
    canonicalCompany: {
      findUnique: async ({ where }: {
        where: { workspaceId_dedupeKey: { dedupeKey: string } };
      }) => companies.get(where.workspaceId_dedupeKey.dedupeKey) ?? null,
      upsert,
    },
    fieldEvidence: { create: fieldEvidenceCreate },
  };
  const sourceSignalFindMany = vi.fn(
    async ({ where, take, cursor, skip }: {
      where: {
        providerKey: string;
        signalType: string;
        status: string;
        occurredAt: { gte: Date };
      };
      take: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      const rows = signals
        .filter(
          (signal) =>
            signal.providerKey === where.providerKey &&
            signal.signalType === where.signalType &&
            signal.status === where.status &&
            signal.occurredAt.getTime() >= where.occurredAt.gte.getTime(),
        )
        .sort(
          (a, b) =>
            b.occurredAt.getTime() - a.occurredAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
      const cursorIndex = cursor
        ? rows.findIndex((signal) => signal.id === cursor.id)
        : -1;
      const start = cursor ? (cursorIndex < 0 ? rows.length : cursorIndex + (skip ?? 0)) : 0;
      return rows.slice(start, start + take);
    },
  );
  const withWorkspace = vi.fn(
    async (_workspaceId: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  );
  const prisma = {
    sourceSignal: { findMany: sourceSignalFindMany },
    withWorkspace,
  } as unknown as PrismaService;
  return {
    prisma,
    companies,
    evidence,
    upsert,
    fieldEvidenceCreate,
    sourceSignalFindMany,
    withWorkspace,
  };
}

describe('naicsOverlap', () => {
  it('matches exact and bidirectional NAICS subtrees without matching other namespaces', () => {
    expect(naicsOverlap('333914', 'naics:333914')).toBe(true);
    expect(naicsOverlap('3339', 'naics:333914')).toBe(true);
    expect(naicsOverlap('333914', 'naics:3339')).toBe(true);
    expect(naicsOverlap('3339', 'naics:541330')).toBe(false);
    expect(naicsOverlap('3339', 'cpv:333914')).toBe(false);
    expect(naicsOverlap('', 'naics:333914')).toBe(false);
    expect(naicsOverlap('3339', 'naics:   ')).toBe(false);
  });
});

describe('SamIntentProjectionService', () => {
  it('returns without scanning when SAM has no enabled NAICS scope', async () => {
    const fake = fakeSamPrisma([
      samSignal({ subjectKey: 'agency-a', occurredAt: NOW }),
    ]);

    const result = await new SamIntentProjectionService({
      prisma: fake.prisma,
    }).projectSourcesSought(WS, { naicsCodes: [] });

    expect(result).toEqual({
      signalsMatched: 0,
      companiesTouched: 0,
      eventsProjected: 0,
      subjectsTruncated: 0,
    });
    expect(fake.sourceSignalFindMany).not.toHaveBeenCalled();
    expect(fake.withWorkspace).not.toHaveBeenCalled();
  });

  it('does not project disabled, non-SAM, or non-overlapping signals', async () => {
    const fake = fakeSamPrisma([
      samSignal({ subjectKey: 'expired', occurredAt: NOW, status: 'EXPIRED' }),
      samSignal({ subjectKey: 'revoked', occurredAt: NOW, status: 'REVOKED' }),
      samSignal({ subjectKey: 'other-provider', occurredAt: NOW, providerKey: 'ted' }),
      samSignal({
        subjectKey: 'other-signal',
        occurredAt: NOW,
        signalType: 'TENDER_PUBLISHED',
      }),
      samSignal({
        subjectKey: 'other-naics',
        occurredAt: NOW,
        taxonomyKeys: ['naics:541330'],
      }),
    ]);

    const result = await new SamIntentProjectionService({
      prisma: fake.prisma,
    }).projectSourcesSought(WS, { naicsCodes: ['3339'] });

    expect(result.signalsMatched).toBe(0);
    expect(result.companiesTouched).toBe(0);
    expect(fake.withWorkspace).not.toHaveBeenCalled();
    expect(fake.sourceSignalFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerKey: 'samgov',
          signalType: US_FED_SOURCES_SOUGHT,
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('collapses duplicate agency signals to the newest event and stays idempotent', async () => {
    const older = new Date(NOW.getTime() - 10 * DAY_MS);
    const newer = new Date(NOW.getTime() - DAY_MS);
    const fake = fakeSamPrisma([
      samSignal({
        subjectKey: 'agency-a',
        subjectName: 'Agency A',
        occurredAt: older,
        externalId: 'notice-old',
      }),
      samSignal({
        subjectKey: 'agency-a',
        subjectName: 'Agency A',
        occurredAt: newer,
        externalId: 'notice-new',
      }),
    ]);
    const service = new SamIntentProjectionService({ prisma: fake.prisma });

    const first = await service.projectSourcesSought(WS, {
      naicsCodes: ['3339'],
    });

    expect(first).toMatchObject({
      signalsMatched: 2,
      companiesTouched: 1,
      eventsProjected: 1,
    });
    expect(fake.companies).toHaveLength(1);
    const company = [...fake.companies.values()][0];
    expect(company.attributes).toMatchObject({
      government_buyer: true,
      sam_market_signal: true,
      sam_disclaimer: SAM_DISCLAIMER,
    });
    expect((company.attributes.intent as IntentAttr).events).toEqual([
      expect.objectContaining({
        type: US_FED_SOURCES_SOUGHT,
        at: newer.toISOString(),
        evidence: expect.objectContaining({ notice: 'notice-new' }),
      }),
    ]);
    expect(fake.evidence.map((item) => item.field).sort()).toEqual([
      'identity',
      'identity.resolution_decision',
      'intent.sources_sought',
    ]);

    const version = company.version;
    const evidenceCount = fake.evidence.length;
    const second = await service.projectSourcesSought(WS, {
      naicsCodes: ['3339'],
    });

    expect(second.companiesTouched).toBe(0);
    expect(second.eventsProjected).toBe(0);
    expect([...fake.companies.values()][0].version).toBe(version);
    expect(fake.evidence).toHaveLength(evidenceCount);
  });

  it('preserves cross-source intent while licensing only the SAM event subset as SAM evidence', async () => {
    const signal = samSignal({
      subjectKey: 'agency-b',
      subjectName: 'Agency B',
      occurredAt: NOW,
      externalId: 'notice-b',
    });
    const fake = fakeSamPrisma([signal]);
    const reviewKey = provisionalReviewCanonicalKey(`samgov:${signal.subjectKey}`);
    const priorIntent = mergeIntent(undefined, [
      {
        type: 'TENDER_PUBLISHED',
        at: new Date(NOW.getTime() - DAY_MS).toISOString(),
        strength: 0.9,
        evidence: { notice: 'ted-1', source: 'ted' },
      },
    ]);
    fake.companies.set(reviewKey, {
      id: 'co-existing',
      workspaceId: WS,
      dedupeKey: reviewKey,
      name: 'Agency B',
      country: 'US',
      status: 'NEW',
      attributes: { intent: priorIntent, retained: 'yes' },
      version: 4,
    });

    const result = await new SamIntentProjectionService({
      prisma: fake.prisma,
    }).projectSourcesSought(WS, { naicsCodes: ['333914'] });

    expect(result.companiesTouched).toBe(1);
    const saved = fake.companies.get(reviewKey)!;
    expect(saved.attributes.retained).toBe('yes');
    expect(
      (saved.attributes.intent as IntentAttr).events.map((event) => event.type),
    ).toEqual([US_FED_SOURCES_SOUGHT, 'TENDER_PUBLISHED']);
    expect(fake.evidence).toHaveLength(1);
    expect(fake.evidence[0]).toMatchObject({
      field: 'intent.sources_sought',
      providerKey: 'samgov',
      license: SAM_LICENSE,
      value: {
        events: [expect.objectContaining({ type: US_FED_SOURCES_SOUGHT })],
      },
    });
    expect(JSON.stringify(fake.evidence[0])).not.toContain('TENDER_PUBLISHED');
  });

  it('does not revive a suppressed review or legacy canonical', async () => {
    const signal = samSignal({ subjectKey: 'agency-c', occurredAt: NOW });
    const reviewKey = provisionalReviewCanonicalKey(`samgov:${signal.subjectKey}`);
    const fake = fakeSamPrisma([signal]);
    fake.companies.set(reviewKey, {
      id: 'co-suppressed',
      workspaceId: WS,
      dedupeKey: reviewKey,
      name: 'Agency C',
      country: 'US',
      status: 'SUPPRESSED',
      attributes: {},
      version: 1,
    });

    const result = await new SamIntentProjectionService({
      prisma: fake.prisma,
    }).projectSourcesSought(WS, { naicsCodes: ['3339'] });

    expect(result.companiesTouched).toBe(0);
    expect(fake.upsert).not.toHaveBeenCalled();
    expect(fake.fieldEvidenceCreate).not.toHaveBeenCalled();
  });
});
