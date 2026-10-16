import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MalformedExplainError, isStage, normaliseExplain, walkAll } from '../../src/index.ts';
import { loadFixture } from '../fixtures/index.ts';

/**
 * The normaliser is the piece most likely to be wrong, and wrong here is silent:
 * a shape it does not understand produces an empty tree, every rule finds
 * nothing, and the tool reports a clean bill of health on a broken pipeline.
 *
 * So these tests assert the tree exists and contains what the payload described,
 * shape by shape.
 */

test('aggregation `stages` shape: cursor plan hangs under the $cursor stage', () => {
  const explain = normaliseExplain(loadFixture('group-spill-classic-7.0.json'));
  const [unit] = explain.units;

  assert.equal(explain.units.length, 1);
  assert.deepEqual(
    unit!.roots.map((root) => root.stage),
    ['$cursor', '$group'],
  );
  assert.deepEqual(
    unit!.roots[0]!.children.map((child) => child.stage),
    ['FETCH'],
    'the query plan should hang under $cursor, not float beside it',
  );
  assert.equal(unit!.namespace, 'shop.orders');
  assert.equal(unit!.totals?.totalDocsExamined, 1840000, 'totals live inside $cursor in this shape');
});

test('pushed-down shape: the plan is read as a query tree', () => {
  const explain = normaliseExplain(loadFixture('collscan-optimized-pipeline-6.0.json'));
  const [unit] = explain.units;

  assert.equal(unit!.optimizedPipeline, true);
  assert.equal(unit!.roots.length, 1, 'executionStages supersedes winningPlan in the classic engine');
  assert.ok(unit!.nodes.some((node) => isStage(node, 'COLLSCAN')));
});

test('slot-based shape: both the query plan and the slot-based tree are kept', () => {
  const explain = normaliseExplain(loadFixture('sort-spill-sbe-8.0.json'));
  const stages = [...walkAll(explain.units[0]!.roots)].map((node) => node.stage);

  assert.equal(explain.server.engine, 'slot-based');
  assert.ok(stages.includes('sort'), 'the slot-based tree carries the spill counters');
  assert.ok(stages.includes('SORT'), 'the query plan carries the stage names people recognise');
  assert.ok(stages.includes('IXSCAN'), 'nested queryPlan stages must be reachable');
});

test('sharded shape: one unit per shard, counts summed and elapsed time not', () => {
  const explain = normaliseExplain(loadFixture('sharded-collscan-8.0.json'));

  assert.equal(explain.sharded, true);
  assert.deepEqual(
    explain.units.map((unit) => unit.shard),
    ['shard01', 'shard02'],
  );
  assert.equal(explain.totals?.totalDocsExamined, 1610000, 'documents examined add up');
  assert.equal(
    explain.totals?.executionTimeMillis,
    1120,
    'shards run in parallel: the pipeline took as long as the slowest one',
  );
});

test('queryPlanner verbosity: a plan with nothing measured', () => {
  const explain = normaliseExplain(loadFixture('query-planner-only-7.0.json'));

  assert.equal(explain.hasExecutionStats, false);
  assert.equal(explain.totals, undefined);
  assert.ok(explain.units[0]!.nodes.some((node) => isStage(node, 'COLLSCAN')));
});

test('a one-element array is unwrapped, as mongosh and some driver paths return it', () => {
  const raw = loadFixture('healthy-indexed-7.0.json');
  assert.deepEqual(normaliseExplain([raw]).namespace, normaliseExplain(raw).namespace);
});

test('Extended JSON number wrappers are read as numbers', () => {
  const explain = normaliseExplain({
    stages: [{ $group: { _id: null }, usedDisk: true, spilledBytes: { $numberLong: '93323264' } }],
  });
  assert.equal(explain.units[0]!.roots[0]!.metrics.spilledBytes, 93323264);
});

test('input that is not explain output is rejected, not analysed', () => {
  assert.throws(() => normaliseExplain(loadFixture('invalid-not-explain.json')), MalformedExplainError);
  assert.throws(() => normaliseExplain('not an object'), MalformedExplainError);
  assert.throws(() => normaliseExplain(null), MalformedExplainError);
});

test('an unknown child key still yields its subtree', () => {
  // Insurance against the next server release: nodes are found structurally, so
  // a renamed pointer costs coverage of one field, not the whole subtree.
  const explain = normaliseExplain({
    queryPlanner: {
      winningPlan: { stage: 'FUTURE_STAGE', someNewChildKey: { stage: 'COLLSCAN', docsExamined: 5 } },
    },
  });
  assert.ok(explain.units[0]!.nodes.some((node) => isStage(node, 'COLLSCAN')));
});
