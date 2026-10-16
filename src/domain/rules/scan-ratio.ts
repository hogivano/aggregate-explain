import { type Finding, type Note } from '../finding.ts';
import type { ExecutionUnit } from '../normalize.ts';
import { formatCount, formatRatio } from '../units.ts';
import {
  alreadyReported,
  numericData,
  type Rule,
  type RuleContext,
  type RuleOutcome,
} from './types.ts';

/**
 * Rule 3 — `totalDocsExamined / nReturned`.
 *
 * The blunt instrument, and the one most likely to cry wolf, so it is fenced on
 * three sides:
 *
 *   - `nReturned === 0` is a division by zero *and* not a performance finding.
 *     A pipeline that matched nothing is a pipeline that matched nothing.
 *   - a ratio needs a floor: examining 400 documents to return 40 is 10:1 and
 *     completely fine.
 *   - it is the catch-all, so it defers: a collection scan or an unselective
 *     index already carries these numbers with a better explanation attached.
 */
export const scanRatioRule: Rule = {
  id: 'scan-ratio',
  summary: 'Far more documents were read than returned',

  evaluate(context: RuleContext): RuleOutcome {
    const findings: Finding[] = [];
    const notes: Note[] = [];
    const { minRatio, minExamined } = context.thresholds.scanRatio;

    for (const unit of context.explain.units) {
      const examined = unit.totals?.totalDocsExamined;
      const returned = unit.totals?.nReturned;
      if (examined === undefined || returned === undefined) continue;
      if (examined < minExamined) continue;

      if (returned === 0) {
        notes.push({
          kind: 'inconclusive',
          text:
            `${where(unit)}examined ${formatCount(examined)} documents and returned none.` +
            ' No scan ratio can be computed; whether that read was wasted depends on' +
            ' whether you expected results.',
        });
        continue;
      }

      const ratio = examined / returned;
      if (ratio < minRatio) continue;
      const explained =
        alreadyReported(context, 'collection-scan', unit.shard) ||
        alreadyReported(context, 'unselective-index', unit.shard);
      if (explained) continue;

      findings.push(describe(unit, examined, returned, ratio));
    }
    return { findings, notes };
  },
};

function describe(
  unit: ExecutionUnit,
  examined: number,
  returned: number,
  ratio: number,
): Finding {
  return {
    rule: 'scan-ratio',
    severity: ratio >= 100 ? 'high' : 'medium',
    title: `Read ${formatRatio(ratio)} more documents than it returned${suffix(unit)}`,
    location: {
      stage: 'pipeline',
      layer: 'query',
      pipelineIndex: undefined,
      shard: unit.shard,
      label: unit.shard === undefined ? 'pipeline' : `pipeline on ${unit.shard}`,
    },
    evidence: [
      `Examined ${formatCount(examined)} documents to return ${formatCount(returned)}` +
        `  (${formatRatio(ratio)})`,
    ],
    explanation: [
      'The index in use is not selective enough for this filter, or the work that' +
        ' narrows the result happens after the documents have already been read.' +
        ' Either way the server paid for documents nobody wanted.',
      'Look at which fields the filter tests and in what order the index lists them:' +
        ' equality fields first, then the sort field, then range fields.',
    ],
    data: {
      shard: unit.shard ?? null,
      ratio: Number(ratio.toFixed(2)),
      ...numericData({ totalDocsExamined: examined, nReturned: returned }),
    },
  };
}

function where(unit: ExecutionUnit): string {
  return unit.shard === undefined ? '' : `${unit.shard}: `;
}

function suffix(unit: ExecutionUnit): string {
  return unit.shard === undefined ? '' : ` on ${unit.shard}`;
}
