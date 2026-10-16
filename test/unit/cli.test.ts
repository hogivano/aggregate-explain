import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fixturePath } from '../fixtures/index.ts';

/**
 * The exit code is the CI contract, and the distinction that matters is 1 from
 * 2: "I found problems" and "I could not read this" are opposite answers, and a
 * pipeline that treats a parse failure as a clean run is worse than no check.
 */

const run = promisify(execFile);
const CLI = new URL('../../src/cli.ts', import.meta.url).pathname;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(args: readonly string[], stdin?: string): Promise<Run> {
  try {
    const child = run('node', ['--experimental-strip-types', CLI, ...args], { encoding: 'utf8' });
    if (stdin !== undefined) {
      child.child.stdin?.end(stdin);
    } else {
      child.child.stdin?.end();
    }
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

test('exit 0 when there is nothing to report', async () => {
  const result = await cli([fixturePath('healthy-indexed-7.0.json')]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /no findings/);
});

test('exit 1 when findings are reported', async () => {
  const result = await cli([fixturePath('group-spill-classic-7.0.json')]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /spilled to disk/);
});

test('exit 2 when the input cannot be read as explain output', async () => {
  const result = await cli([fixturePath('invalid-not-explain.json')]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /does not look like explain output/);
});

test('exit 2 for a file that is not there', async () => {
  const result = await cli(['/nonexistent/explain.json']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot read/);
});

test('explain output can be piped in', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(fixturePath('collscan-optimized-pipeline-6.0.json'), 'utf8');
  const result = await cli([], raw);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /collection scan/);
});

test('mongosh output survives the trip through the shell', async () => {
  // Unquoted keys and type constructors, as the shell prints them.
  const shellish = `{
    queryPlanner: { namespace: 'shop.orders', winningPlan: { stage: 'COLLSCAN', filter: { userId: ObjectId('66f0a1b2c3d4e5f6a7b8c9d0') } } },
    executionStats: { nReturned: 12, executionTimeMillis: 900, totalKeysExamined: 0, totalDocsExamined: 500000,
      executionStages: { stage: 'COLLSCAN', nReturned: 12, docsExamined: 500000 } }
  }`;
  const result = await cli([], shellish);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /collection scan/);
});

test('--json emits the machine contract and nothing else', async () => {
  const result = await cli([fixturePath('unselective-index-8.0.json'), '--json']);
  const payload = JSON.parse(result.stdout);

  assert.equal(result.code, 1);
  assert.equal(payload.findings[0].rule, 'unselective-index');
});

test('--min-severity raises the bar for failing a build', async () => {
  const target = fixturePath('unindexed-sort-7.0.json');

  assert.equal((await cli([target])).code, 1, 'a medium finding fails by default');
  assert.equal((await cli([target, '--min-severity', 'high'])).code, 0, 'and passes at high');
});

test('--indexes turns the analysis into a command', async () => {
  const target = fixturePath('collscan-single-equality-7.0.json');

  const without = await cli([target]);
  assert.match(without.stdout, /Index analysis/);
  assert.doesNotMatch(without.stdout, /createIndex/, 'no command without the index list');

  const withList = await cli([target, '--indexes', fixturePath('../indexes/applications.json')]);
  assert.match(withList.stdout, /db\.applications\.createIndex\(\{ organisationId: 1 \}\)/);
  assert.match(withList.stdout, /4,010,000/, 'the document count is printed alongside');
});

test('an index list that says nothing is rejected, not believed', async () => {
  const result = await cli([
    fixturePath('collscan-single-equality-7.0.json'),
    '--indexes',
    fixturePath('../indexes/empty.json'),
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /contains no indexes/);
});

test('--help explains itself and exits clean', async () => {
  const result = await cli(['--help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /USAGE/);
  assert.match(result.stdout, /disk-spill/);
});

test('an unknown flag is a usage error, not a silent pass', async () => {
  const result = await cli(['--wat']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown flag/);
});
