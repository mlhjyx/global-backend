import { describe, expect, it, vi } from 'vitest';
import {
  DomainCooldownService,
  InMemoryDomainCooldownBackend,
  InMemorySharedFactRepository,
  SharedGreenFactStore,
} from '../../shared-facts';
import type { StreamingCompanyExtraction } from './raw-http-extractor';
import {
  createSharedFactsHookFromEnv,
  greenFactToStreamingExtraction,
  resolveSharedGreenFactsMode,
  SharedFactsStreamingHook,
} from './shared-facts-hook';

const TEST_PEPPER = 'hook-spec-cooldown-secret-pepper-32chars';

function sampleExtraction(overrides: Partial<StreamingCompanyExtraction> = {}): StreamingCompanyExtraction {
  return {
    domain: 'memodo.de',
    homepageUrl: 'https://www.memodo.de/',
    fetchMethod: 'raw_http',
    usedCrawl4aiFallback: false,
    usedWwwRetry: false,
    pdfSkipped: false,
    robotsBlocked: false,
    title: 'Memodo GmbH',
    metaDescription: 'Photovoltaik Grosshandel fuer Installateure in Deutschland.',
    visibleText: 'Raw homepage copy with personal email hans.mueller@memodo.de that must not be stored raw.',
    jsonLd: {
      organizationNames: ['Memodo GmbH'],
      descriptions: ['PV & Speicher Grosshandel'],
      emails: ['sales@memodo.de', 'hans.mueller@memodo.de'],
      phones: ['+49 89 90410150'],
      socialLinks: [
        'https://www.linkedin.com/in/hans-mueller',
        'https://www.linkedin.com/company/memodo-gmbh/',
      ],
      products: ['Solar Modules', 'Inverters'],
      jobPostings: [],
    },
    channels: {
      roleEmails: ['sales@memodo.de'],
      otherEmails: ['hans.mueller@memodo.de'],
      phones: ['+49 89 90410150'],
      socialLinks: [
        'https://www.linkedin.com/in/hans-mueller',
        'https://www.linkedin.com/company/memodo-gmbh/',
      ],
      hasInquiryForm: true,
      contactFormUrl: 'https://www.memodo.de/kontakt',
      contactPageUrl: 'https://www.memodo.de/kontakt',
      impressumUrl: 'https://www.memodo.de/impressum',
      careersPageUrl: 'https://www.memodo.de/karriere',
    },
    pagesFetched: ['https://www.memodo.de/'],
    failureReason: null,
    ...overrides,
  };
}

