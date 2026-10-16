import { isObject, type Json } from '../json.ts';
import type { Predicate, PredicateKind } from './types.ts';

/**
 * Filter document -> classified predicates.
 *
 * The input is normally `queryPlanner.parsedQuery`, which the server has already
 * canonicalised into `{ field: { $op: value } }` form — so this parser handles
 * that shape well and the shapes people write by hand well enough.
 *
 * The bias throughout is to give up loudly. An operator this does not recognise
 * becomes `unsupported`, which blocks any command downstream and gets printed.
 * Guessing at `$elemMatch` semantics to produce a confident-looking suggestion
 * is exactly how these tools earn their reputation.
 */

const EQUALITY_OPERATORS = new Set(['$eq', '$in']);
const RANGE_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte']);

/** Operators whose whole point is that an index cannot narrow on them. */
const NON_SELECTIVE_OPERATORS = new Set(['$ne', '$nin', '$not', '$exists']);

export function readPredicates(filter: Json | undefined): Predicate[] {
  const collected = new Map<string, { operators: Set<string>; kinds: Set<PredicateKind> }>();

  const add = (field: string, operator: string, kind: PredicateKind): void => {
    const entry = collected.get(field) ?? { operators: new Set(), kinds: new Set() };
    entry.operators.add(operator);
    entry.kinds.add(kind);
    collected.set(field, entry);
  };

  const visit = (node: Json | undefined): void => {
    if (!isObject(node)) return;

    for (const [key, value] of Object.entries(node)) {
      if (key === '$and') {
        // The only combinator a single index can serve: every clause must match,
        // so their fields can all live in one key.
        for (const clause of Array.isArray(value) ? value : []) visit(clause);
      } else if (key.startsWith('$')) {
        // $or, $nor, $expr, $text and friends. A single index does not serve
        // them the way this analysis assumes, so we decline rather than pretend.
        add(key, key, 'unsupported');
      } else {
        add(key, ...classify(value));
      }
    }
  };

  visit(filter);

  return [...collected].map(([field, entry]) => ({
    field,
    kind: worstKind(entry.kinds),
    operators: [...entry.operators].sort(),
  }));
}

/** One field's value: either a bare equality or an operator document. */
function classify(value: Json): [operator: string, kind: PredicateKind] {
  if (!isObject(value)) return ['$eq', 'equality'];

  const operators = Object.keys(value).filter((key) => key.startsWith('$'));
  // `{ field: { nested: 1 } }` is an equality match on a whole subdocument.
  if (operators.length === 0) return ['$eq', 'equality'];

  const first = operators[0]!;
  if (EQUALITY_OPERATORS.has(first)) return [first, 'equality'];
  if (RANGE_OPERATORS.has(first)) return [first, 'range'];
  if (NON_SELECTIVE_OPERATORS.has(first)) return [first, 'unsupported'];
  return [first, 'unsupported'];
}

/** A field with both a range and an equality is a range for ordering purposes. */
function worstKind(kinds: ReadonlySet<PredicateKind>): PredicateKind {
  if (kinds.has('unsupported')) return 'unsupported';
  if (kinds.has('range')) return 'range';
  return 'equality';
}

/** True when this field's filter is a plain `field: value` equality and nothing else. */
export function isPlainEquality(predicate: Predicate): boolean {
  return predicate.kind === 'equality' && predicate.operators.join() === '$eq';
}
