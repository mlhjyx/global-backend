import { isReviewedModelIdentity } from './model-identity';

/**
 * Deployment-level permission to accept a substitute model identity
 * (owner decision D14, 2026-10-11). The acquisition gateway's only upstream
 * sometimes answers deepseek-v4-pro requests with DeepSeek V4 Flash. Instead
 * of failing those calls, a deployment may accept the substitute for registry
 * tasks that opt in (`acceptsModelSubstitute`). An answer the substitute
 * produced is recorded under the substitute's name, never the requested one,
 * and the trace flags every call a substitute answered.
 *
 * Format: comma-separated `requested>accepted` pairs, e.g.
 * `MODEL_IDENTITY_SUBSTITUTES=deepseek-v4-pro>deepseek-v4-flash`.
 * Unset or empty means no substitution (the default).
 */
export const MODEL_IDENTITY_SUBSTITUTES_ENV = 'MODEL_IDENTITY_SUBSTITUTES';

/** requested model -> substitutes a deployment accepts in its place. */
export type ModelIdentitySubstitutes = ReadonlyMap<string, readonly string[]>;

/**
 * Substitutions this repository has reviewed. A deployment can switch these
 * on, never invent others: a pair outside this list fails startup.
 */
const REVIEWED_MODEL_SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'deepseek-v4-pro': Object.freeze(['deepseek-v4-flash']),
  });

const MAX_SETTING_LENGTH = 1024;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;

/**
 * Read-only view over a private Map. It is not itself a Map, so neither its
 * own API nor Map.prototype.set/delete/clear can change the entries.
 */
class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]> = []) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.#entries.forEach((value, key) =>
      callbackfn.call(thisArg, value, key, this),
    );
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries[Symbol.iterator]();
  }
}

const NO_SUBSTITUTES: ModelIdentitySubstitutes = new FrozenMap<
  string,
  readonly string[]
>();

/** Whether this repository has reviewed `substitute` standing in for `requested`. */
export function isReviewedModelSubstitution(
  requested: string,
  substitute: string,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(
      REVIEWED_MODEL_SUBSTITUTIONS,
      requested,
    ) && REVIEWED_MODEL_SUBSTITUTIONS[requested]!.includes(substitute)
  );
}

function invalid(reason: string): never {
  throw new Error(`MODEL_IDENTITY_SUBSTITUTES_INVALID: ${reason}`);
}

function modelName(value: string, side: 'requested' | 'accepted'): string {
  const name = value.trim();
  if (!MODEL_IDENTIFIER.test(name)) invalid(`malformed ${side} model`);
  if (!isReviewedModelIdentity(name)) invalid(`unknown ${side} model ${name}`);
  return name;
}

/**
 * Parse and validate the deployment setting. Runs at startup; any malformed
 * pair, unknown model or unreviewed substitution throws so the process does
 * not start with a setting it cannot honour.
 */
export function parseModelIdentitySubstitutes(
  raw: string | undefined,
): ModelIdentitySubstitutes {
  if (raw === undefined || raw.trim() === '') return NO_SUBSTITUTES;
  if (raw.length > MAX_SETTING_LENGTH) invalid('value too long');
  const accepted = new Map<string, string[]>();
  for (const entry of raw.split(',')) {
    const sides = entry.split('>');
    if (sides.length !== 2) invalid('each pair must be requested>accepted');
    const requested = modelName(sides[0]!, 'requested');
    const substitute = modelName(sides[1]!, 'accepted');
    if (requested === substitute) invalid(`${requested} cannot substitute itself`);
    if (!isReviewedModelSubstitution(requested, substitute)) {
      invalid(`substitution ${requested}>${substitute} is not reviewed`);
    }
    const list = accepted.get(requested) ?? [];
    if (list.includes(substitute)) {
      invalid(`duplicate pair ${requested}>${substitute}`);
    }
    accepted.set(requested, [...list, substitute]);
  }
  return new FrozenMap<string, readonly string[]>(
    [...accepted].map(([requested, list]) => [
      requested,
      Object.freeze([...list]),
    ]),
  );
}
