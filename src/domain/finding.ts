import type { JsonObject } from './json.ts';
import type { PlanLayer, PlanNode } from './plan-node.ts';

/**
 * What a rule produces. Three parts, in the order a reader needs them: the
 * verdict, the numbers that produced it, and what those numbers mean.
 *
 * The split is deliberate. A tool that prints the numbers alone is the thing
 * that already exists and does not help; a tool that prints the verdict alone is
 * something you cannot check. Both, in that order, is the product.
 */
export interface Finding {
  readonly rule: RuleId;
  readonly severity: Severity;
  /** The verdict, one line: `$group (stage 3) spilled to disk`. */
  readonly title: string;
  readonly location: FindingLocation;
  /** The numbers behind the verdict, pre-formatted. One string per line. */
  readonly evidence: readonly string[];
  /** What it means and what to do. Prose; the renderer wraps it. */
  readonly explanation: readonly string[];
  /** The same facts unformatted, for `--json` and for anything downstream. */
  readonly data: JsonObject;
}

export type RuleId =
  | 'disk-spill'
  | 'collection-scan'
  | 'scan-ratio'
  | 'unselective-index'
  | 'unindexed-sort';

/**
 * `high` costs seconds now, `medium` costs seconds at the next data-size
 * doubling, `low` is worth knowing when you are already in here.
 */
export type Severity = 'high' | 'medium' | 'low';

export interface FindingLocation {
  readonly stage: string;
  readonly layer: PlanLayer;
  /** Position in the *executed* pipeline — see `PlanNode.pipelineIndex`. */
  readonly pipelineIndex: number | undefined;
  readonly shard: string | undefined;
  /** Rendered form: `$group (stage 3)`, `COLLSCAN`, `SORT on shard02`. */
  readonly label: string;
}

/**
 * Something a rule could not decide. Reported, never guessed: "the input has no
 * execution stats" is useful, and inventing a verdict from a plan we did not
 * watch run is not.
 */
export interface Note {
  readonly kind: 'inconclusive' | 'info';
  readonly text: string;
}

export function locationOf(node: PlanNode): FindingLocation {
  return {
    stage: node.stage,
    layer: node.layer,
    pipelineIndex: node.pipelineIndex,
    shard: node.shard,
    label: labelFor(node),
  };
}

function labelFor(node: PlanNode): string {
  const position =
    node.pipelineIndex === undefined ? '' : ` (stage ${node.pipelineIndex + 1})`;
  const shard = node.shard === undefined ? '' : ` on ${node.shard}`;
  return `${node.stage}${position}${shard}`;
}

/**
 * The title without its ` on <shard>` suffix, for the case where one finding is
 * reported on several shards and the suffix is what makes them look different.
 *
 * It lives here, beside `labelFor`, because it depends on that format: the two
 * must be read together or the coupling is invisible.
 */
export function titleWithoutShard(finding: Finding): string {
  const { shard } = finding.location;
  return shard === undefined ? finding.title : finding.title.replace(` on ${shard}`, '');
}

/**
 * Identity of a finding, for collapsing duplicates.
 *
 * Slot-based explain describes one stage twice — once in the query plan under
 * its classic name, once in the execution tree under its slot-based one — so the
 * same sort can be found by the same rule twice. Two reports of one problem
 * teaches the reader to skim, which is how a tool stops being read.
 */
export function signatureOf(finding: Finding): string {
  const { rule, location } = finding;
  return [rule, location.shard ?? '', location.pipelineIndex ?? '', location.stage.toLowerCase()].join(
    '|',
  );
}
