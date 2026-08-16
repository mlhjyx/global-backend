type JsonObject = Record<string, unknown>;

export type ProviderQualityContribution = {
  workspaceId: string;
  runId: string;
  icpId: string | null;
  providerKey: string;
  terminalStatus: string;
  attemptedCount: number;
  successCount: number;
  zeroResultCount: number;
  failureCount: number;
  failedRunCount: number;
  processedCount: number;
  rawCount: number;
  acceptedCount: number | null;
  boundCount: number | null;
  domainCount: number | null;
  authorityCount: number | null;
  conflictCount: number | null;
  duplicateCount: number;
  completedAt: Date;
};

export type ProviderQualityRunInput = {
  workspaceId: string;
  runId: string;
  icpId?: string | null;
  status: 'DONE' | 'PARTIAL' | 'FAILED';
  stats: Record<string, unknown>;
  completedAt: Date;
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function requiredCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`PROVIDER_QUALITY_FACTS_INVALID: ${label}`);
  }
  return Number(value);
}

function optionalCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function validProviderKey(key: string): boolean {
  if (key.trim() !== key || key.length === 0 || key.length > 128) return false;
  for (const character of key) {
    const codePoint = character.codePointAt(0);
    if (character === '+' || codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function identityCount(quality: JsonObject | null, field: string): number | null {
  return optionalCount(quality?.[field]);
}

/** Build only from the provider-keyed execution facts emitted by the workflow. */
export function buildProviderQualityContributions(input: ProviderQualityRunInput): ProviderQualityContribution[] {
  const perProvider = object(input.stats.perProvider);
  if (!perProvider) return [];
  const identityQuality = object(input.stats.identityQuality) ?? {};

  return Object.entries(perProvider).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    if (!validProviderKey(key)) throw new Error('PROVIDER_QUALITY_FACTS_INVALID: providerKey');
    const facts = object(value);
    if (!facts) throw new Error(`PROVIDER_QUALITY_FACTS_INVALID: perProvider.${key}`);
    const attemptedCount = requiredCount(facts.attemptedCount, `${key}.attemptedCount`);
    const successCount = requiredCount(facts.successCount, `${key}.successCount`);
    const zeroResultCount = requiredCount(facts.zeroResultCount, `${key}.zeroResultCount`);
    const failureCount = requiredCount(facts.failureCount, `${key}.failureCount`);
    const rawCount = requiredCount(facts.rawCount, `${key}.rawCount`);
    const quarantinedCount = requiredCount(facts.quarantinedCount, `${key}.quarantinedCount`);
    const rejectedCount = requiredCount(facts.rejectedCount, `${key}.rejectedCount`);
    const duplicateCount = requiredCount(facts.duplicateCount, `${key}.duplicateCount`);
    if (attemptedCount < 1 || successCount + failureCount !== attemptedCount || zeroResultCount > successCount) {
      throw new Error(`PROVIDER_QUALITY_FACTS_INVALID: ${key}.attemptAccounting`);
    }
    const quality = object(identityQuality[key]);
    const acceptedCount = identityCount(quality, 'acceptedRows');
    const boundCount = identityCount(quality, 'boundRows');
    const domainCount = identityCount(quality, 'domainRows');
    const authorityCount = identityCount(quality, 'authorityIdentifierRows');
    const conflictCount = identityCount(quality, 'conflictRows');
    for (const candidate of [boundCount, domainCount, authorityCount, conflictCount]) {
      if (acceptedCount !== null && candidate !== null && candidate > acceptedCount) {
        throw new Error(`PROVIDER_QUALITY_FACTS_INVALID: ${key}.identityAccounting`);
      }
    }
    return {
      workspaceId: input.workspaceId,
      runId: input.runId,
      icpId: input.icpId ?? null,
      providerKey: key,
      terminalStatus: input.status,
      attemptedCount,
      successCount,
      zeroResultCount,
      failureCount,
      failedRunCount: failureCount > 0 ? 1 : 0,
      processedCount: rawCount + quarantinedCount + rejectedCount + duplicateCount,
      rawCount,
      acceptedCount,
      boundCount,
      domainCount,
      authorityCount,
      conflictCount,
      duplicateCount,
      completedAt: input.completedAt,
    };
  });
}

type StoredContribution = ProviderQualityContribution & { id?: string; createdAt?: Date };
type ContributionWriter = {
  providerQualityRunContribution: {
    findMany(args: object): Promise<StoredContribution[]>;
    createMany(args: { data: ProviderQualityContribution[]; skipDuplicates: boolean }): Promise<{ count: number }>;
  };
};

const FACT_KEYS = [
  'workspaceId', 'runId', 'icpId', 'providerKey', 'terminalStatus',
  'attemptedCount', 'successCount', 'zeroResultCount', 'failureCount', 'failedRunCount',
  'processedCount', 'rawCount', 'acceptedCount', 'boundCount', 'domainCount',
  'authorityCount', 'conflictCount', 'duplicateCount',
] as const;

function sameFact(actual: StoredContribution, expected: ProviderQualityContribution): boolean {
  return FACT_KEYS.every((key) => actual[key] === expected[key])
    && actual.completedAt.getTime() === expected.completedAt.getTime();
}

export async function persistProviderQualityContributions(
  tx: ContributionWriter,
  input: ProviderQualityRunInput,
): Promise<number> {
  const expected = buildProviderQualityContributions(input);
  const inserted = expected.length
    ? await tx.providerQualityRunContribution.createMany({ data: expected, skipDuplicates: true })
    : { count: 0 };
  const actual = await tx.providerQualityRunContribution.findMany({
    where: { workspaceId: input.workspaceId, runId: input.runId },
    orderBy: { providerKey: 'asc' },
  });
  if (actual.length !== expected.length || actual.some((row, index) => !sameFact(row, expected[index]!))) {
    throw new Error('PROVIDER_QUALITY_CONTRIBUTION_DRIFT');
  }
  return inserted.count;
}
