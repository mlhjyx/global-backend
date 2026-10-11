import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';

const mocks = vi.hoisted(() => ({ executeStructuredTaskWithRuntime: vi.fn() }));
vi.mock('../../model-runtime/structured-task-runtime-bridge', () => ({
  executeStructuredTaskWithRuntime: mocks.executeStructuredTaskWithRuntime,
}));

import { WebsiteProfileProvider } from './website-profile.provider';
import { ToolPolicyDenied } from '../../tools/tool-broker';
import { MAX_WEBSITE_PROFILE_RENDERS_PER_COMPANY } from '../execution-envelope';

// Synthetic pages only: `.example` hosts and made-up slugs and handles; no addresses, numbers or names.
const COMPANY = '00000000-0000-4000-8000-0000000000c3';
const CTX = {
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  runId: 'run-1',
  artifactSubject: { subjectType: 'company' as const, subjectId: COMPANY },
};
const INPUT = { domain: 'pumpen-handel.example', homeCountry: 'de', icpContext: 'Pumpen' };
const IMPRESSUM = 'Impressum\n\nPumpen Handel GmbH';
const HOME = [
  'Ihr Pumpen-Großhandel. Autorisierter Händler und Vertriebspartner für Grundfos.',
  '[Kontakt](https://pumpen-handel.example/kontakt)',
  '[Service](https://pumpen-handel.example/service/kontakt)',
  '[Impressum](https://pumpen-handel.example/impressum.html)',
  '[Lieferanten](https://pumpen-handel.example/lieferanten)',
  '[LinkedIn](https://www.linkedin.com/company/pumpen-handel-example)',
  '[X](https://x.com/pumpenhandel)',
].join('\n');
const CONTACT_FORM =
  '<html><body><form method="post"><label>Firma *</label><input required>' +
  '<textarea></textarea><label><input type="checkbox"> Datenschutzerklärung gelesen</label>' +
  '<button type="submit">Absenden</button></form></body></html>';
const PAGES = {
  'https://pumpen-handel.example/': HOME,
  'https://pumpen-handel.example/impressum.html': IMPRESSUM,
};
const CONTACT_URL = 'https://pumpen-handel.example/kontakt';

type Rendered = { html: string; robotsBlocked?: boolean } | Error;

function contactBroker(pages: Record<string, string | Error>, renders: Record<string, Rendered>) {
  const invoke = vi.fn(async (toolId: string, input: unknown, ctx: ToolContext): Promise<ToolResult<unknown>> => {
    const url = (input as { url: string }).url;
    expect(ctx.artifactSubject).toEqual(CTX.artifactSubject);
    expect(ctx.taskContractId).toBe('discovery.classify_trade_role');
    expect(ctx.purpose).toEqual(['enrichment']);
    if (toolId === 'crawl4ai.render') {
      const rendered = renders[url];
      if (rendered instanceof Error) throw rendered;
      if (rendered === undefined) throw new Error('404');
      return {
        data: { url, html: rendered.html, headers: {}, robotsBlocked: rendered.robotsBlocked },
        costCents: 1,
      };
    }
    expect(toolId).toBe('crawl4ai.fetch');
    const page = pages[url];
    if (page instanceof Error) throw page;
    if (page === undefined) throw new Error('404');
    return { data: { url, text: page, contentHash: 'x' }, costCents: 1 };
  });
  return { checkSourcePolicy: vi.fn(), invoke } as unknown as ExecutionBroker & { invoke: typeof invoke };
}

function provider(executionBroker: ExecutionBroker) {
  return new WebsiteProfileProvider({ gateway: {} as never, broker: executionBroker });
}

beforeEach(() => mocks.executeStructuredTaskWithRuntime.mockReset());

