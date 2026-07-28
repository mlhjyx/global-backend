import type { SiteSpecV1_1 } from '@global/contracts';

const CARD_COMPONENTS = new Set([
  'ArticleGrid',
  'CollectionCards',
  'FeatureCards',
  'ProductGrid',
  'ProjectsGrid',
  'ServicesGrid',
]);

export interface M1GoldenFixture {
  id: string;
  familyId: string;
  mode: 'sparse' | 'rich';
  spec: SiteSpecV1_1;
}

export interface M1CrossSiteGenericness {
  sampleIds: string[];
  distinctFamilyCount: number;
  distinctHomeStructureCount: number;
  maximumIdenticalHomeCount: number;
  maximumIdenticalHomeRatio: number;
  maximumCardSectionRatio: number;
}

export interface M1GoldenSuiteResult {
  fixtureCount: number;
  familyCount: number;
  factSafetyFindingCount: number;
  genericness: M1CrossSiteGenericness;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function factLiteralFindings(
  value: unknown,
  path: readonly (string | number)[] = [],
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      factLiteralFindings(item, [...path, index]),
    );
  }
  if (!record(value)) return [];
  const output: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = [...path, key];
    const container = path.at(-2);
    if (
      typeof container === 'string' &&
      ['stats', 'leftStats'].includes(container) &&
      key === 'value' &&
      child !== '—'
    ) {
      output.push(`/${fieldPath.join('/')}`);
    }
    if (
      typeof container === 'string' &&
      container === 'leftStats' &&
      key === 'suffix' &&
      child !== '—'
    ) {
      output.push(`/${fieldPath.join('/')}`);
    }
    if (
      typeof container === 'string' &&
      container === 'systems' &&
      ['metric', 'suffix'].includes(key) &&
      child !== '—'
    ) {
      output.push(`/${fieldPath.join('/')}`);
    }
    if (key === 'badges' && Array.isArray(child) && child.length > 0) {
      output.push(`/${fieldPath.join('/')}`);
    }
    if (
      key === 'clients' &&
      (!Array.isArray(child) ||
        child.length !== 1 ||
        child.some((item) => item !== '—'))
    ) {
      output.push(`/${fieldPath.join('/')}`);
    }
    output.push(...factLiteralFindings(child, fieldPath));
  }
  return output;
}

function homeBlocks(spec: SiteSpecV1_1) {
  const home = spec.pages.find((page) => page.id === 'home');
  if (!home) throw new Error('M1_G_HOME_PAGE_MISSING');
  return home.puck.content;
}

function homeSignature(spec: SiteSpecV1_1): string {
  return homeBlocks(spec)
    .map((block) => {
      const variant =
        record(block.props) && typeof block.props.variant === 'string'
          ? block.props.variant
          : '';
      return `${block.type}:${variant}`;
    })
    .join('|');
}

export function evaluateM1CrossSiteGenericness(
  fixtures: readonly M1GoldenFixture[],
): M1CrossSiteGenericness {
  if (fixtures.length < 10) {
    throw new Error(`M1_G_GENERICNESS_SAMPLE_TOO_SMALL: ${fixtures.length}/10`);
  }
  const sample = [...fixtures]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 10);
  const signatureCounts = new Map<string, number>();
  let maximumCardSectionRatio = 0;
  for (const fixture of sample) {
    const signature = homeSignature(fixture.spec);
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    const blocks = homeBlocks(fixture.spec);
    const cardCount = blocks.filter((block) =>
      CARD_COMPONENTS.has(block.type),
    ).length;
    maximumCardSectionRatio = Math.max(
      maximumCardSectionRatio,
      blocks.length === 0 ? 0 : cardCount / blocks.length,
    );
  }
  const maximumIdenticalHomeCount = Math.max(...signatureCounts.values());
  const result: M1CrossSiteGenericness = {
    sampleIds: sample.map((fixture) => fixture.id),
    distinctFamilyCount: new Set(sample.map((fixture) => fixture.familyId))
      .size,
    distinctHomeStructureCount: signatureCounts.size,
    maximumIdenticalHomeCount,
    maximumIdenticalHomeRatio: maximumIdenticalHomeCount / sample.length,
    maximumCardSectionRatio,
  };
  if (result.distinctFamilyCount < 4) {
    throw new Error(
      `M1_G_GENERICNESS_FAMILY_COUNT_FAILED: ${result.distinctFamilyCount}/4`,
    );
  }
  if (result.distinctHomeStructureCount < 4) {
    throw new Error(
      `M1_G_GENERICNESS_STRUCTURE_COUNT_FAILED: ${result.distinctHomeStructureCount}/4`,
    );
  }
  if (result.maximumIdenticalHomeRatio > 0.3) {
    throw new Error(
      `M1_G_GENERICNESS_IDENTICAL_HOME_FAILED: ${result.maximumIdenticalHomeCount}/${sample.length}`,
    );
  }
  if (result.maximumCardSectionRatio > 0.5) {
    throw new Error(
      `M1_G_GENERICNESS_CARD_RATIO_FAILED: ${result.maximumCardSectionRatio}`,
    );
  }
  return result;
}

export function verifyM1GoldenSuite(
  fixtures: readonly M1GoldenFixture[],
): M1GoldenSuiteResult {
  if (fixtures.length !== 12) {
    throw new Error(`M1_G_VISUAL_FIXTURE_COUNT_FAILED: ${fixtures.length}/12`);
  }
  const familyModes = new Map<string, Set<string>>();
  const factFindings: string[] = [];
  for (const fixture of fixtures) {
    const modes = familyModes.get(fixture.familyId) ?? new Set<string>();
    modes.add(fixture.mode);
    familyModes.set(fixture.familyId, modes);
    for (const page of fixture.spec.pages) {
      for (const block of page.puck.content) {
        factFindings.push(
          ...factLiteralFindings(block.props).map(
            (path) => `${fixture.id}/${page.id}/${block.type}${path}`,
          ),
        );
      }
    }
  }
  if (
    familyModes.size !== 6 ||
    [...familyModes.values()].some(
      (modes) => !modes.has('sparse') || !modes.has('rich') || modes.size !== 2,
    )
  ) {
    throw new Error('M1_G_FAMILY_MATRIX_FAILED: require 6 sparse/rich pairs');
  }
  if (factFindings.length > 0) {
    throw new Error(
      `M1_G_UNSUPPORTED_FACT_LITERAL: ${factFindings.sort().join(',')}`,
    );
  }
  return {
    fixtureCount: fixtures.length,
    familyCount: familyModes.size,
    factSafetyFindingCount: 0,
    genericness: evaluateM1CrossSiteGenericness(fixtures),
  };
}
