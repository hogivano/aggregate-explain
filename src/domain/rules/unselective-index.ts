import { locationOf, type Finding } from '../finding.ts';
import type { ExecutionUnit } from '../normalize.ts';
import { isStage, type PlanNode } from '../plan-node.ts';
import { formatCount, formatRatio, formatShellValue } from '../units.ts';
import {
  alreadyReported,
  numericData,
  type Rule,
  type RuleContext,
  type RuleOutcome,
} from './types.ts';

/**
 * Rule 4 — an index is used and still is not helping.
 *
 * `totalKeysExamined` far above `nReturned` while an `IXSCAN` is in the plan.
 * This is the finding people most often miss on their own, because the plan says
 * `IXSCAN` and they stop reading there. The index is being scanned, not sought:
 * usually the field order is wrong for this query, so the scan starts at a
 * prefix that matches far more keys than the filter finally accepts.
 */
export const unselectiveIndexRule: Rule = {
  id: 'unselective-index',
  summary: 'An index is used but scans far more keys than the query returns',

  evaluate(context: RuleContext): RuleOutcome {
    const findings: Finding[] = [];
    const { minRatio, minExamined } = context.thresholds.keyRatio;

    for (const unit of context.explain.units) {
      const keys = unit.totals?.totalKeysExamined;
      const returned = unit.totals?.nReturned;
      if (keys === undefined || returned === undefined || returned === 0) continue;
      if (keys < minExamined || keys / returned < minRatio) continue;

      // No index in the plan means rule 2 owns this, not us.
      const scans = unit.nodes.filter((node) => isStage(node, 'IXSCAN', 'ixseek', 'DISTINCT_SCAN'));
      if (scans.length === 0) continue;
      if (alreadyReported(context, 'collection-scan', unit.shard)) continue;

      findings.push(describe(scans, unit, keys, returned));
    }
    return { findings, notes: [] };
  },
};

function describe(
  scans: readonly PlanNode[],
  unit: ExecutionUnit,
  keys: number,
  returned: number,
): Finding {
  // Report against the first index scan; when a plan has several, the others are
  // listed as evidence rather than raised as separate findings, because the
  // key-to-returned ratio is a whole-plan number and cannot be split between them.
  const primary = scans[0]!;
  const ratio = keys / returned;

  return {
    rule: 'unselective-index',
    severity: ratio >= 100 ? 'high' : 'medium',
    title: `${indexLabel(primary)} is used but not selective`,
    location: locationOf(primary),
    evidence: [
      `Examined ${formatCount(keys)} index keys to return ${formatCount(returned)}` +
        `  (${formatRatio(ratio)})`,
      ...scans.map((node) => `index: ${indexLabel(node)}${keyPattern(node)}`),
    ],
    explanation: [
      'The index is being scanned rather than sought: the query starts at a prefix that' +
        ' matches many more keys than the filter finally accepts. That is nearly always' +
        ' field order — an index only narrows on its leading fields.',
      'Order the fields the way the query uses them: equality first, then the sort field,' +
        ' then ranges. Adding a field to the front of an existing index is usually the' +
        ' fix, and it is cheaper than a second index.',
    ],
    data: {
      shard: unit.shard ?? null,
      indexes: scans.map((node) => node.metrics.indexName ?? node.stage),
      keyPatterns: scans.map((node) => node.metrics.keyPattern ?? null),
      ratio: Number(ratio.toFixed(2)),
      ...numericData({ totalKeysExamined: keys, nReturned: returned }),
    },
  };
}

function indexLabel(node: PlanNode): string {
  return node.metrics.indexName ?? node.stage;
}

function keyPattern(node: PlanNode): string {
  const pattern = node.metrics.keyPattern;
  return pattern === undefined ? '' : ` ${formatShellValue(pattern)}`;
}