describe('WebsiteProfileProvider contact paths (BI-14)', () => {
  it('renders only the linked contact page, bound to the company, and reports its links and form', async () => {
    const executionBroker = contactBroker(PAGES, { [CONTACT_URL]: { html: CONTACT_FORM } });
    const profile = await provider(executionBroker).profile({ ...INPUT, contactPaths: true }, CTX);

    expect(
      executionBroker.invoke.mock.calls.map(([toolId, input]) => [toolId, (input as { url: string }).url]),
    ).toEqual([
      ['crawl4ai.fetch', 'https://pumpen-handel.example/'],
      ['crawl4ai.fetch', 'https://pumpen-handel.example/impressum.html'],
      ['crawl4ai.render', CONTACT_URL],
    ]);
    expect(
      executionBroker.invoke.mock.calls.filter(([toolId]) => toolId === 'crawl4ai.render'),
    ).toHaveLength(MAX_WEBSITE_PROFILE_RENDERS_PER_COMPANY);
    expect(profile?.contactPaths).toEqual({
      contactPage: CONTACT_URL,
      impressumPage: 'https://pumpen-handel.example/impressum.html',
      supplierPage: 'https://pumpen-handel.example/lieferanten',
      linkedinCompanyPage: 'https://www.linkedin.com/company/pumpen-handel-example',
      xCompanyAccount: 'https://x.com/pumpenhandel',
      linksChecked: true,
      contactForm: CONTACT_URL,
      contactFormChecked: true,
    });
    // The company-level profile facts are unchanged by the contact paths.
    expect(profile).toMatchObject({
      tradeRole: 'distributor',
      tradeRoleSource: 'rules',
      impressumUrl: 'https://pumpen-handel.example/impressum.html',
    });
  });

  it('fetches exactly the homepage and Impressum and reports no contact paths unless asked', async () => {
    for (const input of [INPUT, { ...INPUT, contactPaths: false }]) {
      const executionBroker = contactBroker(PAGES, { [CONTACT_URL]: { html: CONTACT_FORM } });
      const profile = await provider(executionBroker).profile(input, CTX);

      expect(executionBroker.invoke).toHaveBeenCalledTimes(2);
      expect(executionBroker.invoke.mock.calls.map(([toolId]) => toolId)).not.toContain('crawl4ai.render');
      expect(profile).not.toHaveProperty('contactPaths');
    }
  });

  it('renders nothing when the homepage links no contact page, and then knows there is no form', async () => {
    const executionBroker = contactBroker(
      {
        ...PAGES,
        'https://pumpen-handel.example/':
          'Pumpen-Großhandel ab Lager. [Impressum](https://pumpen-handel.example/impressum.html)',
      },
      {},
    );
    const profile = await provider(executionBroker).profile({ ...INPUT, contactPaths: true }, CTX);

    expect(executionBroker.invoke).toHaveBeenCalledTimes(2);
    expect(profile?.contactPaths).toEqual({
      contactPage: null,
      impressumPage: 'https://pumpen-handel.example/impressum.html',
      supplierPage: null,
      linkedinCompanyPage: null,
      xCompanyAccount: null,
      linksChecked: true,
      contactForm: null,
      contactFormChecked: true,
    });
  });

  it('counts neither the links nor the form as checked when the homepage text reached the fetch cap', async () => {
    // 40,000 characters is the fetch cap: links past it may exist, so their absence proves nothing.
    const truncated = 'Pumpen-Großhandel ab Lager. '.repeat(2_000).slice(0, 40_000);
    const executionBroker = contactBroker({ ...PAGES, 'https://pumpen-handel.example/': truncated }, {});
    const profile = await provider(executionBroker).profile({ ...INPUT, contactPaths: true }, CTX);

    expect(executionBroker.invoke.mock.calls.map(([toolId]) => toolId)).not.toContain('crawl4ai.render');
    expect(profile?.contactPaths).toMatchObject({
      contactPage: null,
      linksChecked: false,
      contactForm: null,
      contactFormChecked: false,
    });
  });

  it('reports no form on a rendered contact page without one', async () => {
    const profile = await provider(
      contactBroker(PAGES, { [CONTACT_URL]: { html: '<html><body><p>Kontakt</p></body></html>' } }),
    ).profile({ ...INPUT, contactPaths: true }, CTX);

    expect(profile?.contactPaths).toMatchObject({
      contactPage: CONTACT_URL,
      contactForm: null,
      contactFormChecked: true,
    });
  });

  it('keeps the links but leaves the form unknown when robots, an error or an empty render stops it', async () => {
    const outcomes: Rendered[] = [{ html: '', robotsBlocked: true }, new Error('crawler 502'), { html: '' }];
    for (const rendered of outcomes) {
      const profile = await provider(contactBroker(PAGES, { [CONTACT_URL]: rendered }))
        .profile({ ...INPUT, contactPaths: true }, CTX);

      expect(profile?.contactPaths).toMatchObject({
        contactPage: CONTACT_URL,
        supplierPage: 'https://pumpen-handel.example/lieferanten',
        contactForm: null,
        contactFormChecked: false,
      });
    }
  });

  it('propagates prohibition-class and control denials from the contact page render', async () => {
    const tombstoned = new ToolPolicyDenied('crawl4ai.render', 'GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED');
    await expect(
      provider(contactBroker(PAGES, { [CONTACT_URL]: tombstoned })).profile({ ...INPUT, contactPaths: true }, CTX),
    ).rejects.toBe(tombstoned);

    const budget = Object.assign(new Error('budget'), { code: 'BUDGET_EXCEEDED' });
    await expect(
      provider(contactBroker(PAGES, { [CONTACT_URL]: budget })).profile({ ...INPUT, contactPaths: true }, CTX),
    ).rejects.toBe(budget);
  });
});