describe('SharedFactsStreamingHook (ADR-003 L0/L1 integration)', () => {
  it('defaults safely to off and parses on / readonly modes without touching NODE_ENV', () => {
    expect(resolveSharedGreenFactsMode({})).toBe('off');
    expect(resolveSharedGreenFactsMode({ ADR003_SHARED_GREEN_FACTS: 'off' })).toBe('off');
    expect(resolveSharedGreenFactsMode({ ADR003_SHARED_GREEN_FACTS: 'readonly' })).toBe('readonly');
    expect(resolveSharedGreenFactsMode({ ADR003_SHARED_GREEN_FACTS: 'shadow' })).toBe('readonly');
    expect(resolveSharedGreenFactsMode({ ADR003_SHARED_GREEN_FACTS: 'on' })).toBe('on');

    const factorySpy = vi.fn();
    const disabled = createSharedFactsHookFromEnv({}, factorySpy);
    expect(disabled.isEnabled()).toBe(false);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('writes back sanitized green facts, reuses them on L1 hit with zero PII, and blocks imported_buyer', async () => {
    const repo = new InMemorySharedFactRepository();
    const cooldownBackend = new InMemoryDomainCooldownBackend();
    const hook = new SharedFactsStreamingHook({
      mode: 'on',
      factStore: new SharedGreenFactStore(repo),
      cooldownService: new DomainCooldownService({
        pepper: TEST_PEPPER,
        backend: cooldownBackend,
        fallbackBackend: cooldownBackend,
        maxDistinctWorkspaces30d: 2,
      }),
    });
    const now = new Date('2026-11-26T00:00:00.000Z');

    // Imported buyer must NEVER write back to shared layer or cooldown
    const blocked = await hook.writeBackFromStreamingExtraction({
      domain: 'private-client.de',
      legalName: 'Private Client GmbH',
      country: 'DE',
      extraction: sampleExtraction({ domain: 'private-client.de', homepageUrl: 'https://private-client.de/' }),
      isImportedBuyer: true,
      now,
    });
    expect(blocked?.stored).toBe(false);
    if (blocked && !blocked.stored) expect(blocked.reason).toBe('IMPORTED_BUYER_FORBIDDEN');
    expect(
      await hook.recordQualifiedTouch({
        domain: 'private-client.de',
        workspaceId: 'ws-a',
        isImportedBuyer: true,
        nowMs: now.getTime(),
      }),
    ).toBeNull();
    expect((await hook.lookupL1PreFetch({ domain: 'private-client.de', nowMs: now.getTime() })).hit).toBe(
      false,
    );

    // Public web extraction writes back zero-PII green facts
    const writeRes = await hook.writeBackFromStreamingExtraction({
      domain: 'memodo.de',
      legalName: 'Memodo GmbH',
      country: 'DE',
      tradeRole: 'distributor',
      extraction: sampleExtraction(),
      isImportedBuyer: false,
      now,
    });
    expect(writeRes?.stored).toBe(true);

    // Record 2 distinct tenant touches -> triggers 30d cooldown advisory for tenant 3
    await hook.recordQualifiedTouch({
      domain: 'memodo.de',
      workspaceId: 'ws-tenant-a',
      isImportedBuyer: false,
      nowMs: now.getTime(),
    });
    await hook.recordQualifiedTouch({
      domain: 'memodo.de',
      workspaceId: 'ws-tenant-b',
      isImportedBuyer: false,
      nowMs: now.getTime() + 1_000,
    });

    // Tenant C L0/L1 sees shared fact HIT + cooldown advisory without leaking tenant A/B or PII
    const l0 = await hook.inspectL0Domains(['https://www.memodo.de'], now.getTime() + 2_000);
    expect(l0.get('memodo.de')).toEqual({
      sharedFactAvailable: true,
      cooldown: {
        cooledDown: true,
        distinctWorkspaces30d: 2,
        retryAfterDays: 30,
        advisoryOnly: true,
      },
    });

    const preFetch = await hook.lookupL1PreFetch({
      domain: 'memodo.de',
      nowMs: now.getTime() + 2_000,
    });
    expect(preFetch.hit).toBe(true);
    expect(preFetch.cooldown.cooledDown).toBe(true);
    expect(preFetch.syntheticExtraction?.fetchMethod).toBe('skipped');
    expect(preFetch.syntheticExtraction?.channels.roleEmails).toEqual(['sales@memodo.de']);
    expect(preFetch.syntheticExtraction?.channels.otherEmails).toEqual([]);
    expect(preFetch.syntheticExtraction?.channels.socialLinks).toEqual([
      'https://www.linkedin.com/company/memodo-gmbh',
    ]);
    const serialized = JSON.stringify(preFetch);
    expect(serialized).not.toContain('hans.mueller');
    expect(serialized).not.toContain('ws-tenant-a');
    expect(serialized).not.toContain('ws-tenant-b');
    expect(greenFactToStreamingExtraction(preFetch.fact!).visibleText).toContain('Memodo GmbH');
  });

  it('in readonly mode reads hits and cooldowns without writing back', async () => {
    const repo = new InMemorySharedFactRepository();
    const store = new SharedGreenFactStore(repo);
    const now = new Date('2026-11-26T00:00:00.000Z');
    await store.putFromRaw({ domain: 'rexel.de', legalName: 'Rexel DE' }, { now });

    const readonlyHook = new SharedFactsStreamingHook({
      mode: 'readonly',
      factStore: store,
      cooldownService: new DomainCooldownService({ pepper: TEST_PEPPER }),
    });
    const hit = await readonlyHook.lookupL1PreFetch({ domain: 'rexel.de', nowMs: now.getTime() });
    expect(hit.hit).toBe(true);
    const writeRes = await readonlyHook.writeBackFromStreamingExtraction({
      domain: 'new-site.de',
      legalName: 'New Site',
      extraction: sampleExtraction({ domain: 'new-site.de', homepageUrl: 'https://new-site.de/' }),
      isImportedBuyer: false,
      now,
    });
    expect(writeRes).toBeNull();
    expect(await store.get('new-site.de', now.getTime())).toBeNull();
  });
});
