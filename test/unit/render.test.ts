import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeExplain, renderJson, renderReport, JSON_SCHEMA_VERSION } from '../../src/index.ts';
import { FIXTURES, loadFixture } from '../fixtures/index.ts';

/**
 * Output is the product too: a correct verdict nobody can read is the tool that
 * already exists. These tests hold the shape of the report — verdict, then
 * numbers, then meaning — and the stability of the JSON contract.
 */

const ESCAPE = String.fromCharCode(27);

test('the human report leads with the verdict and backs it with numbers', () => {
  const output = renderReport(analyzeExplain(loadFixture('group-spill-classic-7.0.json')));

  assert.match(output, /Pipeline: 4\.2s · 1 finding/);
  assert.match(output, /\$group \(stage 2\) spilled to disk/);
  assert.match(output, /3 spills · 89MB written/);
  assert.match(output, /100MB in-memory limit/, 'the verdict must explain itself');
});

test('no line is wider than the terminal it is read in', () => {
  for (const { file } of FIXTURES) {
    for (const line of renderReport(analyzeExplain(loadFixture(file))).split('\n')) {
      assert.ok(line.length <= 80, `line too wide in ${file}: ${line}`);
    }
  }
});

test('a clean pipeline says so, with the numbers that justify the silence', () => {
  const output = renderReport(analyzeExplain(loadFixture('healthy-indexed-7.0.json')));

  assert.match(output, /no findings/);
  assert.match(output, /120 documents examined to return 120/);
});

test('the report carries no escape sequences — half of these end up in a CI log', () => {
  const output = renderReport(analyzeExplain(loadFixture('unselective-index-8.0.json')));
  assert.ok(!output.includes(ESCAPE), 'colour codes become noise in a log file');
});

test('the JSON contract is explicit and stable', () => {
  const report = analyzeExplain(loadFixture('collscan-optimized-pipeline-6.0.json'));
  const payload = JSON.parse(renderJson(report));

  assert.equal(payload.schemaVersion, JSON_SCHEMA_VERSION);
  assert.equal(payload.summary.totalDocsExamined, 1240000);
  assert.deepEqual(Object.keys(payload.findings[0]).sort(), [
    'data',
    'evidence',
    'explanation',
    'location',
    'rule',
    'severity',
    'title',
  ]);
  assert.equal(payload.findings[0].data.docsExamined, 1240000, 'raw numbers stay machine-readable');
  assert.equal(payload.explain, undefined, 'the input is not echoed back');
});
