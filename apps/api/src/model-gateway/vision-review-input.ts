import {
  VISION_REVIEW_MATERIAL_CLASSES,
  type ReviewVisionInput,
} from './types';

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_VISION_IMAGES = 3;
const MAX_VISION_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_SCHEMA_JSON_CHARS = 64_000;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const BOUNDED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function hasOnlyAllowedEnumerableKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  for (const key in value) {
    if (
      Object.prototype.hasOwnProperty.call(value, key) &&
      !allowed.includes(key)
    ) {
      return false;
    }
  }
  return true;
}

function assertBoundedJsonSchema(schema: unknown): void {
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (Object.getPrototypeOf(schema) !== Object.prototype &&
      Object.getPrototypeOf(schema) !== null)
  ) {
    throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
  }
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: schema, depth: 0 },
  ];
  let nodes = 0;
  let approximateChars = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES || current.depth > MAX_SCHEMA_DEPTH) {
      throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
    }
    if (current.value === null) continue;
    if (typeof current.value === 'string') {
      approximateChars += current.value.length;
      if (approximateChars > MAX_SCHEMA_JSON_CHARS) {
        throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
      }
      continue;
    }
    if (
      typeof current.value === 'number' &&
      Number.isFinite(current.value)
    ) {
      continue;
    }
    if (typeof current.value === 'boolean') continue;
    if (typeof current.value !== 'object') {
      throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
    }
    const object = current.value as object;
    if (seen.has(object)) {
      // Reject cycles and shared mutable graph nodes before structuredClone.
      throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
    }
    seen.add(object);
    if (Object.getOwnPropertyDescriptor(object, 'toJSON')) {
      // JSON.stringify invokes even a non-enumerable own toJSON hook. Reject it
      // before serialization so user code cannot allocate or rewrite the value
      // after the bounded structural walk.
      throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
    }
    if (Array.isArray(object)) {
      if (object.length > MAX_SCHEMA_NODES) {
        // JSON.stringify expands sparse array holes to null; cap length before
        // it can allocate output proportional to attacker-controlled length.
        throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
      }
      for (let index = 0; index < object.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, index);
        // JSON schemas are JSON values, so sparse arrays and accessors are not
        // accepted. The length cap makes this index walk strictly bounded.
        if (!descriptor || !('value' in descriptor)) {
          throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
        }
        if (nodes + stack.length >= MAX_SCHEMA_NODES) {
          throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
        }
        stack.push({
          value: descriptor.value,
          depth: current.depth + 1,
        });
      }
      for (const key in object) {
        if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= object.length ||
          String(index) !== key
        ) {
          // Named array properties survive structuredClone but are omitted by
          // JSON.stringify, so accepting them would make the checked schema
          // differ from the owned snapshot.
          throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
        }
      }
      continue;
    }
    if (
      Object.getPrototypeOf(object) !== Object.prototype &&
      Object.getPrototypeOf(object) !== null
    ) {
      throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
    }
    // Do not use Object.entries/Object.keys here: either creates an unbounded
    // intermediate array before the node/character limits can reject it.
    for (const key in object as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
      }
      approximateChars += key.length;
      if (approximateChars > MAX_SCHEMA_JSON_CHARS) {
        throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
      }
      if (nodes + stack.length >= MAX_SCHEMA_NODES) {
        throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  let json: string;
  try {
    json = JSON.stringify(schema);
  } catch (error) {
    throw new Error('MODEL_OUTPUT_SCHEMA_INVALID', { cause: error });
  }
  if (json.length > MAX_SCHEMA_JSON_CHARS) {
    throw new Error('MODEL_OUTPUT_SCHEMA_INVALID');
  }
}

/**
 * Allocation-safe synchronous preflight. This must run before cloning bytes,
 * hashing images, reserving budget, or awaiting any external dependency.
 */
