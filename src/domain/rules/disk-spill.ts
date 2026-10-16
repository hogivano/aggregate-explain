import { locationOf, type Finding } from '../finding.ts';
import type { ExecutionUnit } from '../normalize.ts';
import type { PlanNode } from '../plan-node.ts';
import { formatBytes, formatCount, plural } from '../units.ts';
import {
  evidenceLine,
  numericData,
  type Rule,
  type RuleContext,
  type RuleOutcome,
} from './types.ts';

/**
 * Rule 1 — the flagship.
 *
 * `usedDisk: true` on any stage. This is the three-to-six second mystery that
 * looks like nothing on a CPU graph: the stage ran out of its in-memory budget,
 * wrote to disk to finish, and no other tool in this space will tell you which
 * stage or how much. It is also the least ambiguous signal in the whole explain
 * output — the server states it as a fact, so there is no threshold to argue
 * about and no false positive to guard against.
 */

/** The in-memory budget for a blocking sort, in bytes. `memLimit` states it per stage. */
const DEFAULT_SORT_MEM_LIMIT = 104_857_600;

export const diskSpillRule: Rule = {
  id: 'disk-spill',
  summary: 'A stage exceeded its in-memory limit and wrote to disk',

  evaluate(context: RuleContext): RuleOutcome {
    const findings: Finding[] = [];
    for (const unit of context.explain.units) {
      for (const node of unit.nodes) {
        if (spilled(node)) findings.push(describe(node, unit));
      }
    }
    return { findings, notes: [] };
  },
};

/**
 * `usedDisk` is the documented signal, but some stages report the spill counters
 * without it. A non-zero spill count is the same event by another name.
 */
function spilled(node: PlanNode): boolean {
  const { usedDisk, spills, spilledBytes } = node.metrics;
  return usedDisk === true || (spills ?? 0) > 0 || (spilledBytes ?? 0) > 0;
}

function describe(node: PlanNode, unit: ExecutionUnit): Finding {
  const location = locationOf(node);
  const { spills, spilledBytes, spilledRecords, spilledDataStorageSize, memUsage, memLimit } =
    node.metrics;
  const limit = memLimit ?? DEFAULT_SORT_MEM_LIMIT;

  const evidence = [
    evidenceLine(
      'usedDisk: true',
      spills === undefined ? undefined : plural(spills, 'spill'),
      spilledBytes === undefined ? undefined : `${formatBytes(spilledBytes)} written`,
      spilledRecords === undefined ? undefined : `${formatCount(spilledRecords)} records`,
    ),
  ];
  if (memUsage !== undefined) {
    evidence.push(`memUsage: ${formatBytes(memUsage)} against a ${formatBytes(limit)} limit`);
  }
  if (spilledDataStorageSize !== undefined) {
    evidence.push(`spilledDataStorageSize: ${formatBytes(spilledDataStorageSize)} on disk`);
  }

  return {
    rule: 'disk-spill',
    severity: 'high',
    title: `${location.label} spilled to disk`,
    location,
    evidence,
    explanation: [
      `The stage exceeded its ${formatBytes(limit)} in-memory limit and wrote to disk to` +
        ' finish. It completed rather than erroring because spilling was allowed — the' +
        ' default on modern servers, and what `allowDiskUse: true` buys on older ones —' +
        ' and that disk write is where the wall-clock time went.',
      'Fix it by giving the stage less to hold: filter earlier in the pipeline, or feed' +
        ' it from an index that already provides the order or grouping so it does not' +
        ' have to buffer the whole input.',
    ],
    data: {
      stage: node.stage,
      pipelineIndex: node.pipelineIndex ?? null,
      shard: unit.shard ?? null,
      usedDisk: node.metrics.usedDisk ?? true,
      ...numericData({
        spills,
        spilledBytes,
        spilledRecords,
        spilledDataStorageSize,
        memUsage,
        memLimit: node.metrics.memLimit,
        peakTrackedMemBytes: node.metrics.peakTrackedMemBytes,
      }),
    },
  };
}
