export * from './types.ts';
export { readPredicates, isPlainEquality } from './predicates.ts';
export { buildEsr, esrCaveats } from './esr.ts';
export { indexesFromPlan, keyToString, leadingWith, readIndexes, servedBy } from './existing-indexes.ts';
export { suggestIndexes } from './suggest.ts';
export type { SuggestOptions } from './suggest.ts';
