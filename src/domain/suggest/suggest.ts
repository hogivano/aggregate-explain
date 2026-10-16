import type { Finding, FindingLocation, RuleId } from '../finding.ts';
import type { Json } from '../json.ts';
import type { ExecutionUnit, NormalisedExplain } from '../normalize.ts';
import { isStage, type PlanNode } from '../plan-node.ts';
import { esrCaveats, buildEsr } from './esr.ts';
import { indexesFromPlan, keyToString, leadingWith, servedBy } from './existing-indexes.ts';
import { isPlainEquality, readPredicates } from './predicates.ts';
import type {
  CollectionContext,
  EsrAnalysis,
  IndexKeyField,
  IndexSuggestion,
  Predicate,
  SuggestionCounts,
} from './types.ts';

/**
 * Index suggestions, deliberately constrained.
 *
 * One command is safe to print: a single-field equality match with no index that
 * leads on that field, on a collection whose full index list we were handed.
 * Everything else — compound filters, sorts, ranges — gets the E-S-R analysis
 * and an explicit statement of what made it ambiguous, because those cases turn
 * on write volume and cardinality that no explain output carries.
 *
 * The rule that does the most work here is the fourth gate: no command without
 * the collection's real index list. The most common way these tools give bad
 * advice is recommending an index that duplicates a prefix of one already there,
 * and the plan alone cannot rule that out — a COLLSCAN plan names no indexes at
 * all, so "I saw no index" and "there is no index" look identical from here.
 */

/** Rules whose findings are about the wrong index, or none. */
const TRIGGERING_RULES: readonly RuleId[] = [
  'collection-scan',
  'unselective-index',
  'unindexed-sort',
];

export interface SuggestOptions {
  readonly context?: CollectionContext | undefined;
  /**
   * Above this share of the collection matched, an index earns little: it is
   * read, most of it matches, and the write cost stays. We print the numbers
   * rather than the command.
   */
  readonly maxSelectivity: number;
}

