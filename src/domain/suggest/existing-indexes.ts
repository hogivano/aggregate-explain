import { isObject, type Json, type JsonObject } from '../json.ts';
import { formatShellValue } from '../units.ts';
import type { IndexInfo, IndexKeyField } from './types.ts';

/**
 * What we know about the indexes that already exist — and, just as important,
 * how we know it.
 *
 * There are two sources and they are not interchangeable. The collection context
 * is the full list, straight from `getIndexes()`. The plan is a partial view:
 * it names only the indexes the planner considered for this one query, and a
 * COLLSCAN plan names none at all. Suggesting an index from the second source
 * is how you end up recommending a duplicate of one that was there all along.
 */

/**
 * Parses the index list in any of the three shapes it arrives in:
 * `getIndexes()` output, `{ indexes, documentCount }`, and the older
 * `indexInformation()` map — `{ _id_: [['_id', 1]] }` — which is what a
 * Mongoose 5 collection is most likely to hand back.
 */
export function readIndexes(input: Json | undefined): IndexInfo[] {
  const array = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input['indexes'])
      ? input['indexes']
      : undefined;

  if (array === undefined) return isObject(input) ? readIndexInformation(input) : [];
  return array.filter(isObject).map(readIndex).filter((index) => index.key.length > 0);
}

/** `{ _id_: [['_id', 1]] }` — name to key pairs. */
function readIndexInformation(input: JsonObject): IndexInfo[] {
  return Object.entries(input)
    .map(([name, pairs]) => ({
      name,
      key: (Array.isArray(pairs) ? pairs : [])
        .filter((pair): pair is [string, number | string] => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && (typeof pair[1] === 'number' || typeof pair[1] === 'string'))
        .map(([field, direction]) => ({ field, direction })),
    }))
    .filter((index) => index.key.length > 0);
}

function readIndex(raw: JsonObject): IndexInfo {
  const key = isObject(raw['key']) ? raw['key'] : {};
  const info: IndexInfo = {
    name: typeof raw['name'] === 'string' ? raw['name'] : keyToString(readKey(key)),
    key: readKey(key),
  };

  // Only carry the qualifiers that change whether an index serves a query.
  return {
    ...info,
    ...(raw['unique'] === true ? { unique: true } : {}),
    ...(raw['sparse'] === true ? { sparse: true } : {}),
    ...(raw['partialFilterExpression'] !== undefined
      ? { partialFilterExpression: raw['partialFilterExpression'] }
      : {}),
  };
}

function readKey(key: JsonObject): IndexKeyField[] {
  return Object.entries(key)
    .filter((entry): entry is [string, number | string] => {
      const [, direction] = entry;
      return typeof direction === 'number' || typeof direction === 'string';
    })
    .map(([field, direction]) => ({ field, direction }));
}

/**
 * Indexes named anywhere in the explain payload — winning plan, rejected plans,
 * every shard. Scanned structurally rather than at known paths, because rejected
 * plans move around between server versions and a missed index here would turn a
 * duplicate suggestion into a printed one.
 */
export function indexesFromPlan(raw: Json): IndexInfo[] {
  const found = new Map<string, IndexInfo>();

  const visit = (node: Json): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!isObject(node)) return;

    const name = node['indexName'];
    const keyPattern = node['keyPattern'];
    if (typeof name === 'string' && isObject(keyPattern) && !found.has(name)) {
      found.set(name, { name, key: readKey(keyPattern) });
    }
    for (const value of Object.values(node)) visit(value);
  };

  visit(raw);
  return [...found.values()];
}

/** `{ status: 1, createdAt: -1 }` — the form people write and read. */
export function keyToString(key: readonly IndexKeyField[]): string {
  return formatShellValue(Object.fromEntries(key.map((field) => [field.field, field.direction])));
}

/**
 * An index that already serves `candidate`: one whose leading fields are exactly
 * the candidate's, in order. Anything longer still serves it — a query only
 * needs a prefix of the key.
 */
export function servedBy(
  indexes: readonly IndexInfo[],
  candidate: readonly IndexKeyField[],
): IndexInfo | undefined {
  if (candidate.length === 0) return undefined;
  return indexes.find((index) =>
    candidate.every((field, position) => index.key[position]?.field === field.field),
  );
}

/** Indexes that already lead with this field — the duplicate-prefix trap. */
export function leadingWith(indexes: readonly IndexInfo[], field: string): IndexInfo[] {
  return indexes.filter((index) => index.key[0]?.field === field);
}
