import type { ModelResult } from '../model-gateway/types';
import {
  parseGenericOperationProjection,
  projectGenericOperationResult,
  type GenericOperationProjection,
} from '../tools/generic-operation-projection';
import type { TypedProjectionSchema } from './durable-result-strategy';
import { registerModelResultProjections } from './model-result-projections';
import { TypedProjectionRegistry } from './typed-projection.registry';

const registry = registerModelResultProjections(new TypedProjectionRegistry());
registry.freeze();

function invalid(): never {
  throw new Error('MODEL_RESULT_REPLAY_INVALID');
}

function resultEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'result' ||
    !Object.hasOwn(record, 'result')
  ) {
    invalid();
  }
  return record.result;
}

function ordinaryJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export function projectModelResultForReplay(
  schema: TypedProjectionSchema,
  result: ModelResult<unknown>,
): GenericOperationProjection {
  try {
    const envelope = registry.project(schema, result);
    return projectGenericOperationResult({
      kind: 'model',
      schema,
      data: { result: ordinaryJson(envelope) },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'MODEL_RESULT_REPLAY_INVALID') {
      throw error;
    }
    invalid();
  }
}

export function restoreModelResultFromReplay(
  schema: TypedProjectionSchema,
  projection: unknown,
): ModelResult<unknown> {
  try {
    const parsed = parseGenericOperationProjection(projection);
    if (parsed.kind !== 'model' || parsed.schema !== schema) invalid();
    const restored = registry.restore(resultEnvelope(parsed.data)) as ModelResult<unknown>;
    const verified = projectModelResultForReplay(schema, restored);
    if (verified.digest !== parsed.digest) invalid();
    return restored;
  } catch (error) {
    if (error instanceof Error && error.message === 'MODEL_RESULT_REPLAY_INVALID') {
      throw error;
    }
    invalid();
  }
}
