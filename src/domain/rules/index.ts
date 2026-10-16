import { collectionScanRule } from './collection-scan.ts';
import { diskSpillRule } from './disk-spill.ts';
import { scanRatioRule } from './scan-ratio.ts';
import { unindexedSortRule } from './unindexed-sort.ts';
import { unselectiveIndexRule } from './unselective-index.ts';
import type { Rule } from './types.ts';

/**
 * The registry, in evaluation order.
 *
 * Order is part of the contract: a rule may look at what earlier rules found and
 * stay quiet rather than restate it. So the specific diagnoses run first and the
 * catch-all runs last — `scan-ratio` says "you read far more than you returned",
 * which is true of a collection scan and of an unselective index too, and is
 * only worth printing when neither of those already explained it.
 */
export const RULES: readonly Rule[] = [
  diskSpillRule,
  collectionScanRule,
  unselectiveIndexRule,
  scanRatioRule,
  unindexedSortRule,
];

export { collectionScanRule, diskSpillRule, scanRatioRule, unindexedSortRule, unselectiveIndexRule };
export * from './types.ts';
