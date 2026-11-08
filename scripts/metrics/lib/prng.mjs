// Deterministic PRNG helpers for reproducible sampling and bootstrap.
//
// ch01 §6.3 requires fixed seeds: anyone with the same pool, seed and script
// must reproduce the same sample and the same bootstrap interval. Pure Node
// built-ins only.

/** FNV-1a 64-bit style string hash → 32-bit unsigned seed. */
export function seedFromString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG: tiny, fast, good enough for sampling/bootstrap. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Create a PRNG from a seed string and an optional namespace (e.g. dataset). */
export function createRng(seed, namespace = "") {
  return mulberry32(seedFromString(`${seed}::${namespace}`));
}

/** Fisher–Yates shuffle (in place) driven by the supplied rng. */
export function shuffle(values, rng) {
  const array = [...values];
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [array[index], array[swap]] = [array[swap], array[index]];
  }
  return array;
}

/** Draw n distinct items uniformly without replacement (order randomized). */
export function sampleWithoutReplacement(values, count, rng) {
  if (count > values.length) {
    throw new Error(`cannot sample ${count} items from a pool of ${values.length}`);
  }
  return shuffle(values, rng).slice(0, count);
}

/** Poisson draw via Knuth for small means, normal approximation for large. */
export function poisson(lambda, rng) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const limit = Math.exp(-lambda);
    let product = 1;
    let count = 0;
    do {
      count += 1;
      product *= rng();
    } while (product > limit);
    return count - 1;
  }
  // Normal approximation with continuity correction.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal));
}

/** Quantile of a numeric sample (linear interpolation); p in [0, 1]. */
export function quantile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
