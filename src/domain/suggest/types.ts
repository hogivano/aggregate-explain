import type { FindingLocation } from '../finding.ts';
import type { Json } from '../json.ts';

/**
 * Index suggestions, and the constraints that make them safe to publish.
 *
 * The failure mode this whole module is designed around: a tool that recommends
 * an index duplicating a prefix of one already there, or an index on a field
 * with three distinct values. Both are worse than saying nothing — every index
 * slows writes and costs RAM, and a tool that once tanked someone's write
 * throughput gets uninstalled.
 *
 * So a *command* is emitted only when the case is unambiguous. Everything else
 * gets the analysis and an explicit statement of what made it ambiguous, and the
 * human makes the call.
 */

/** One index as `db.collection.getIndexes()` describes it. */
export interface IndexInfo {
  readonly name: string;
  /** Field order matters — this is the whole point of the analysis. */
  readonly key: ReadonlyArray<IndexKeyField>;
  readonly unique?: boolean;
  readonly sparse?: boolean;
  readonly partialFilterExpression?: Json;
}

export interface IndexKeyField {
  readonly field: string;
  /** `1`, `-1`, or a string for the special index types (`text`, `2dsphere`). */
  readonly direction: number | string;
}

/**
 * What explain output cannot tell us, and a suggestion must not be made without.
 *
 * Supply it from the same shell you captured the explain in:
 *
 *   { indexes: db.orders.getIndexes(), documentCount: db.orders.estimatedDocumentCount() }
 */
export interface CollectionContext {
  /** Every index on the collection. A partial list is worse than none. */
  readonly indexes: readonly IndexInfo[];
  readonly documentCount?: number;
}

export type PredicateKind = 'equality' | 'range' | 'unsupported';

/** One field's worth of filter, classified for the E-S-R ordering. */
export interface Predicate {
  readonly field: string;
  readonly kind: PredicateKind;
  /** The operators seen on this field, e.g. `['$gte', '$lt']`. */
  readonly operators: readonly string[];
}

/**
 * Equality, Sort, Range — the order an index's fields have to run in to serve a
 * query, and the reason "add an index on the field you filtered by" is so often
 * wrong advice.
 */
export interface EsrAnalysis {
  readonly equality: readonly string[];
  readonly sort: readonly IndexKeyField[];
  readonly range: readonly string[];
  /** Predicates we decline to reason about at all, with their operators. */
  readonly unsupported: readonly Predicate[];
  /** The key an index would need, in E-S-R order. */
  readonly recommendedKey: readonly IndexKeyField[];
}

export interface SuggestionCounts {
  readonly documentsExamined: number | undefined;
  readonly documentsReturned: number | undefined;
  /** From the collection context; explain output does not carry it. */
  readonly collectionDocuments: number | undefined;
  /** returned / examined — the share of what was read that survived the filter. */
  readonly selectivity: number | undefined;
  /**
   * Whether that share means what it looks like it means.
   *
   * After a collection scan it is the filter's selectivity outright: every
   * document was tested. After an index scan it is not — the index already
   * narrowed the read, so a filter that matches a thousandth of the collection
   * can show 100% here. Reading the second as the first is how you talk someone
   * out of an index that would have helped.
   */
  readonly selectivityMeasuresFilter: boolean;
}

export interface IndexSuggestion {
  readonly namespace: string | undefined;
  /** Collection name alone, for the command. */
  readonly collection: string | undefined;
  /** The stage that prompted the analysis. */
  readonly location: FindingLocation;
  readonly esr: EsrAnalysis;
  /** Every index on the collection, when the caller supplied them. */
  readonly existingIndexes: readonly IndexInfo[] | undefined;
  /** Indexes visible in the plan itself — a partial view, never a substitute. */
  readonly observedIndexes: readonly IndexInfo[];
  readonly counts: SuggestionCounts;
  /** Emitted only when the case is unambiguous. Undefined otherwise. */
  readonly command: string | undefined;
  /** Why there is no command, or what to weigh before running it. */
  readonly reasons: readonly string[];
}
