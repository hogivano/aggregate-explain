import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyzeExplain, readIndexes, type CollectionContext } from '../../src/index.ts';
import { fixturePath, loadFixture } from '../fixtures/index.ts';

/**
 * Index suggestions, and the gates that stop them.
 *
 * Only one shape of case earns a printed command. Every test below that expects
 * `command: undefined` is a case where a plausible-looking suggestion would have
 * been wrong, or unverifiable — and the reason has to say which.
 */

const APPLICATIONS: CollectionContext = {
  indexes: readIndexes(
    JSON.parse(readFileSync(new URL('../fixtures/indexes/applications.json', import.meta.url), 'utf8')),
  ),
  documentCount: 4_010_000,
};

const suggest = (file: string, collection?: CollectionContext) =>
  analyzeExplain(loadFixture(file), collection === undefined ? {} : { collection }).suggestions;

test('a single-field equality with no index for it earns a command', () => {
  const [suggestion, ...rest] = suggest('collscan-single-equality-7.0.json', APPLICATIONS);

  assert.deepEqual(rest, []);
  assert.equal(suggestion!.command, 'db.applications.createIndex({ organisationId: 1 })');
  assert.deepEqual(suggestion!.esr.equality, ['organisationId']);
  assert.equal(suggestion!.counts.collectionDocuments, 4_010_000);
  assert.ok(
    suggestion!.reasons.some((reason) => reason.includes('every write')),
    'a command must carry its cost',
  );
});

test('no command without the collection index list, however obvious the case looks', () => {
  const [suggestion] = suggest('collscan-single-equality-7.0.json');

  assert.equal(suggestion!.command, undefined);
  assert.equal(suggestion!.existingIndexes, undefined);
  assert.ok(suggestion!.reasons.some((reason) => reason.includes('index list was not supplied')));
});

test('no command when an index already leads with the field', () => {
  const context: CollectionContext = {
    indexes: readIndexes([
      { key: { _id: 1 }, name: '_id_' },
      { key: { organisationId: 1, createdAt: -1 }, name: 'organisationId_1_createdAt_-1' },
    ]),
    documentCount: 4_010_000,
  };
  const [suggestion] = suggest('collscan-single-equality-7.0.json', context);

  assert.equal(suggestion!.command, undefined);
  assert.ok(
    suggestion!.reasons.some((reason) => reason.includes('organisationId_1_createdAt_-1')),
    'the duplicate-prefix trap is the one this module exists to avoid',
  );
});

test('no command for a compound filter — only the E-S-R order it implies', () => {
  const [suggestion] = suggest('collscan-optimized-pipeline-6.0.json', APPLICATIONS);

  assert.equal(suggestion!.command, undefined);
  assert.deepEqual(suggestion!.esr.equality, ['organisationId', 'status']);
  assert.ok(suggestion!.reasons.some((reason) => reason.includes('the filter is compound')));
});

test('a sort puts the sort field between equality and range', () => {
  const report = analyzeExplain({
    explainVersion: '1',
    queryPlanner: {
      namespace: 'shop.posts',
      parsedQuery: {
        $and: [{ authorId: { $eq: 'a_18' } }, { score: { $gte: 10 } }],
      },
      winningPlan: { stage: 'COLLSCAN' },
    },
    executionStats: {
      nReturned: 40,
      executionTimeMillis: 300,
      totalKeysExamined: 0,
      totalDocsExamined: 90000,
      executionStages: {
        stage: 'SORT',
        sortPattern: { createdAt: -1 },
        memLimit: 104857600,
        nReturned: 40,
        inputStage: { stage: 'COLLSCAN', docsExamined: 90000, filter: { authorId: 'a_18' } },
      },
    },
  });

  const [suggestion] = report.suggestions;
  assert.deepEqual(suggestion!.esr.equality, ['authorId']);
  assert.deepEqual(suggestion!.esr.sort, [{ field: 'createdAt', direction: -1 }]);
  assert.deepEqual(suggestion!.esr.range, ['score']);
  assert.equal(
    suggestion!.esr.recommendedKey.map((field) => field.field).join(),
    'authorId,createdAt,score',
    'equality, then sort, then range — the order is the whole analysis',
  );
});

