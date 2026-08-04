import { createHash } from "node:crypto";

export const NATIVE_WEAK_SET_ADD = WeakSet.prototype.add;
export const NATIVE_WEAK_SET_HAS = WeakSet.prototype.has;
export const NATIVE_OBJECT_FREEZE = Object.freeze;
export const NATIVE_OBJECT_IS_FROZEN = Object.isFrozen;
export const NATIVE_OBJECT_VALUES = Object.values;
export const NATIVE_OBJECT_KEYS = Object.keys;
const NATIVE_OBJECT_ENTRIES = Object.entries;
export const NATIVE_OBJECT_HAS_OWN = Object.hasOwn;
export const NATIVE_STRUCTURED_CLONE = structuredClone;
export const NATIVE_APPLY = Reflect.apply;
export const NATIVE_ARRAY_IS_ARRAY = Array.isArray;
const NATIVE_ARRAY_MAP = Array.prototype.map;
const NATIVE_ARRAY_SORT = Array.prototype.sort;
const NATIVE_ARRAY_EVERY = Array.prototype.every;
const NATIVE_ARRAY_SOME = Array.prototype.some;
const NATIVE_ARRAY_FIND = Array.prototype.find;
const NATIVE_REGEXP_TEST = RegExp.prototype.test;
export const NATIVE_NUMBER_IS_FINITE = Number.isFinite;
export const NATIVE_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
export const NATIVE_DATE = Date;
export const NATIVE_DATE_PARSE = Date.parse;
export const NATIVE_DATE_TO_ISO_STRING = Date.prototype.toISOString;
const NATIVE_JSON_STRINGIFY = JSON.stringify;
const NATIVE_BIGINT = BigInt;
const NATIVE_BIGINT_TO_STRING = BigInt.prototype.toString;
export const NATIVE_MATH_MAX = Math.max;
const NATIVE_CREATE_HASH = createHash;
const NATIVE_HASH = NATIVE_CREATE_HASH("sha256");
const NATIVE_HASH_UPDATE = NATIVE_HASH.update;
const NATIVE_HASH_DIGEST = NATIVE_HASH.digest;

export function nativeArrayMap<T, U>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => U,
): U[] {
  return NATIVE_APPLY(NATIVE_ARRAY_MAP, values, [callback]) as U[];
}

export function nativeArraySort<T>(values: T[]): T[] {
  return NATIVE_APPLY(NATIVE_ARRAY_SORT, values, []) as T[];
}

export function nativeArraySortBy<T>(
  values: T[],
  callback: (left: T, right: T) => number,
): T[] {
  return NATIVE_APPLY(NATIVE_ARRAY_SORT, values, [callback]) as T[];
}

export function nativeArrayEvery<T>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => boolean,
): boolean {
  return NATIVE_APPLY(NATIVE_ARRAY_EVERY, values, [callback]) as boolean;
}

export function nativeArraySome<T>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => boolean,
): boolean {
  return NATIVE_APPLY(NATIVE_ARRAY_SOME, values, [callback]) as boolean;
}

export function nativeArrayFind<T>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => boolean,
): T | undefined {
  return NATIVE_APPLY(NATIVE_ARRAY_FIND, values, [callback]) as T | undefined;
}

export function nativeRegExpTest(pattern: RegExp, value: string): boolean {
  return NATIVE_APPLY(NATIVE_REGEXP_TEST, pattern, [value]) as boolean;
}

export function nativeBigInt(value: number | string | bigint): bigint {
  return NATIVE_BIGINT(value);
}

export function nativeBigIntToString(value: bigint): string {
  return NATIVE_APPLY(NATIVE_BIGINT_TO_STRING, value, []) as string;
}

export function nativeSha256Text(value: string): string {
  const hash = NATIVE_CREATE_HASH("sha256");
  NATIVE_APPLY(NATIVE_HASH_UPDATE, hash, [value]);
  return NATIVE_APPLY(NATIVE_HASH_DIGEST, hash, ["hex"]) as string;
}

export function nativeCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (NATIVE_ARRAY_IS_ARRAY(value)) {
    let output = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (!NATIVE_APPLY(NATIVE_OBJECT_HAS_OWN, Object, [value, index])) {
        throw new Error(
          "remaining text evidence must not contain sparse arrays",
        );
      }
      if (index > 0) output += ",";
      output += nativeCanonicalJson(value[index]);
    }
    return `${output}]`;
  }
  if (typeof value === "object") {
    const entries = NATIVE_OBJECT_ENTRIES(value as Record<string, unknown>);
    NATIVE_APPLY(NATIVE_ARRAY_SORT, entries, [
      ([left]: [string, unknown], [right]: [string, unknown]) =>
        left < right ? -1 : left > right ? 1 : 0,
    ]);
    let output = "{";
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) throw new Error("remaining text evidence entry is absent");
      if (index > 0) output += ",";
      output += `${NATIVE_JSON_STRINGIFY(entry[0])}:${nativeCanonicalJson(entry[1])}`;
    }
    return `${output}}`;
  }
  const serialized = NATIVE_JSON_STRINGIFY(value);
  if (typeof serialized !== "string") {
    throw new Error("remaining text evidence is not JSON-serializable");
  }
  return serialized;
}
