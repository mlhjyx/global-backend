import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../tools/tool-registry';
import { ToolBroker } from '../../tools/tool-broker';
import { RateLimiter } from '../../tools/rate-limiter';
import type { BudgetStore } from '../../tools/budget-store';
import type { ArtifactExecutionPort } from '../../tools/artifact-execution-port';
import type { Tool } from '../../tools/tool-contract';
import { WebsiteProfileProvider } from './website-profile.provider';

/*
 * The contact-page render goes through the real ToolBroker: under the
 * discovery.classify_trade_role task it is an allowed tool, and the per-call artifact
 * gate admits it with the canonical company's subjectRef (G3 5.1), instead of holding it
 * as CANONICAL_SUBJECT_UNAVAILABLE and silently skipping the company. Tools and the
 * artifact port are fakes; pages are synthetic `.example` content.
 */
const WORKSPACE = '00000000-0000-4000-8000-0000000000a1';
const COMPANY = '00000000-0000-4000-8000-0000000000c3';
const SUBJECT = { subjectType: 'company' as const, subjectId: COMPANY };
const SITE = 'https://pumpen-handel.example';
const PAGES: Record<string, string> = {
  [`${SITE}/`]: [
    'Ihr Pumpen-Großhandel. Autorisierter Händler und Vertriebspartner für Grundfos.',
    `[Kontakt](${SITE}/kontakt)`,
    `[Impressum](${SITE}/impressum)`,
  ].join('\n'),
  [`${SITE}/impressum`]: 'Impressum\n\nPumpen Handel GmbH',
};
const CONTACT_HTML =
  '<form><textarea></textarea><button type="submit">Absenden</button><p>Datenschutz</p></form>';

function crawlTool(id: 'crawl4ai.fetch' | 'crawl4ai.render', execute: Tool['execute']): Tool {
  const render = id === 'crawl4ai.render';
  return {
    id,
    version: '1.0.0',
    category: 'fetch',
    cost: { unit: 'page', estimatedCents: 1, external: false },
    rateLimit: { rps: 100, concurrency: 10 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: true,
      personalData: false,
      allowedPurpose: ['discovery', 'enrichment'],
      reversible: true,
      authRequired: false,
      risk: 'low',
    },
    capabilities: { produces: ['company'], accepts: ['domain'] },
    idempotencyKey: (input: unknown) => `${id}:${(input as { url: string }).url}`,
    durableResultStrategy: {
      kind: 'artifact_reference',
      schema: render ? 'crawl4ai-render/v1' : 'crawl4ai-fetch/v1',
      maxBytes: render ? 3_000_000 : 300_000,
      mediaTypes: [render ? 'text/html' : 'text/markdown'],
      privacyClass: 'PERSONAL_DATA',
      ttlSeconds: 86_400,
    },
    healthCheck: async () => ({ healthy: true }),
    execute,
  } as Tool;
}

function brokerHarness() {
  const registry = new ToolRegistry();
  registry.register(crawlTool('crawl4ai.fetch', async (input) => {
    const url = (input as { url: string }).url;
    return { data: { url, text: PAGES[url] ?? '', contentHash: 'x' }, costCents: 1 };
  }));
  registry.register(crawlTool('crawl4ai.render', async (input) => {
    const url = (input as { url: string }).url;
    return { data: { url, html: CONTACT_HTML, headers: {} }, costCents: 1 };
  }));
  const reservation = {
    workspaceId: WORKSPACE,
    accountKey: 'run',
    operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
    estimatedMicrousd: 10_000n,
    replay: false,
    authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  };
  const budgetStore = {
    reserve: vi.fn(async () => reservation),
    release: vi.fn(async () => ({ chargedMicrousd: 0n, observedMicrousd: 0n, capVariance: false, replay: false })),
    settle: vi.fn(),
  } as unknown as BudgetStore;
  const port = {
    admit: vi.fn(async (input: { subjectRef?: unknown }) => ({ status: 'BOUND' as const, subjectRef: input.subjectRef })),
    persist: vi.fn(async ({ result }: { result: { data: unknown; costCents: number } }) => ({
      data: result.data,
      costCents: result.costCents,
    })),
    replay: vi.fn(),
  };
  const broker = new ToolBroker({
    registry,
    budgetStore,
    limiter: new RateLimiter(),
    now: () => 1_000_000,
    artifactExecution: port as unknown as ArtifactExecutionPort,
  });
  return { broker, port };
}

describe('website profile contact page render through the ToolBroker (BI-14)', () => {
  it('is admitted with the canonical company subjectRef and its form reaches the profile', async () => {
    const { broker, port } = brokerHarness();
    const profile = await new WebsiteProfileProvider({ gateway: {} as never, broker }).profile(
      { domain: 'pumpen-handel.example', homeCountry: 'de', icpContext: 'Pumpen', contactPaths: true },
      { workspaceId: WORKSPACE, runId: 'run', artifactSubject: SUBJECT },
    );

    expect(port.admit.mock.calls.map(([input]) => input)).toEqual([
      { workspaceId: WORKSPACE, resultSchema: 'crawl4ai-fetch/v1', subjectRef: SUBJECT },
      { workspaceId: WORKSPACE, resultSchema: 'crawl4ai-fetch/v1', subjectRef: SUBJECT },
      { workspaceId: WORKSPACE, resultSchema: 'crawl4ai-render/v1', subjectRef: SUBJECT },
    ]);
    expect(profile?.contactPaths).toMatchObject({
      contactPage: `${SITE}/kontakt`,
      contactForm: `${SITE}/kontakt`,
      contactFormChecked: true,
    });
  });

  it('is held, like every artifact call, when the caller binds no subject', async () => {
    const { broker, port } = brokerHarness();
    await expect(
      new WebsiteProfileProvider({ gateway: {} as never, broker }).profile(
        { domain: 'pumpen-handel.example', homeCountry: 'de', icpContext: 'Pumpen', contactPaths: true },
        { workspaceId: WORKSPACE, runId: 'run' } as never,
      ),
    ).rejects.toMatchObject({ name: 'ToolPolicyDenied', reason: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD' });
    expect(port.admit).not.toHaveBeenCalled();
  });
});
