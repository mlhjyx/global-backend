import {
  boundedArray,
  boundedString,
  closedObject,
} from "../ai-tasks/task-schema-bounds";
import { parseDraft } from "../market-candidates/market-candidate-set.document";
import type {
  MarketCandidateDraftDto,
  MarketCandidateSetDraftV1Dto,
} from "../market-candidates/dto/market-candidate-set.dto";
import {
  assertModelOutputSchemaCompiles,
  checkAgainstSchema,
} from "../model-gateway/schema-validate";
import {
  generationCanonicalJson,
  invalidGenerationInput,
  type GenerationBasisDescriptors,
} from "./generation-basis";
export interface GenerationOutput {
  outcome: "CANDIDATES_PROPOSED" | "COMPLETED_EMPTY";
  candidates: MarketCandidateDraftDto[];
}
const text = boundedString(2000, { minLength: 1 });
const statementProperties = {
  text,
  knowledgeState: boundedString(32, {
    enum: ["SELLER_ASSERTION", "INFERENCE", "CONFLICT", "UNKNOWN"],
  }),
  basisKeys: boundedArray(200, boundedString(80)),
  impact: text,
};
const statement = closedObject(
  statementProperties,
  Object.keys(statementProperties),
);
const proposalProperties = {
  supplyOrCapability: closedObject(
    { offeringId: boundedString(36, { minLength: 36 }), description: text },
    ["offeringId", "description"],
  ),
  buyerOrganizationCountry: {
    oneOf: [boundedString(2, { minLength: 2 }), { type: "null" }],
  },
  projectCountry: {
    oneOf: [boundedString(2, { minLength: 2 }), { type: "null" }],
  },
  application: statement,
  organizationRole: statement,
  fitExplanation: statement,
  entryConditions: boundedArray(200, statement),
  support: boundedArray(200, statement),
  counterEvidence: boundedArray(200, statement),
  gaps: boundedArray(200, statement),
  recommendation: closedObject(
    {
      status: boundedString(32, {
        enum: [
          "COMPARABLE",
          "CONDITIONAL",
          "INSUFFICIENT_EVIDENCE",
          "NOT_RECOMMENDED",
        ],
      }),
      reason: text,
    },
    ["status", "reason"],
  ),
  nextVerification: boundedArray(200, text),
};
export const GENERATION_OUTPUT_SCHEMA = closedObject(
  {
    outcome: boundedString(32, {
      enum: ["CANDIDATES_PROPOSED", "COMPLETED_EMPTY"],
    }),
    candidates: boundedArray(
      100,
      closedObject(
        {
          proposal: closedObject(
            proposalProperties,
            Object.keys(proposalProperties),
          ),
        },
        ["proposal"],
      ),
    ),
  },
  ["outcome", "candidates"],
);
export function validateGenerationOutput(
  value: unknown,
  basis: GenerationBasisDescriptors,
): GenerationOutput {
  const encoded = generationCanonicalJson(value, 65_536),
    output = JSON.parse(encoded) as GenerationOutput;
  assertModelOutputSchemaCompiles(GENERATION_OUTPUT_SCHEMA);
  if (
    !checkAgainstSchema(GENERATION_OUTPUT_SCHEMA, output).valid ||
    !basis ||
    basis.sources.some(
      (s) =>
        !["OFFERING", "CLAIM"].includes(s.kind) ||
        s.key !== `${s.kind}:${s.sourceId}`,
    )
  )
    invalidGenerationInput();
  const draft = parseDraft({
    generationOutcome: output.outcome,
    sources: basis.sources.map((s) => ({ kind: s.kind, sourceId: s.sourceId })),
    candidates: output.candidates,
  });
  return { outcome: draft.generationOutcome, candidates: draft.candidates };
}
export function generationOutputToDraft(
  value: unknown,
  basis: GenerationBasisDescriptors,
): MarketCandidateSetDraftV1Dto {
  const output = validateGenerationOutput(value, basis);
  return parseDraft({
    generationOutcome: output.outcome,
    sources: basis.sources.map((s) => ({ kind: s.kind, sourceId: s.sourceId })),
    candidates: output.candidates,
  });
}
