import type { EsrAnalysis, IndexKeyField, Predicate } from './types.ts';

/**
 * Equality, Sort, Range.
 *
 * An index narrows only on its leading fields, and only up to the first range.
 * So the order is not a style preference: equality fields first (each one cuts
 * the scan), then the sort field (free ordering, no in-memory sort), then range
 * fields (which end the useful prefix). Get it backwards and you get an index
 * that is used, scans most of itself, and looks fine in the plan.
 *
 * This function states the order. It does not decide whether the index is worth
 * creating — that needs write volume and cardinality, which no explain output
 * carries.
 */
export function buildEsr(
  predicates: readonly Predicate[],
  sortPattern: readonly IndexKeyField[],
): EsrAnalysis {
  const equality = predicates.filter((p) => p.kind === 'equality').map((p) => p.field);
  const unsupported = predicates.filter((p) => p.kind === 'unsupported');

  // A field pinned to a single value is already in order; sorting by it adds
  // nothing, so it stays in E and drops out of S.
  const sort = sortPattern.filter((field) => !equality.includes(field.field));

  const range = predicates
    .filter((p) => p.kind === 'range')
    .map((p) => p.field)
    .filter((field) => !sort.some((entry) => entry.field === field));

  return {
    equality,
    sort,
    range,
    unsupported,
    recommendedKey: [
      ...equality.map((field) => ({ field, direction: 1 })),
      ...sort,
      ...range.map((field) => ({ field, direction: 1 })),
    ],
  };
}

/**
 * Notes on the ordering that are true regardless of the collection, printed with
 * the analysis so the reader can weigh the suggestion instead of trusting it.
 */
export function esrCaveats(esr: EsrAnalysis): string[] {
  const caveats: string[] = [];

  if (esr.equality.length > 1) {
    caveats.push(
      'Order among the equality fields barely matters to the planner; put the most' +
        ' selective first if you know which it is.',
    );
  }
  if (esr.sort.length > 1 && mixedDirections(esr.sort)) {
    caveats.push(
      'The sort mixes directions, so the index has to match it exactly or be its exact' +
        ' inverse — { a: 1, b: -1 } serves that sort, { a: 1, b: 1 } does not.',
    );
  }
  if (esr.range.length > 1) {
    caveats.push(
      'Only the first range field narrows the scan. A second one is tested after the' +
        ' index is read, so its position in the key buys nothing.',
    );
  }
  return caveats;
}

function mixedDirections(sort: readonly IndexKeyField[]): boolean {
  return new Set(sort.map((field) => field.direction)).size > 1;
}
