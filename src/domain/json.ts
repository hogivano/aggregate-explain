/**
 * The core takes an object it did not create and cannot trust: explain output
 * arrives from a server version we may not have seen, through a driver or a
 * shell that may have reshaped it. Every read of that object goes through the
 * accessors here, so a missing or wrong-typed field becomes `undefined` at the
 * edge instead of a `TypeError` three rules later.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object at `key`, or undefined if it is absent or not an object. */
export function objectAt(source: JsonObject, key: string): JsonObject | undefined {
  const value = source[key];
  return isObject(value) ? value : undefined;
}

/** The array at `key`, or undefined. Elements are not inspected. */
export function arrayAt(source: JsonObject, key: string): Json[] | undefined {
  const value = source[key];
  return Array.isArray(value) ? value : undefined;
}

export function stringAt(source: JsonObject, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function booleanAt(source: JsonObject, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * A number, accepting the Extended JSON wrappers a driver emits for 64-bit
 * values: `{"$numberLong": "8589934592"}` is the same fact as `8589934592`, and
 * spill counters are exactly the fields large enough to arrive that way.
 *
 * `$numberLong` values beyond `Number.MAX_SAFE_INTEGER` lose precision here. We
 * accept that: these are byte counts we round to megabytes anyway.
 */
export function numberAt(source: JsonObject, key: string): number | undefined {
  return toNumber(source[key]);
}

function toNumber(value: Json | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!isObject(value)) return undefined;

  for (const wrapper of ['$numberLong', '$numberInt', '$numberDouble', '$numberDecimal']) {
    const inner = value[wrapper];
    if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
    if (typeof inner === 'string') {
      const parsed = Number(inner);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}
