import { locationOf, type Finding } from '../finding.ts';
import type { ExecutionUnit } from '../normalize.ts';
import { isStage, type PlanNode } from '../plan-node.ts';
import { formatBytes, formatShellValue } from '../units.ts';
import {
  evidenceLine,
  numericData,
  type Rule,
  type RuleContext,
  type RuleOutcome,
} from './types.ts';

/**
 * Rule 5 — a sort the index did not provide.
 *
 * The detection is simpler than it looks: when an index already returns
 * documents in the requested order, the planner emits no sort stage at all. So
 * the presence of a `SORT` (or slot-based `sort`, or an aggregation-layer
 * `$sort`) *is* the finding — the server is buffering the result set and
 * ordering it in memory.
 *
 * On its own that costs memory and a little time. Its real significance is that
 * it puts you one dataset-growth away from rule 1: cross the 100MB limit and the
 * same query starts writing to disk.
 */
export const unindexedSortRule: Rule = {
  id: 'unindexed-sort',
  summary: 'A sort ran in memory because no index provided the order',

  evaluate(context: RuleContext): RuleOutcome {
    const findings: Finding[] = [];

    for (const unit of context.explain.units) {
      // A sort that already spilled is reported by rule 1, in stronger terms and
      // with better numbers. Saying it twice is how a report starts getting skimmed.
      if (unitHasSpilledSort(unit)) continue;

      for (const node of unit.nodes) {
        if (isStage(node, 'SORT', '$sort', 'sort')) findings.push(describe(node, unit));
      }
    }
    return { findings, notes: [] };
  },
};

function unitHasSpilledSort(unit: ExecutionUnit): boolean {
  return unit.nodes.some(
    (node) => isStage(node, 'SORT', '$sort', 'sort') && node.metrics.usedDisk === true,
  );
}

function describe(node: PlanNode, unit: ExecutionUnit): Finding {
  const location = locationOf(node);
  const { sortPattern, memUsage, memLimit, nReturned } = node.metrics;
  const headroom =
    memUsage !== undefined && memLimit !== undefined
      ? `${formatBytes(memUsage)} of the ${formatBytes(memLimit)} limit used`
      : undefined;

  return {
    rule: 'unindexed-sort',
    severity: 'medium',
    title: `${location.label} is sorting in memory`,
    location,
    evidence: [
      evidenceLine(
        sortPattern === undefined ? undefined : `sort: ${formatShellValue(sortPattern)}`,
        nReturned === undefined ? undefined : `${nReturned.toLocaleString('en-US')} documents sorted`,
        headroom,
      ) || 'No index provides this order',
    ],
    explanation: [
      'No index returns the documents in this order, so the server buffers the whole' +
        ' result set and sorts it. When an index does provide the order there is no sort' +
        ' stage in the plan at all.',
      'This is the stage that becomes a disk spill as the data grows. An index whose' +
        ' fields run equality-first, then this sort key, removes the stage entirely.',
    ],
    data: {
      stage: node.stage,
      shard: unit.shard ?? null,
      sortPattern: sortPattern ?? null,
      ...numericData({ nReturned, memUsage, memLimit }),
    },
  };
}
