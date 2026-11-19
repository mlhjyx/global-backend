import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker } from '../tools/tool-contract';
import type { JudgeOutputV2 } from './judgment/judge-output-v2';

vi.mock('../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));

import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { PublicWebDiscoveryProvider } from './providers/public-web.provider';
import { WebsiteProfileProvider } from './providers/website-profile.provider';
import { prepareRawSourceBatch } from './raw-source-ingestion';
import { mergeCanonicalCompanyAttributes } from './canonical-company-attributes';
import { websiteProfileEnrichment } from '../temporal/discovery.activities';
import { buyerProcurementCriteria, prepareBuyerScenarioQueries, type BuyerProcurementScenario } from './buyer-procurement-scenarios';
import { prefilterCompany } from './run2/quick-scan';
import { prepareJudgeCall, runJudgeModel } from './judgment/judge-run';
import { REQUIRED_PROCUREMENT_CRITERIA, CRITERION_IDS } from './judgment/fit-rubric';
import { judgeFitCompany } from './fit-judge';

// Synthetic transport/model responses exercise the real processing modules.
// No HTTP, database, paid dispatch, or live CANONICALIZED receipt is produced.
const NOW = '2026-11-15T12:00:00.000Z';
const WS = '10000000-0000-4000-8000-000000000001';
const DOMAIN = 'pump-buyer.example';
const USE = 'Wir setzen Kreiselpumpen zur Förderung von Prozesswasser in unserer Anlage ein.';
const FIXTURES: Array<{ scenario: BuyerProcurementScenario; home: string; role: string }> = [
  { scenario: 'distribution', role: 'distributor', home: 'Großhandel und Fachhandel: Als Händler und Vertriebspartner liefern wir Kreiselpumpen ab Lager.' },
  { scenario: 'factory_direct', role: 'manufacturer', home: `Hersteller mit eigener Produktion und Fertigung am Produktionsstandort Deutschland.\n${USE}` },
  { scenario: 'equipment_integration', role: 'other', home: 'Unser Ingenieurbüro übernimmt Pumpenauslegung, Auswahl der Kreiselpumpen und Systemintegration.' },
];
const executeTask = vi.mocked(executeStructuredTaskWithRuntime);
beforeEach(() => executeTask.mockReset());

function output(span: string, url = `https://${DOMAIN}/`): JudgeOutputV2 {
  return {
    criteria: CRITERION_IDS.map((id) => ({
      id, applicable: id !== 'C5_SIZE', score: id === 'C5_SIZE' ? null : 8,
      label: id === 'C5_SIZE' ? 'not_applicable' : 'pass',
      evidence: id === 'C5_SIZE' ? [] : [{ kind: 'website', url, span, fetched_at: NOW }],
      rationale: 'Deterministic test response; does not establish business fit.',
    })),
    evidence_completeness: true, verdict_proposed: 'FIT',
    refusal: { is_refusal: false, reason: null },
  };
}

async function rehearse(fixture: typeof FIXTURES[number]) {
  const observations: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const broker = {
    checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
    invoke: vi.fn(async (tool: string, input: Record<string, unknown>) => {
      observations.push({ tool, input });
      if (tool === 'searxng.search') return { data: { results: [{ url: `https://${DOMAIN}/`, title: `Pump Buyer GmbH: ${fixture.home}` }] }, costCents: 0 };
      if (tool === 'crawl4ai.fetch') return {
        data: { text: input.url === `https://${DOMAIN}/` ? fixture.home : 'Impressum\nPump Buyer GmbH\nDeutschland', url: input.url }, costCents: 0,
      };
      throw new Error('Unexpected rehearsal tool');
    }),
  } as unknown as ExecutionBroker;
  executeTask.mockImplementation(async (_gateway, request) => ({
    provider: 'fixture', model: 'fixture', data: request.task === 'discovery.extract_company'
      ? { is_company_site: true, name: 'Pump Buyer GmbH', country: 'Germany', products: ['industrial pumps'], keywords: ['industrial pumps'] }
      : { trade_role: fixture.role, evidence: [fixture.home], confidence: 0.9 },
  }) as never);
  const [query] = prepareBuyerScenarioQueries([{
    source_class: 'public_intelligence', filters: { country: 'DE', source_hint: 'public_web' },
    keywords: ['Industriepumpen'], priority: 1, rationale: 'Local rehearsal',
  }], fixture.scenario);
  const discovered = await new PublicWebDiscoveryProvider({ gateway: {} as never, broker })
    .discoverCompanies({ ...query!, sourceClass: 'public_intelligence', limit: 3 }, { workspaceId: WS });
  expect(discovered.records).toHaveLength(1);
  const raw = prepareRawSourceBatch({
    providerKey: 'public_web', records: discovered.records,
    policies: [{ id: 'test-policy', domain: DOMAIN, reviewStatus: 'APPROVED', retentionDays: 30, allowedPurpose: ['discovery'], updatedAt: new Date(NOW) }],
    now: new Date(NOW),
  }).rows[0]!;
  expect(raw.ingestStatus).toBe('ACCEPTED');
  const payload = raw.payload as { attributes: Record<string, unknown> };
  const profile = await new WebsiteProfileProvider({ gateway: {} as never, broker }).profile(
    { domain: DOMAIN, homeCountry: 'de', icpContext: 'industrial pumps' },
    { workspaceId: WS, artifactSubject: { subjectType: 'company', subjectId: 'company-1' } },
  );
  expect(profile).not.toBeNull();
  const enriched = websiteProfileEnrichment(profile!, new Date(NOW));
  const company = {
    id: 'company-1', name: 'Pump Buyer GmbH', domain: DOMAIN, country: 'DE', industry: null,
    attributes: mergeCanonicalCompanyAttributes(payload.attributes, { website_profile: enriched.attributes }),
  };
  expect(prefilterCompany([{ id: 'country', kind: 'MUST_HAVE', field: 'country', operator: 'eq', value: '德国' }], company).decision).toBe('candidate');
  const brief = { seller: 'Test seller', seller_summary: 'industrial pumps', procurement_scenario: buyerProcurementCriteria(fixture.scenario) };
  const prepared = prepareJudgeCall(brief, company, { now: NOW });
  expect(observations.filter(({ tool }) => tool === 'crawl4ai.fetch')).toHaveLength(2);
  expect(observations.filter(({ tool }) => tool === 'searxng.search').every(({ input }) => input.language === 'de')).toBe(true);
  return { company, brief, prepared, observations };
}

describe('procurement local module-chain rehearsal (transport and persistence replaced)', () => {
  it.each(FIXTURES)('carries fetched $scenario evidence through Raw, canonical sanitation, profile and V2', async (fixture) => {
    const { prepared } = await rehearse(fixture);
    const span = fixture.scenario === 'factory_direct' ? USE : fixture.home;
    expect(prepared.snapshotText).toContain(span);
    executeTask.mockResolvedValue({ provider: 'fixture', model: 'fixture', data: output(span) } as never);
    const judged = await runJudgeModel({} as never, WS, 'fixture', prepared);
    expect(judged.ok && judged.aggregation.verdict).toBe('FIT');
  });

  it.each(REQUIRED_PROCUREMENT_CRITERIA)('keeps factory %s missing evidence UNKNOWN', async (id) => {
    const { prepared } = await rehearse(FIXTURES[1]!);
    const response = output(USE);
    response.criteria.find((item) => item.id === id)!.evidence = [];
    executeTask.mockResolvedValue({ provider: 'fixture', model: 'fixture', data: response } as never);
    const judged = await runJudgeModel({} as never, WS, 'fixture', prepared);
    expect(judged.ok && judged.aggregation.verdict).toBe('UNKNOWN');
  });

  it('keeps supplier-domain customer evidence untrusted even if the quoted use is in the snapshot', async () => {
    const { prepared } = await rehearse(FIXTURES[1]!);
    executeTask.mockResolvedValue({ provider: 'fixture', model: 'fixture', data: output(USE, 'https://supplier.example/case') } as never);
    const judged = await runJudgeModel({} as never, WS, 'fixture', prepared);
    expect(judged.ok && judged.aggregation.verdict).toBe('UNKNOWN');
  });

  it('does not turn an unfetched own-domain case into proof', async () => {
    const { prepared, observations } = await rehearse({ ...FIXTURES[1]!, home: 'Hersteller mit eigener Produktion und Fertigung. [Projekt](https://pump-buyer.example/case)' });
    expect(observations.some(({ input }) => input.url === `https://${DOMAIN}/case`)).toBe(false);
    executeTask.mockResolvedValue({ provider: 'fixture', model: 'fixture', data: output(USE, `https://${DOMAIN}/case`) } as never);
    const judged = await runJudgeModel({} as never, WS, 'fixture', prepared);
    expect(judged.ok && judged.aggregation.verdict).toBe('UNKNOWN');
  });

  it('retains the final corroboration gate in enforce mode for website-only evidence', async () => {
    const { company, brief } = await rehearse(FIXTURES[1]!);
    executeTask.mockResolvedValue({ provider: 'fixture', model: 'fixture', data: output(USE) } as never);
    const judged = await judgeFitCompany({} as never, WS, brief, company, { judgeContractMode: 'enforce', judgePanelMode: 'off', now: NOW });
    expect(judged?.verdict).toBe('weak');
  });
});
