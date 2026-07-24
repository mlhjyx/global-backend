import type { ReviewVisionInput } from './types';

function freezeJson(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeJson(child);
  }
  Object.freeze(value);
}

/**
 * Takes an ownership snapshot before the first await. Caller mutation of model,
 * schema, image metadata, targets, or bytes can never rewrite the request or
 * the post-response provenance/schema gates.
 */
export function snapshotVisionReviewInput(
  input: ReviewVisionInput,
): ReviewVisionInput {
  let schema: Record<string, unknown>;
  try {
    schema = structuredClone(input.schema);
  } catch (error) {
    throw new Error('VISION_REVIEW_INPUT_INVALID', { cause: error });
  }
  freezeJson(schema);
  const images = input.images.map((image) =>
    Object.freeze({
      ...image,
      bytes: Uint8Array.from(image.bytes),
      target: Object.freeze({ ...image.target }),
    }),
  );
  return Object.freeze({
    task: input.task,
    prompt: input.prompt,
    ...(input.system !== undefined ? { system: input.system } : {}),
    model: input.model,
    schema,
    images: Object.freeze(images),
    ...(input.validateOutput
      ? { validateOutput: input.validateOutput }
      : {}),
    maxTokens: input.maxTokens,
    maxCostCents: input.maxCostCents,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