export function suggestIndexes(
  explain: NormalisedExplain,
  findings: readonly Finding[],
  options: SuggestOptions,
): IndexSuggestion[] {
  const observedIndexes = indexesFromPlan(explain.raw);
  const suggestions: IndexSuggestion[] = [];
  const seen = new Set<string>();

  for (const unit of explain.units) {
    const trigger = findings.find(
      (finding) =>
        finding.location.shard === unit.shard && TRIGGERING_RULES.includes(finding.rule),
    );
    if (trigger === undefined) continue;

    const suggestion = analyseUnit(unit, explain, trigger.location, observedIndexes, options);
    // Every shard runs the same query, so the same analysis comes back once per
    // shard. It is one piece of advice.
    const signature = JSON.stringify([suggestion.esr.recommendedKey, suggestion.command]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    suggestions.push(suggestion);
  }
  return suggestions;
}

function analyseUnit(
  unit: ExecutionUnit,
  explain: NormalisedExplain,
  location: FindingLocation,
  observedIndexes: IndexSuggestion['observedIndexes'],
  options: SuggestOptions,
): IndexSuggestion {
  const predicates = readPredicates(filterFor(unit, explain));
  const esr = buildEsr(predicates, sortFor(unit));
  const counts = countsFor(unit, options.context);
  const collection = collectionOf(unit.namespace);

  const { command, reasons } = decide({ esr, predicates, counts, collection, options });

  return {
    namespace: unit.namespace,
    collection,
    location,
    esr,
    existingIndexes: options.context?.indexes,
    observedIndexes,
    counts,
    command,
    reasons: [...reasons, ...esrCaveats(esr)],
  };
}

/**
 * The gates, each with the sentence it prints when it closes.
 *
 * Written as a list rather than a chain of early returns so that a declined
 * suggestion can state *every* reason it was declined. "No command because the
 * filter is compound" is less useful than also learning that the field you would
 * have indexed matches a third of the collection.
 */
function decide(input: {
  esr: EsrAnalysis;
  predicates: readonly Predicate[];
  counts: SuggestionCounts;
  collection: string | undefined;
  options: SuggestOptions;
}): { command: string | undefined; reasons: string[] } {
  const { esr, predicates, counts, collection, options } = input;
  const context = options.context;
  const [only] = predicates;
  const reasons: string[] = [];

  if (predicates.length === 0) {
    return { command: undefined, reasons: ['No filter to analyse on this stage.'] };
  }
  if (esr.unsupported.length > 0) {
    reasons.push(
      `No command: ${esr.unsupported.map((p) => p.operators.join(', ')).join(', ')} — a single` +
        ' index does not serve these the way this analysis assumes.',
    );
  }
  if (context === undefined) {
    reasons.push(
      'No command: the collection\'s index list was not supplied, and the plan shows only' +
        ' the indexes this query considered. Recommending an index that duplicates a' +
        ' prefix of one already there is the most common way these suggestions go wrong.',
    );
  } else {
    const existing = servedBy(context.indexes, esr.recommendedKey);
    if (existing !== undefined) {
      reasons.push(
        `No command: ${existing.name} ${keyToString(existing.key)} already leads with these` +
          ' fields. If the query is still slow, the problem is elsewhere — check whether the' +
          ' planner rejected it, or whether the filter is selective enough to be worth an index.',
      );
    } else if (only !== undefined && predicates.length === 1) {
      const conflicting = leadingWith(context.indexes, only.field);
      if (conflicting.length > 0) {
        reasons.push(
          `No command: ${conflicting.map((index) => index.name).join(', ')} already leads with` +
            ` ${only.field}. Extending that index is usually better than adding another.`,
        );
      }
    }
  }

  if (predicates.length > 1) {
    reasons.push(
      'No command: the filter is compound. The E-S-R order above is the shape an index' +
        ' would take, but whether each field earns its place depends on your write volume' +
        ' and the other queries on this collection — that call is yours.',
    );
  }
  if (esr.sort.length > 0) {
    reasons.push(
      'No command: the query sorts. An index that also provides the order is usually the' +
        ' right answer, and it is also the one most likely to overlap with an index you' +
        ' already have.',
    );
  }
  if (esr.range.length > 0) {
    reasons.push('No command: the filter has a range, which ends the useful part of the key.');
  }
  if (only !== undefined && predicates.length === 1 && !isPlainEquality(only)) {
    reasons.push(
      `No command: ${only.operators.join(', ')} on ${only.field} is not a plain equality.`,
    );
  }
  if (counts.selectivity === undefined) {
    reasons.push(
      'No command: nothing was measured, so how much of the collection this filter matches' +
        ' is unknown. Re-run with explain("executionStats").',
    );
  } else if (!counts.selectivityMeasuresFilter) {
    reasons.push(
      'No command: an index already narrowed this read, so the share of documents that' +
        ' matched says nothing about how selective the filter is against the whole' +
        ' collection — and that is the number an index has to earn its keep against.',
    );
  } else if (counts.selectivity > options.maxSelectivity) {
    reasons.push(
      `No command: this filter matched ${formatPercent(counts.selectivity)} of the collection.` +
        ' An index that matches most of it is read, mostly matches, and still costs you on' +
        ' every write.',
    );
  }

  if (reasons.length > 0 || collection === undefined || only === undefined) {
    if (collection === undefined) reasons.push('No command: the namespace is not in this output.');
    return { command: undefined, reasons };
  }

  return {
    command: `db.${collection}.createIndex({ ${only.field}: 1 })`,
    reasons: [
      'Single-field equality, no index leads with this field, and the filter is selective.' +
        ' It still costs you on every write to this collection.',
    ],
  };
}

/**
 * The filter this query actually ran, in order of trustworthiness: the server's
 * own canonical form first, then whatever the scanning stage recorded, then the
 * pipeline as written.
 */
function filterFor(unit: ExecutionUnit, explain: NormalisedExplain): Json | undefined {
  if (unit.parsedQuery !== undefined) return unit.parsedQuery;

  const scanning = unit.nodes.find(
    (node) => node.metrics.filter !== undefined && isStage(node, 'COLLSCAN', 'FETCH', 'IXSCAN'),
  );
  if (scanning !== undefined) return scanning.metrics.filter;

  const firstMatch = explain.pipeline?.find(
    (stage) => typeof stage === 'object' && stage !== null && '$match' in stage,
  );
  return firstMatch === null || firstMatch === undefined
    ? undefined
    : (firstMatch as { $match: Json }).$match;
}

/** The sort the server had to perform, if any. */
function sortFor(unit: ExecutionUnit): IndexKeyField[] {
  const sorting = unit.nodes.find(
    (node: PlanNode) => isStage(node, 'SORT', '$sort', 'sort') && node.metrics.sortPattern,
  );
  return Object.entries(sorting?.metrics.sortPattern ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([field, direction]) => ({ field, direction }));
}

function countsFor(unit: ExecutionUnit, context: CollectionContext | undefined): SuggestionCounts {
  const documentsExamined = unit.totals?.totalDocsExamined;
  const documentsReturned = unit.totals?.nReturned;

  return {
    documentsExamined,
    documentsReturned,
    collectionDocuments: context?.documentCount,
    selectivity:
      documentsExamined !== undefined && documentsReturned !== undefined && documentsExamined > 0
        ? documentsReturned / documentsExamined
        : undefined,
    // Only a collection scan tests every document, so only a collection scan
    // measures the filter rather than the index that fed it.
    selectivityMeasuresFilter:
      unit.nodes.some((node) => isStage(node, 'COLLSCAN')) &&
      !unit.nodes.some((node) => isStage(node, 'IXSCAN', 'ixseek', 'DISTINCT_SCAN')),
  };
}

/** `shop.orders` -> `orders`. Database names cannot contain a dot; collections can. */
function collectionOf(namespace: string | undefined): string | undefined {
  const parts = namespace?.split('.') ?? [];
  return parts.length > 1 ? parts.slice(1).join('.') : undefined;
}

function formatPercent(ratio: number): string {
  return ratio >= 0.1 ? `${Math.round(ratio * 100)}%` : `${(ratio * 100).toFixed(1)}%`;
}
