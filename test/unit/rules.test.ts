import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeExplain, type RuleId } from '../../src/index.ts';
import { loadFixture } from '../fixtures/index.ts';

/**
 * The edges each rule is fenced against.
 *
 * Everything here is a case where the naive version of the rule would fire and
 * be wrong. A false positive costs more than a miss: the first one teaches the
 * reader to skim, the second one gets uninstalled.
 */

/** A pushed-down explain with the totals dialled in, and nothing else going on. */
function explainWith(stats: {
  nReturned: number;
  totalDocsExamined: number;
  totalKeysExamined: number;
  stage?: Record<string, unknown>;
}) {
  return {
    explainVersion: '1',
    queryPlanner: {
      namespace: 'test.things',
      winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'a_1' } },
    },
    executionStats: {
      nReturned: stats.nReturned,
      executionTimeMillis: 12,
      totalDocsExamined: stats.totalDocsExamined,
      totalKeysExamined: stats.totalKeysExamined,
      executionStages: stats.stage ?? {
        stage: 'FETCH',
        nReturned: stats.nReturned,
        docsExamined: stats.totalDocsExamined,
        inputStage: {
          stage: 'IXSCAN',
          indexName: 'a_1',
          keyPattern: { a: 1 },
          keysExamined: stats.totalKeysExamined,
        },
      },
    },
    serverInfo: { version: '8.0.4' },
  };
}

const rulesOf = (input: unknown): RuleId[] =>
  analyzeExplain(input).findings.map((finding) => finding.rule);

test('a pipeline that matched nothing is not a performance finding', () => {
  const report = analyzeExplain(
    explainWith({ nReturned: 0, totalDocsExamined: 500000, totalKeysExamined: 0 }),
  );

  assert.deepEqual(report.findings, [], 'nReturned = 0 is a division, not a verdict');
  assert.ok(
    report.notes.some((note) => note.kind === 'inconclusive' && note.text.includes('returned none')),
    'but it is worth saying out loud that we declined',
  );
});

test('a ratio without a floor is noise: 400 examined for 40 returned stays quiet', () => {
  assert.deepEqual(rulesOf(explainWith({ nReturned: 40, totalDocsExamined: 400, totalKeysExamined: 40 })), []);
});

test('the scan ratio fires when nothing more specific explains it', () => {
  // Index keys are below the key-ratio floor, so rule 4 declines; there is no
  // COLLSCAN, so rule 2 has nothing to say. The catch-all is what is left.
  assert.deepEqual(
    rulesOf(explainWith({ nReturned: 3, totalDocsExamined: 20000, totalKeysExamined: 900 })),
    ['scan-ratio'],
  );
});

test('spill counters without usedDisk are still a spill', () => {
  const report = analyzeExplain({
    stages: [
      {
        $cursor: {
          queryPlanner: { namespace: 'test.t', winningPlan: { stage: 'IXSCAN', indexName: 'k_1' } },
        },
      },
      { $group: { _id: '$k' }, spills: 2, spilledBytes: 4096, nReturned: 10 },
    ],
  });
  assert.deepEqual(report.findings.map((finding) => finding.rule), ['disk-spill']);
});

test('a spilled sort is reported once, as a spill, not twice', () => {
  // The slot-based payload names the same sort twice — `SORT` in the query plan,
  // `sort` in the execution tree — and rule 5 defers to rule 1 on top of that.
  const report = analyzeExplain(loadFixture('sort-spill-sbe-8.0.json'));
  assert.deepEqual(report.findings.map((finding) => finding.rule), ['disk-spill']);
});

test('an empty collection scans nothing and reports nothing', () => {
  assert.deepEqual(
    rulesOf(
      explainWith({
        nReturned: 0,
        totalDocsExamined: 0,
        totalKeysExamined: 0,
        stage: { stage: 'COLLSCAN', nReturned: 0, docsExamined: 0, filter: { a: 1 } },
      }),
    ),
    [],
  );
});

test('thresholds are tunable for a caller with a different idea of "fine"', () => {
  const input = explainWith({ nReturned: 40, totalDocsExamined: 400, totalKeysExamined: 40 });
  const report = analyzeExplain(input, {
    thresholds: { scanRatio: { minRatio: 5, minExamined: 100 } },
  });
  assert.deepEqual(report.findings.map((finding) => finding.rule), ['scan-ratio']);
});

test('a caller can run one rule on its own', () => {
  const report = analyzeExplain(loadFixture('collscan-optimized-pipeline-6.0.json'), {
    rules: ['disk-spill'],
  });
  assert.deepEqual(report.findings, []);
});

test('one problem on two shards is reported once, with both shards\' numbers', () => {
  const [finding, ...rest] = analyzeExplain(loadFixture('sharded-collscan-8.0.json')).findings;

  assert.deepEqual(rest, [], 'the explanation should not be repeated per shard');
  assert.match(finding!.title, /2 shards/);
  assert.ok(finding!.evidence.some((line) => line.startsWith('shard01: ')));
  assert.ok(finding!.evidence.some((line) => line.startsWith('shard02: ')));
  assert.ok(
    finding!.evidence.some((line) => line.startsWith('filter:')),
    'facts about the query, not the shard, are stated once',
  );
});
