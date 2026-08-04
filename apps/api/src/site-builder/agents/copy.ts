import type { SiteBuilderTaskDefinition } from "./ai-task";
import type {
  CopyGenerationContext,
  CopySlotDefinition,
  CopySlotGeneratorResult,
} from "../copy-bundle.service";
import {
  COPY_GENERATION_CONTRACT_VERSION,
  copyGenerationContextDigest,
  validateCopySlotGeneratorOutput,
} from "../copy-bundle.service";
import type { PublishableClaimSnapshotItem } from "../publishable-claim-snapshot";

export interface CopyTaskInput {
  locale: string;
  sourceLocale: string;
  snapshotDigest: string;
  claims: PublishableClaimSnapshotItem[];
  slots: CopySlotDefinition[];
  context: CopyGenerationContext;
  contextDigest: string;
}

export interface CopyTaskOutput {
  slots: Record<string, CopySlotGeneratorResult>;
}

export function isCopyTaskInputV2(value: unknown): value is CopyTaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CopyTaskInput>;
  return Boolean(
    candidate.context &&
    typeof candidate.contextDigest === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.contextDigest) &&
    copyGenerationContextDigest(candidate.context) === candidate.contextDigest,
  );
}

function validateCopyTaskOutput(
  input: CopyTaskInput,
  output: CopyTaskOutput,
): void {
  if (copyGenerationContextDigest(input.context) !== input.contextDigest) {
    throw new Error("COPY_CONTEXT_DIGEST_MISMATCH");
  }
  if (!output || typeof output !== "object" || !output.slots) {
    throw new Error("copy output has no slots");
  }
  const expected = [...input.slots.map((slot) => slot.key)].sort();
  const actual = Object.keys(output.slots).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("copy output slot keys do not match the frozen catalog");
  }
  const claims = new Map(
    input.claims.map((claim) => [
      claim.claimId,
      { statement: claim.statement },
    ]),
  );
  const slots = new Map(input.slots.map((slot) => [slot.key, slot]));
  for (const [key, outputSlot] of Object.entries(output.slots)) {
    if (
      typeof outputSlot?.content !== "string" ||
      !Array.isArray(outputSlot.claimRefs) ||
      outputSlot.claimRefs.some((claimId) => typeof claimId !== "string")
    ) {
      throw new Error(`copy output slot ${key} is malformed`);
    }
    validateCopySlotGeneratorOutput({
      locale: input.locale,
      slot: slots.get(key)!,
      output: outputSlot,
      claims,
      context: input.context,
    });
  }
}

export const COPY_TASK: SiteBuilderTaskDefinition<
  CopyTaskInput,
  CopyTaskOutput
> = {
  id: "site_builder.copy",
  contractVersion: COPY_GENERATION_CONTRACT_VERSION,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "locale",
      "sourceLocale",
      "snapshotDigest",
      "claims",
      "slots",
      "context",
      "contextDigest",
    ],
    properties: {
      locale: { type: "string" },
      sourceLocale: { type: "string" },
      snapshotDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      claims: { type: "array", items: { type: "object" } },
      slots: { type: "array", items: { type: "object" } },
      contextDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      context: {
        type: "object",
        additionalProperties: false,
        required: [
          "audience",
          "brandVoice",
          "prohibitedAssertions",
          "ctaPolicy",
        ],
        properties: {
          audience: {
            type: "object",
            additionalProperties: false,
            required: ["industry", "products", "targetMarkets"],
            properties: {
              industry: { type: ["string", "null"], maxLength: 160 },
              products: {
                type: "array",
                maxItems: 24,
                uniqueItems: true,
                items: { type: "string", maxLength: 160 },
              },
              targetMarkets: {
                type: "array",
                maxItems: 24,
                uniqueItems: true,
                items: { type: "string", maxLength: 160 },
              },
            },
          },
          brandVoice: {
            type: "object",
            additionalProperties: false,
            required: ["voice", "style", "sourceRef"],
            properties: {
              voice: { type: "string", minLength: 1, maxLength: 160 },
              style: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 80 },
              },
              sourceRef: { type: "string", minLength: 1, maxLength: 256 },
            },
          },
          prohibitedAssertions: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 80 },
          },
          ctaPolicy: {
            type: "object",
            additionalProperties: false,
            required: ["intent", "allowedLabels"],
            properties: {
              intent: { type: "string", const: "contact" },
              allowedLabels: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 48 },
              },
            },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slots"],
    properties: {
      slots: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["content", "claimRefs"],
          properties: {
            content: { type: "string" },
            claimRefs: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  system:
    "You write restrained B2B website copy. The Claim snapshot is the only factual authority. Never infer, normalize, convert, or add a fact.",
  buildPrompt: (input) =>
    [
      `Write every requested slot in canonical locale ${input.locale}.`,
      `Source locale is ${input.sourceLocale}; do not fall back to it in the output.`,
      "Use a Claim only when its exact claimId is returned in claimRefs.",
      'For any slot with claimRefs, content must be the cited Claim statement text byte-for-byte; join multiple statements with exactly " · ". Do not translate or embellish those statements.',
      "Numbers, units, company/model names, and certification identifiers must remain byte-for-byte unchanged.",
      "If no Claim supports a factual statement, write neutral non-factual copy and return no claimRefs.",
      "Audience context guides vocabulary only and is never factual authority about the company.",
      "Follow the frozen brand voice for creative non-factual slots without adding measurable, certification, ranking, customer, geography, tenure, or guarantee claims.",
      "CTA slots must use one exact label from ctaPolicy.allowedLabels.",
      "Never emit a phrase listed in prohibitedAssertions unless it appears byte-for-byte in a cited Claim.",
      "Do not emit HTML. Respect each maxGraphemes budget; do not truncate.",
      `Frozen snapshot digest: ${input.snapshotDigest}`,
      `Frozen generation context digest: ${input.contextDigest}`,
      `Frozen generation context: ${JSON.stringify(input.context)}`,
      `Frozen Claims: ${JSON.stringify(input.claims)}`,
      `Slot catalog: ${JSON.stringify(input.slots)}`,
      "Return JSON: {slots:{[key]:{content:string,claimRefs:string[]}}}.",
    ].join("\n"),
  validateOutput: validateCopyTaskOutput,
  repairTaskOutput: true,
};