test('an index on a field that matches most of the collection is not suggested', () => {
  const report = analyzeExplain(
    {
      queryPlanner: {
        namespace: 'shop.orders',
        parsedQuery: { active: { $eq: true } },
        winningPlan: { stage: 'COLLSCAN', filter: { active: { $eq: true } } },
      },
      executionStats: {
        nReturned: 600000,
        executionTimeMillis: 900,
        totalKeysExamined: 0,
        totalDocsExamined: 1000000,
        executionStages: { stage: 'COLLSCAN', nReturned: 600000, docsExamined: 1000000 },
      },
    },
    { collection: { indexes: readIndexes([{ key: { _id: 1 }, name: '_id_' }]) } },
  );

  const [suggestion] = report.suggestions;
  assert.equal(suggestion!.command, undefined);
  assert.ok(suggestion!.reasons.some((reason) => reason.includes('60% of the collection')));
});

test('a share measured after an index scan is not mistaken for selectivity', () => {
  // 24,000 read, 24,000 matched — but an index did the narrowing, so that 100%
  // says nothing about the filter, and the reason has to say so rather than
  // talking the reader out of an index that would help.
  const [suggestion] = suggest('unindexed-sort-7.0.json');

  assert.equal(suggestion!.counts.selectivityMeasuresFilter, false);
  assert.ok(suggestion!.reasons.some((reason) => reason.includes('an index already narrowed')));
  assert.ok(
    !suggestion!.reasons.some((reason) => reason.includes('of the collection.')),
    'the stronger claim must not be made from the weaker number',
  );
});

test('operators a single index does not serve are declined by name', () => {
  const report = analyzeExplain(
    {
      queryPlanner: {
        namespace: 'shop.orders',
        parsedQuery: { $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] },
        winningPlan: { stage: 'COLLSCAN' },
      },
      executionStats: {
        nReturned: 5,
        totalDocsExamined: 50000,
        totalKeysExamined: 0,
        executionTimeMillis: 60,
        executionStages: { stage: 'COLLSCAN', nReturned: 5, docsExamined: 50000 },
      },
    },
    { collection: { indexes: readIndexes([{ key: { _id: 1 }, name: '_id_' }]) } },
  );

  const [suggestion] = report.suggestions;
  assert.equal(suggestion!.command, undefined);
  assert.ok(suggestion!.reasons.some((reason) => reason.includes('$or')));
});

test('a healthy pipeline gets no index analysis at all', () => {
  assert.deepEqual(suggest('healthy-indexed-7.0.json', APPLICATIONS), []);
});

test('one analysis for a query that ran on every shard', () => {
  const suggestions = suggest('sharded-collscan-8.0.json');
  assert.equal(suggestions.length, 1, 'the same advice, once');
});

test('the index list read from getIndexes() output keeps field order', () => {
  const indexes = readIndexes([
    { v: 2, key: { status: 1, createdAt: -1 }, name: 'status_1_createdAt_-1' },
  ]);
  assert.deepEqual(indexes[0]!.key, [
    { field: 'status', direction: 1 },
    { field: 'createdAt', direction: -1 },
  ]);
});

test('the older indexInformation() map shape is understood too', () => {
  // What a Mongoose 5 collection is most likely to hand back.
  const indexes = readIndexes({ _id_: [['_id', 1]], status_1: [['status', 1]] });
  assert.deepEqual(indexes.map((index) => index.name), ['_id_', 'status_1']);
});

test('the CLI rejects an empty index list rather than trusting it', async () => {
  const { readCollectionContext } = await import('../../src/infrastructure/input/read-explain.ts');
  await assert.rejects(
    () => readCollectionContext(fixturePath('../indexes/empty.json')),
    /contains no indexes/,
  );
});
