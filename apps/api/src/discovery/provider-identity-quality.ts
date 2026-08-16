type IdentifierLike = {
  scheme?: string;
  value?: string;
};

export type ProviderIdentityQualityInput = {
  name?: string;
  domain?: string;
  identifier?: IdentifierLike;
  identifiers?: IdentifierLike[];
};

export type ProviderIdentityQuality = {
  acceptedRows: number;
  namedRows: number;
  domainRows: number;
  authorityIdentifierRows: number;
  officialRegistrationRows: number;
  boundRows: number;
  uniqueCompanies: number;
  conflictRows: number;
  suppressedRows: number;
  replayedRows: number;
};

const OFFICIAL_REGISTRATION_SCHEMES = new Set([
  'br-cnpj',
  'fda-reg',
  'lei',
  'siren',
  'cik',
  'ror-id',
  'us_npi',
  'uei',
  'uk-company-number',
]);

function emptyQuality(): ProviderIdentityQuality {
  return {
    acceptedRows: 0,
    namedRows: 0,
    domainRows: 0,
    authorityIdentifierRows: 0,
    officialRegistrationRows: 0,
    boundRows: 0,
    uniqueCompanies: 0,
    conflictRows: 0,
    suppressedRows: 0,
    replayedRows: 0,
  };
}

function normalizedScheme(identifier: IdentifierLike): string {
  return typeof identifier.scheme === 'string' ? identifier.scheme.trim().toLowerCase() : '';
}

function hasOfficialRegistration(identifiers: readonly IdentifierLike[]): boolean {
  return identifiers.some((identifier) => {
    const scheme = normalizedScheme(identifier);
    return OFFICIAL_REGISTRATION_SCHEMES.has(scheme) || scheme.startsWith('ted-natid:');
  });
}

/**
 * Per-run, per-provider identity quality counters. These deliberately record
 * observable facts only; they do not pretend to measure semantic ICP accuracy
 * without a human/model fit verdict.
 */
export class ProviderIdentityQualityTracker {
  private readonly quality = new Map<string, ProviderIdentityQuality>();
  private readonly companyIds = new Map<string, Set<string>>();

  private get(providerKey: string): ProviderIdentityQuality {
    const existing = this.quality.get(providerKey);
    if (existing) return existing;
    const created = emptyQuality();
    this.quality.set(providerKey, created);
    this.companyIds.set(providerKey, new Set());
    return created;
  }

  recordAccepted(providerKey: string, record: ProviderIdentityQualityInput): void {
    const quality = this.get(providerKey);
    quality.acceptedRows += 1;
    if (record.name?.trim()) quality.namedRows += 1;
    if (record.domain?.trim()) quality.domainRows += 1;
    const identifiers = [record.identifier, ...(record.identifiers ?? [])].filter(
      (identifier): identifier is IdentifierLike => Boolean(identifier),
    );
    if (identifiers.length > 0) quality.authorityIdentifierRows += 1;
    if (hasOfficialRegistration(identifiers)) quality.officialRegistrationRows += 1;
  }

  recordBound(providerKey: string, companyId: string, replayed: boolean): void {
    const quality = this.get(providerKey);
    quality.boundRows += 1;
    if (replayed) quality.replayedRows += 1;
    const companyIds = this.companyIds.get(providerKey);
    companyIds?.add(companyId);
    quality.uniqueCompanies = companyIds?.size ?? 0;
  }

  recordConflict(providerKey: string): void {
    this.get(providerKey).conflictRows += 1;
  }

  recordSuppressed(providerKey: string): void {
    this.get(providerKey).suppressedRows += 1;
  }

  snapshot(): Record<string, ProviderIdentityQuality> {
    return Object.fromEntries(
      [...this.quality.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([providerKey, quality]) => [providerKey, { ...quality }]),
    );
  }
}
