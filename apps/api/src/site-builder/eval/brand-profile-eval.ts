import type { EvidenceSourceRole, EvidenceSourceType } from '@global/contracts';
import {
  BRAND_PROFILE_TASK,
  enforceEvidenceGateV2,
  type BrandProfileInput,
  type BrandProfileOutput,
  type PromptEvidenceSource,
} from '../agents/brand-profile';
import {
  freezeEvidenceSource,
  type FrozenEvidenceSource,
} from '../agents/evidence-ref';

export const BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION = 'brand-profile-eval-fixture/v1' as const;

export interface BrandProfileEvalFixtureSource {
  id: string;
  sourceKey: string;
  sourceType: EvidenceSourceType;
  sourceRole: EvidenceSourceRole;
  content: string;
}

export interface BrandProfileEvalFixture {
  schemaVersion: typeof BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION;
  id: string;
  industry: string;
  materialCompleteness: 'sparse' | 'rich';
  companyName: string;
  products: string[];
  targetMarkets: string[];
  sources: BrandProfileEvalFixtureSource[];
  assertions: {
    minimumAcceptedFacts: number;
    requiredAcceptedTerms: string[];
    forbiddenOutputTerms: string[];
  };
}

export interface PreparedBrandProfileEvalFixture {
  fixture: BrandProfileEvalFixture;
  input: BrandProfileInput;
  frozenSources: ReadonlyMap<string, FrozenEvidenceSource>;
}

export interface BrandProfileEvalOutcome {
  acceptedArtifact: boolean;
  acceptedFactCount: number;
  rejectedFactCount: number;
  missingAcceptedTerms: string[];
  forbiddenOutputTerms: string[];
}

function toPromptSource(id: string, source: FrozenEvidenceSource): PromptEvidenceSource {
  return {
    sourceId: id,
    sourceType: source.sourceType,
    sourceRole: source.sourceRole,
    contentHash: source.contentHash,
    content: source.snapshotText,
    ...(source.displayUrl ? { url: source.displayUrl } : {}),
    ...(source.fetchedAt ? { fetchedAt: source.fetchedAt } : {}),
  };
}

/**
 * Rebuilds the exact normalized/hash-bound prompt inputs used by production
 * BrandProfile generation. Fixtures contain only synthetic, non-personal data.
 */
export function prepareBrandProfileEvalFixture(
  fixture: BrandProfileEvalFixture,
): PreparedBrandProfileEvalFixture {
  if (fixture.schemaVersion !== BRAND_PROFILE_EVAL_FIXTURE_SCHEMA_VERSION) {
    throw new Error(`unsupported BrandProfile eval fixture schema: ${fixture.schemaVersion}`);
  }
  const entries = fixture.sources.map((source) => [
    source.id,
    freezeEvidenceSource({
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      sourceRole: source.sourceRole,
      rawText: source.content,
      provenance: { fixtureId: fixture.id, sourceId: source.id },
    }),
  ] as const);
  const frozenSources = new Map(entries);
  const intakeEntry = entries.find(([, source]) => source.sourceType === 'intake');
  if (!intakeEntry) throw new Error(`${fixture.id}: an intake source is required`);

  const promptEntries = entries.map(([id, source]) => toPromptSource(id, source));
  const [intakeSource] = promptEntries.filter((source) => source.sourceType === 'intake');
  const kbSources = promptEntries.filter((source) => source.sourceType === 'upload');
  const research = promptEntries.filter(
    (source) => source.sourceType === 'storefront' || source.sourceType === 'web_research',
  );

  return {
    fixture,
    frozenSources,
    input: {
      companyName: fixture.companyName,
      industry: fixture.industry,
      products: fixture.products,
      targetMarkets: fixture.targetMarkets,
      intakeSource,
      kbSources,
      research,
    },
  };
}

function modelOutputText(output: BrandProfileOutput): string {
  // The JSON schema intentionally keeps enrichment sections optional. Runtime
  // output may therefore omit them even though the TypeScript-facing shape is
  // convenient for production callers that default each field before storage.
  const glossary = output.glossary ?? [];
  const differentiators = output.differentiators ?? [];
  const competitors = output.competitors ?? [];
  return [
    ...output.valueProps,
    ...(output.tone ? [output.tone.voice, ...(output.tone.style ?? [])] : []),
    ...glossary.flatMap((item) => [item.term, item.definition]),
    ...output.keywords,
    ...differentiators,
    ...competitors.flatMap((item) => [item.name, item.positioning]),
    ...output.factSheet.flatMap((item) => [item.key, item.value, item.evidence?.quote ?? '']),
    // Gaps are questions to the site owner, not publishable model assertions.
    // Asking whether a certification exists must not be scored as asserting it.
  ]
    .join('\n')
    .toLocaleLowerCase('en-US');
}

/**
 * Applies the permanent facts/reference gate before judging textual coverage.
 * A rejected model-produced fact is a MODEL-1 hard failure even though the
 * production gate would safely demote it to a gap.
 */
export function evaluateBrandProfileOutput(
  prepared: PreparedBrandProfileEvalFixture,
  output: BrandProfileOutput,
): BrandProfileEvalOutcome {
  const gated = enforceEvidenceGateV2(output.factSheet, { sources: prepared.frozenSources });
  // Do not let a source quote satisfy a required output fact. The evidence
  // gate proves that the quote exists, not that it semantically supports a
  // different model-provided value (for example 300 bar citing 160 bar).
  const assertedFactText = gated.factSheet
    .flatMap((item) => [item.key, item.value])
    .join('\n')
    .toLocaleLowerCase('en-US');
  const outputText = modelOutputText(output);
  const missingAcceptedTerms = prepared.fixture.assertions.requiredAcceptedTerms.filter(
    (term) => !assertedFactText.includes(term.toLocaleLowerCase('en-US')),
  );
  const forbiddenOutputTerms = prepared.fixture.assertions.forbiddenOutputTerms.filter((term) =>
    outputText.includes(term.toLocaleLowerCase('en-US')),
  );
  const acceptedFactCount = gated.factSheet.length;
  const rejectedFactCount = gated.gaps.length;

  return {
    acceptedArtifact:
      acceptedFactCount >= prepared.fixture.assertions.minimumAcceptedFacts &&
      rejectedFactCount === 0 &&
      missingAcceptedTerms.length === 0 &&
      forbiddenOutputTerms.length === 0,
    acceptedFactCount,
    rejectedFactCount,
    missingAcceptedTerms,
    forbiddenOutputTerms,
  };
}

export { BRAND_PROFILE_TASK };