export function preflightVisionReviewInput(input: ReviewVisionInput): void {
  const runtimeInput = input as unknown as Record<string, unknown>;
  if (
    !input ||
    typeof input !== 'object' ||
    !hasOnlyAllowedEnumerableKeys(runtimeInput, [
      'task',
      'prompt',
      'system',
      'model',
      'schema',
      'images',
      'validateOutput',
      'maxTokens',
      'maxCostCents',
      'signal',
    ]) ||
    ![
      'site_builder.aesthetic_review',
      'site_builder.aesthetic_review.eval',
    ].includes(input.task) ||
    !BOUNDED_TOKEN.test(input.task) ||
    !BOUNDED_TOKEN.test(input.model) ||
    typeof input.prompt !== 'string' ||
    input.prompt.length < 1 ||
    input.prompt.length > 32_000 ||
    (input.system !== undefined &&
      (typeof input.system !== 'string' || input.system.length > 16_000)) ||
    !Number.isInteger(input.maxTokens) ||
    input.maxTokens < 1 ||
    input.maxTokens > 16_000 ||
    !Number.isInteger(input.maxCostCents) ||
    input.maxCostCents < 1 ||
    input.maxCostCents > 100 ||
    !Array.isArray(input.images) ||
    input.images.length < 1 ||
    input.images.length > MAX_VISION_IMAGES
  ) {
    throw new Error('VISION_REVIEW_INPUT_INVALID');
  }
  assertBoundedJsonSchema(input.schema);

  let totalBytes = 0;
  const artifactIds = new Set<string>();
  for (const image of input.images) {
    const runtime = image as unknown as Record<string, unknown>;
    if ('url' in runtime || 'imageUrl' in runtime || 'path' in runtime) {
      throw new Error('VISION_REVIEW_REMOTE_OR_PATH_INPUT_FORBIDDEN');
    }
    if (
      !hasOnlyAllowedEnumerableKeys(runtime, [
        'materialClass',
        'workspaceId',
        'artifactId',
        'sha256',
        'mimeType',
        'bytes',
        'target',
      ]) ||
      !VISION_REVIEW_MATERIAL_CLASSES.includes(image.materialClass) ||
      (image.materialClass === 'workspace_site_screenshot'
        ? !image.workspaceId || !BOUNDED_TOKEN.test(image.workspaceId)
        : image.workspaceId !== undefined) ||
      (input.task === 'site_builder.aesthetic_review.eval'
        ? image.materialClass !== 'model_eval_fixture'
        : image.materialClass !== 'workspace_site_screenshot') ||
      !BOUNDED_TOKEN.test(image.artifactId) ||
      artifactIds.has(image.artifactId) ||
      !SHA256.test(image.sha256) ||
      image.mimeType !== 'image/png' ||
      !(image.bytes instanceof Uint8Array) ||
      image.bytes.byteLength < PNG_SIGNATURE.length ||
      image.bytes.byteLength > MAX_VISION_IMAGE_BYTES ||
      PNG_SIGNATURE.some((byte, index) => image.bytes[index] !== byte) ||
      !image.target ||
      !hasOnlyAllowedEnumerableKeys(
        image.target as unknown as Record<string, unknown>,
        ['locale', 'pageId', 'breakpoint'],
      ) ||
      !BOUNDED_TOKEN.test(image.target.locale) ||
      !BOUNDED_TOKEN.test(image.target.pageId) ||
      ![375, 768, 1440].includes(image.target.breakpoint)
    ) {
      throw new Error('VISION_REVIEW_IMAGE_INVALID');
    }
    artifactIds.add(image.artifactId);
    totalBytes += image.bytes.byteLength;
  }
  if (totalBytes > MAX_VISION_TOTAL_BYTES) {
    throw new Error('VISION_REVIEW_IMAGE_BUDGET_EXCEEDED');
  }
}

function freezeJson(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const seen = new WeakSet<object>();
  const stack: object[] = [value as object];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(
      current as Record<string, unknown>,
    )) {
      if (child && typeof child === 'object') stack.push(child);
    }
    Object.freeze(current);
  }
}

/**
 * Takes an ownership snapshot before the first await. Caller mutation of model,
 * schema, image metadata, targets, or bytes can never rewrite the request or
 * the post-response provenance/schema gates.
 */
export function snapshotVisionReviewInput(
  input: ReviewVisionInput,
): ReviewVisionInput {
  preflightVisionReviewInput(input);
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
