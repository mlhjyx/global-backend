import type { SiteBuilderTaskDefinition } from './ai-task';
import type {
  CopySlotDefinition,
  CopySlotGeneratorResult,
} from '../copy-bundle.service';
import type { PublishableClaimSnapshotItem } from '../publishable-claim-snapshot';

export interface CopyTaskInput {
  locale: string;
  sourceLocale: string;
  snapshotDigest: string;
  claims: PublishableClaimSnapshotItem[];
  slots: CopySlotDefinition[];
}

export interface CopyTaskOutput {
  slots: Record<string, CopySlotGeneratorResult>;
}

function validateCopyTaskOutput(
  input: CopyTaskInput,
  output: CopyTaskOutput,
): void {
  if (!output || typeof output !== 'object' || !output.slots) {
    throw new Error('copy output has no slots');
  }
  const expected = [...input.slots.map((slot) => slot.key)].sort();
  const actual = Object.keys(output.slots).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('copy output slot keys do not match the frozen catalog');
  }
  for (const [key, slot] of Object.entries(output.slots)) {
    if (
      typeof slot?.content !== 'string' ||
      !Array.isArray(slot.claimRefs) ||
      slot.claimRefs.some((claimId) => typeof claimId !== 'string')
    ) {
      throw new Error(`copy output slot ${key} is malformed`);
    }
  }
}

export const COPY_TASK: SiteBuilderTaskDefinition<
  CopyTaskInput,
  CopyTaskOutput
> = {
  id: 'site_builder.copy',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['locale', 'sourceLocale', 'snapshotDigest', 'claims', 'slots'],
    properties: {
      locale: { type: 'string' },
      sourceLocale: { type: 'string' },
      snapshotDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      claims: { type: 'array', items: { type: 'object' } },
      slots: { type: 'array', items: { type: 'object' } },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['slots'],
    properties: {
      slots: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          required: ['content', 'claimRefs'],
          properties: {
            content: { type: 'string' },
            claimRefs: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  system:
    'You write restrained B2B website copy. The Claim snapshot is the only factual authority. Never infer, normalize, convert, or add a fact.',
  buildPrompt: (input) =>
    [
      `Write every requested slot in canonical locale ${input.locale}.`,
      `Source locale is ${input.sourceLocale}; do not fall back to it in the output.`,
      'Use a Claim only when its exact claimId is returned in claimRefs.',
      'Numbers, units, company/model names, and certification identifiers must remain byte-for-byte unchanged.',
      'If no Claim supports a factual statement, write neutral non-factual copy and return no claimRefs.',
      'Do not emit HTML. Respect each maxGraphemes budget; do not truncate.',
      `Frozen snapshot digest: ${input.snapshotDigest}`,
      `Frozen Claims: ${JSON.stringify(input.claims)}`,
      `Slot catalog: ${JSON.stringify(input.slots)}`,
      'Return JSON: {slots:{[key]:{content:string,claimRefs:string[]}}}.',
    ].join('\n'),
  validateOutput: validateCopyTaskOutput,
  repairTaskOutput: true,
};
