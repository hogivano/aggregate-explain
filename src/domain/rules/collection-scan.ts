import { locationOf, type Finding } from '../finding.ts';
import type { ExecutionUnit } from '../normalize.ts';
import { isStage, type PlanNode } from '../plan-node.ts';
import { formatCount, formatRatio, formatShellValue } from '../units.ts';
import {
  evidenceLine,
  numericData,
  type Rule,
  type RuleContext,
  type RuleOutcome,
} from './types.ts';

/**
 * Rule 2 — a `COLLSCAN` stage: the query read the collection instead of an index.
 *
 * The finding reports the filter that ran unindexed, because the filter is the
 * actionable part. "You have a collection scan" is a fact the reader can already
 * see; "no index serves `{ organisationId, status }`" is the sentence they can
 * act on.
 */
export const collectionScanRule: Rule = {
  id: 'collection-scan',
  summary: 'A stage read the collection instead of an index',

  evaluate(context: RuleContext): RuleOutcome {
    const findings: Finding[] = [];

    for (const unit of context.explain.units) {
      for (const node of unit.nodes) {
        if (!isStage(node, 'COLLSCAN')) continue;

        const examined = node.metrics.docsExamined ?? unit.totals?.totalDocsExamined;
        // An empty collection scans nothing. That is not a performance finding,
        // and reporting it is how a tool teaches people to ignore it.
        if (examined === 0) continue;
        if (examined !== undefined && examined < context.thresholds.collectionScanMinDocs) continue;

        findings.push(describe(node, unit, examined, context));
      }
    }
    return { findings, notes: [] };
  },
};

function describe(
  node: PlanNode,
  unit: ExecutionUnit,
  examined: number | undefined,
  context: RuleContext,
): Finding {
  const location = locationOf(node);
  const returned = unit.totals?.nReturned;
  const filter = node.metrics.filter;

  return {
    rule: 'collection-scan',
    severity:
      examined !== undefined && examined >= context.thresholds.collectionScanSevereDocs
        ? 'high'
        : 'medium',
    title: `${location.label} is a collection scan`,
    location,
    evidence: [
      examined === undefined
        ? 'No execution stats — document count unknown'
        : evidenceLine(
            `Examined ${formatCount(examined)} documents`,
            returned === undefined ? undefined : `returned ${formatCount(returned)}`,
            ratioOf(examined, returned),
          ),
      filter === undefined || isEmptyFilter(filter)
        ? 'No filter on this stage — the pipeline reads every document by design'
        : `filter: ${formatShellValue(filter)}`,
    ],
    explanation: [
      filter === undefined || isEmptyFilter(filter)
        ? 'Nothing narrows the read, so every document in the collection is loaded and' +
          ' passed on. If a later stage discards most of them, move that predicate into a' +
          ' `$match` at the front of the pipeline where an index can serve it.'
        : 'No index serves this filter, so every document in the collection is loaded and' +
          ' tested one at a time. The cost grows with the collection, not with the number' +
          ' of documents you actually wanted.',
    ],
    data: {
      stage: node.stage,
      shard: unit.shard ?? null,
      filter: filter ?? null,
      ...numericData({ docsExamined: examined, nReturned: returned }),
    },
  };
}

function ratioOf(examined: number, returned: number | undefined): string | undefined {
  if (returned === undefined || returned <= 0) return undefined;
  return formatRatio(examined / returned);
}

function isEmptyFilter(filter: unknown): boolean {
  return typeof filter === 'object' && filter !== null && Object.keys(filter).length === 0;
}
