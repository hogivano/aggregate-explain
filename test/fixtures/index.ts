import { readFileSync } from 'node:fs';
import type { RuleId } from '../../src/index.ts';

/**
 * The fixtures are the product.
 *
 * Every claim this tool makes is a claim about the shape of explain output from
 * some server version, and the only way to keep those claims honest is a table
 * of real payloads with the expected verdict written next to each one. A rule
 * change that quietly stops firing on a shape shows up here as a failing row.
 *
 * See `explain/README.md` for where these came from and how to add more.
 */

export interface FixtureCase {
  readonly file: string;
  /** What this payload is, in the terms the fixture exists to test. */
  readonly describes: string;
  /** Rule ids expected, in any order. The empty array is the important one. */
  readonly expectedRules: readonly RuleId[];
  /** Expected top-line numbers, when the fixture is there to pin them down. */
  readonly expectedSummary?: {
    readonly executionTimeMillis?: number;
    readonly totalDocsExamined?: number;
    readonly nReturned?: number;
    readonly sharded?: boolean;
    readonly engine?: 'classic' | 'slot-based' | 'unknown';
  };
  /** True when the fixture should also produce at least one inconclusive note. */
  readonly expectsInconclusiveNote?: boolean;
}

export const FIXTURES: readonly FixtureCase[] = [
  {
    file: 'group-spill-classic-7.0.json',
    describes: 'the flagship: a $group that spilled, in the aggregation `stages` shape',
    expectedRules: ['disk-spill'],
    // The elapsed time must come from the $group stage, not from $cursor: the
    // cursor finished in 1.2s and the pipeline took 4.2s.
    expectedSummary: { executionTimeMillis: 4213, totalDocsExamined: 1840000, engine: 'classic' },
  },
  {
    file: 'collscan-optimized-pipeline-6.0.json',
    describes: 'a pipeline optimised into a plain query, scanning the collection',
    expectedRules: ['collection-scan'],
    expectedSummary: { totalDocsExamined: 1240000, nReturned: 3100 },
  },
  {
    file: 'collscan-single-equality-7.0.json',
    describes: 'the one case an index command is safe to print: single-field equality',
    expectedRules: ['collection-scan'],
  },
  {
    file: 'sort-spill-sbe-8.0.json',
    describes: 'slot-based execution: the sort is named twice and must be reported once',
    expectedRules: ['disk-spill'],
    expectedSummary: { engine: 'slot-based' },
  },
  {
    file: 'sharded-collscan-8.0.json',
    describes: 'a sharded cluster: one finding for the whole problem, counts summed',
    expectedRules: ['collection-scan'],
    expectedSummary: {
      sharded: true,
      totalDocsExamined: 1610000,
      nReturned: 400,
      // The engine is a property of the shards; mongos does not report one.
      engine: 'classic',
    },
  },
  {
    file: 'unselective-index-8.0.json',
    describes: 'an index that is used and still is not helping',
    expectedRules: ['unselective-index'],
  },
  {
    file: 'unindexed-sort-7.0.json',
    describes: 'a sort no index provides, well under the spill limit',
    expectedRules: ['unindexed-sort'],
  },
  {
    file: 'query-planner-only-7.0.json',
    describes: 'queryPlanner verbosity: the plan is visible, nothing was measured',
    expectedRules: ['collection-scan'],
    expectsInconclusiveNote: true,
  },
  // The two that matter most. A tool that always finds something gets ignored.
  {
    file: 'healthy-indexed-7.0.json',
    describes: 'a well-indexed pipeline — must produce nothing',
    expectedRules: [],
  },
  {
    file: 'healthy-small-collscan-7.0.json',
    describes: '400 documents scanned to return 40 — a 10:1 ratio that is completely fine',
    expectedRules: [],
  },
];

export function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(fixturePath(file), 'utf8'));
}

export function fixturePath(file: string): string {
  return new URL(`./explain/${file}`, import.meta.url).pathname;
}
