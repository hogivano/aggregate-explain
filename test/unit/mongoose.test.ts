import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateExplainPlugin,
  analyzeAggregate,
  analyzePipeline,
  type AggregatableModel,
  type ExplainableAggregate,
} from '../../src/mongoose/index.ts';
import { loadFixture } from '../fixtures/index.ts';

/**
 * The plugin layer is thin on purpose, so these tests cover its seams: the
 * verbosity it asks for, and the array wrapper some Mongoose and driver paths
 * put around the result. Mongoose itself is never imported — the types are
 * structural, which is what lets one package serve Mongoose 5 through 9.
 */

class FakeAggregate implements ExplainableAggregate {
  readonly calls: (string | undefined)[] = [];
  private readonly result: unknown;

  constructor(result: unknown) {
    this.result = result;
  }

  explain(verbosity?: string): unknown {
    this.calls.push(verbosity);
    return Promise.resolve(this.result);
  }
}

test('executionStats is the default, because a plan alone measures nothing', async () => {
  const aggregate = new FakeAggregate(loadFixture('group-spill-classic-7.0.json'));
  const report = await analyzeAggregate(aggregate);

  assert.deepEqual(aggregate.calls, ['executionStats']);
  assert.deepEqual(report.findings.map((finding) => finding.rule), ['disk-spill']);
});

test('an array-wrapped result is unwrapped before the core ever sees it', async () => {
  const aggregate = new FakeAggregate([loadFixture('collscan-optimized-pipeline-6.0.json')]);
  const report = await analyzeAggregate(aggregate);

  assert.deepEqual(report.findings.map((finding) => finding.rule), ['collection-scan']);
});

test('a model and a pipeline are all the caller needs', async () => {
  const seen: unknown[][] = [];
  const model: AggregatableModel = {
    aggregate(pipeline) {
      seen.push([...pipeline]);
      return new FakeAggregate(loadFixture('healthy-indexed-7.0.json'));
    },
  };

  const report = await analyzePipeline(model, [{ $match: { accountId: 'acc_9' } }]);

  assert.deepEqual(seen, [[{ $match: { accountId: 'acc_9' } }]]);
  assert.deepEqual(report.findings, []);
});

test('the model supplies the index list that makes a suggestion printable', async () => {
  const model: AggregatableModel = {
    aggregate: () => new FakeAggregate(loadFixture('collscan-single-equality-7.0.json')),
    collection: { indexes: () => Promise.resolve([{ key: { _id: 1 }, name: '_id_' }]) },
    estimatedDocumentCount: () => Promise.resolve(4_010_000),
  };

  const report = await analyzePipeline(model, [{ $match: { organisationId: 'org_42' } }]);

  assert.equal(
    report.suggestions[0]?.command,
    'db.applications.createIndex({ organisationId: 1 })',
  );
  assert.equal(report.suggestions[0]?.counts.collectionDocuments, 4_010_000);
});

test('a collection that will not answer costs the suggestion, not the report', async () => {
  const model: AggregatableModel = {
    aggregate: () => new FakeAggregate(loadFixture('collscan-single-equality-7.0.json')),
    collection: {
      indexes: () => {
        throw new Error('not authorized on shop to execute command { listIndexes: ... }');
      },
    },
  };

  const report = await analyzePipeline(model, [{ $match: { organisationId: 'org_42' } }]);

  assert.deepEqual(report.findings.map((finding) => finding.rule), ['collection-scan']);
  assert.equal(report.suggestions[0]?.command, undefined, 'and no command on a partial view');
});

test('the plugin attaches a static that carries the model as `this`', async () => {
  const schema = { statics: {} as Record<string, unknown> };
  aggregateExplainPlugin(schema);

  const explainAggregate = schema.statics['explainAggregate'] as (
    this: AggregatableModel,
    pipeline: readonly unknown[],
  ) => Promise<{ findings: { rule: string }[] }>;

  const model: AggregatableModel = {
    aggregate: () => new FakeAggregate(loadFixture('unindexed-sort-7.0.json')),
  };

  const report = await explainAggregate.call(model, [{ $sort: { createdAt: -1 } }]);
  assert.deepEqual(report.findings.map((finding) => finding.rule), ['unindexed-sort']);
});
