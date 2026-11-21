import type { TypedProjectionDefinition } from "./typed-projection.types";
import { GENERATION_OUTPUT_SCHEMA } from "../market-candidate-generation/generation-output";
import {
  denseArray,
  field,
  modelResultSchema,
  ownDataRecord,
  projectModelResultEnvelope,
  projectionInvalid,
  readModelResult,
  restoreModelResult,
  type UnknownRecord,
} from "./model-result-projection-helpers";

function dataProjection(value: unknown): UnknownRecord {
  const data = ownDataRecord(
    value,
    ["outcome", "candidates"],
    ["outcome", "candidates"],
  );
  const outcome = field(data, "outcome"),
    candidates = denseArray(field(data, "candidates"));
  if ((outcome === "COMPLETED_EMPTY") !== (candidates.length === 0))
    projectionInvalid();
  return { outcome, candidates };
}

export const marketCandidateGenerationProjection: TypedProjectionDefinition<
  unknown,
  unknown
> = {
  schema: "market-candidates-generation/v1",
  jsonSchema: modelResultSchema(GENERATION_OUTPUT_SCHEMA),
  project(raw) {
    const result = readModelResult(
      raw,
      ["outcome", "candidates"],
      ["outcome", "candidates"],
    );
    return projectModelResultEnvelope(result, dataProjection(result.data));
  },
  restore(projected) {
    const result = projected as UnknownRecord & {
      readonly provider: string;
      readonly model: string;
    };
    return restoreModelResult(result, dataProjection(field(result, "data")));
  },
};
