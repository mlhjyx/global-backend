import { describe, expect, it } from 'vitest';
import {
  ASSOCIATION_DIRECTORY_CATALOG,
  REJECTED_ASSOCIATION_DIRECTORY_CANDIDATES,
  associationDirectoryCountryIso,
  associationDirectorySourcePolicyInputs,
  findAssociationDirectoryByDomain,
  findAssociationDirectoryByUrl,
  selectAssociationDirectories,
} from './association-directory-catalog';
import { isStableSafeHttpsUrl } from './raw-source-provider-normalizer';
import { isDirectoryListingShaped } from './providers/directory.provider';
import { directorySourcePolicyDecision } from './directory-source-policy';
import type { RawSourcePolicySnapshot } from './raw-source-ingestion';

const REQUIRED_MARKETS = ['DE', 'MY', 'GB', 'CA', 'BR', 'NL', 'TR', 'AU', 'EU'] as const;

describe('ASSOCIATION_DIRECTORY_CATALOG（8 国 + 泛欧合规光伏协会名录）', () => {
  it('covers all 8 target markets plus pan-EU with 2–4 verified entries each and unique slugs/domains', () => {
    expect(ASSOCIATION_DIRECTORY_CATALOG.length).toBeGreaterThanOrEqual(24);
    expect(new Set(ASSOCIATION_DIRECTORY_CATALOG.map((e) => e.slug)).size).toBe(
      ASSOCIATION_DIRECTORY_CATALOG.length,
    );
    expect(new Set(ASSOCIATION_DIRECTORY_CATALOG.map((e) => e.domain)).size).toBe(
      ASSOCIATION_DIRECTORY_CATALOG.length,
    );

    for (const market of REQUIRED_MARKETS) {
      const entries = ASSOCIATION_DIRECTORY_CATALOG.filter((e) => e.countryIso === market);
      expect(entries.length, `market ${market} must have 2–4 compliant directories`).toBeGreaterThanOrEqual(2);
      expect(entries.length, `market ${market} must have 2–4 compliant directories`).toBeLessThanOrEqual(4);
    }
  });

  it('every approved entry has stable HTTPS URLs, compliance metadata, listing shape, and Tier-1 policy admission', () => {
    const seededPolicies: RawSourcePolicySnapshot[] = associationDirectorySourcePolicyInputs().map(
      (input, index) => ({
        id: `assoc-policy-${index}`,
        domain: input.domain,
        retentionDays: input.retentionDays,
        reviewStatus: input.reviewStatus,
        allowedPurpose: [...input.allowedPurpose],
        updatedAt: new Date('2026-11-27T00:00:00Z'),
      }),
    );

    for (const entry of ASSOCIATION_DIRECTORY_CATALOG) {
      expect(isStableSafeHttpsUrl(entry.directoryUrl), `invalid directoryUrl: ${entry.directoryUrl}`).toBe(true);
      expect(isStableSafeHttpsUrl(entry.tosUrl), `invalid tosUrl: ${entry.tosUrl}`).toBe(true);
      expect(new URL(entry.directoryUrl).hostname.replace(/^www\./u, '')).toBe(entry.domain);
      expect(entry.robotsStatus).toBe('ALLOWS');
      expect(entry.termsStatus).toBe('REVIEWED_OK');
      expect(entry.license.length).toBeGreaterThan(10);
      expect(entry.industryTags.length).toBeGreaterThanOrEqual(5);
      expect(
        isDirectoryListingShaped(entry.directoryUrl, entry.name),
        `listing shape failed for ${entry.slug}: ${entry.directoryUrl}`,
      ).toBe(true);
      expect(
        directorySourcePolicyDecision(entry.directoryUrl, seededPolicies),
        `policy admission failed for ${entry.slug}`,
      ).toEqual({ allowed: true });
    }
  });

  it('never admits rejected anti-bot/ToS-restricted domains into the approved catalog or source_policy seed', () => {
    const approvedDomains = new Set(ASSOCIATION_DIRECTORY_CATALOG.map((e) => e.domain));
    const seededDomains = new Set(associationDirectorySourcePolicyInputs().map((r) => r.domain));
    expect(REJECTED_ASSOCIATION_DIRECTORY_CANDIDATES.length).toBeGreaterThanOrEqual(10);

    for (const rejected of [
      'solarenergyuk.org',
      'energy-uk.org.uk',
      'scottishrenewables.com',
      'mcscertified.com',
      'cleanenergycouncil.org.au',
      'energycouncil.com.au',
      'apvi.org.au',
      'members.renewablesassociation.ca',
    ]) {
      expect(approvedDomains.has(rejected)).toBe(false);
      expect(seededDomains.has(rejected)).toBe(false);
    }
  });

  it('selects country-specific directories ahead of pan-EU for European markets and isolates non-EU markets', () => {
    const de = selectAssociationDirectories({
      industryTerms: ['photovoltaic', 'solar module'],
      countries: ['DE'],
    });
    expect(de.slice(0, 4).every((e) => e.countryIso === 'DE')).toBe(true);
    expect(de.some((e) => e.slug === 'solarpower-europe-eu')).toBe(true);

    const my = selectAssociationDirectories({
      industryTerms: ['solar', 'EPC'],
      countries: ['MY'],
    });
    expect(my.length).toBe(3);
    expect(my.every((e) => e.countryIso === 'MY')).toBe(true);
    expect(my.map((e) => e.slug)).toContain('mpsea-my');
    expect(my.map((e) => e.slug)).toContain('seda-rpvsp-my');

    // Non-PV industry queries do not accidentally inject PV associations
    expect(
      selectAssociationDirectories({
        industryTerms: ['pumps'],
        keywords: ['centrifugal'],
        countries: ['DE'],
      }),
    ).toEqual([]);
  });

  it('resolves single-country ISO for country directories and returns undefined for pan-EU directories', () => {
    expect(associationDirectoryCountryIso('https://www.solarwirtschaft.de/unsere-mitglieder/mitgliedersuche/')).toBe('DE');
    expect(associationDirectoryCountryIso('https://mpsea.org.my/membership/')).toBe('MY');
    expect(associationDirectoryCountryIso('https://mpia.org.my/members/')).toBe('MY');
    expect(associationDirectoryCountryIso('https://services.seda.gov.my/spqp/listing')).toBe('MY');
    expect(associationDirectoryCountryIso('https://www.absolar.org.br/associados/')).toBe('BR');
    expect(associationDirectoryCountryIso('https://gensed.org/uyelerimiz/')).toBe('TR');
    expect(associationDirectoryCountryIso('https://portal.smartenergy.org.au/industry-directory/')).toBe('AU');
    expect(associationDirectoryCountryIso('https://www.solarpowereurope.org/membership/meet-our-members')).toBeUndefined();
    expect(findAssociationDirectoryByUrl('https://esmc.solar/esmc-members/')?.countryIso).toBe('EU');
    expect(findAssociationDirectoryByDomain('unknown-dir.example')).toBeUndefined();
  });

  it('derives deduplicated source_policy seed inputs carrying country, tags, license, and ToS URL', () => {
    const seeds = associationDirectorySourcePolicyInputs();
    expect(seeds).toHaveLength(ASSOCIATION_DIRECTORY_CATALOG.length);
    for (const seed of seeds) {
      expect(seed.sourceType).toBe('association');
      expect(seed.accessMode).toBe('crawl');
      expect(seed.reviewStatus).toBe('APPROVED');
      expect(seed.robotsStatus).toBe('ALLOWS');
      expect(seed.termsStatus).toBe('REVIEWED_OK');
      expect(seed.personalData).toBe(false);
      expect(seed.allowedPurpose).toEqual(['discovery']);
      expect(seed.notes).toContain('license=');
      expect(seed.notes).toContain('tos=https://');
    }
  });
});
