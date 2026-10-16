import type { Json, JsonObject } from './json.ts';

/**
 * The one tree shape every rule sees.
 *
 * MongoDB hands us at least four different layouts for the same information
 * (classic, slot-based, aggregation `stages` array, sharded), and the whole
 * design of this tool rests on collapsing them here so that no rule ever asks
 * "which engine produced this?". A rule that has to branch on plan shape is a
 * rule that silently reports nothing on the shape its author did not own.
 */
export interface PlanNode {
  /**
   * The stage name as the server wrote it: `COLLSCAN`, `IXSCAN`, `SORT` and
   * `GROUP` from the query layer, `$group`/`$sort`/`$lookup` from the
   * aggregation layer, and lower-case names such as `sort` or `ixseek` from the
   * slot-based engine. Never rewritten — a name we invented would not be
   * greppable against the user's own explain output.
   */
  readonly stage: string;

  /**
   * Which layer executed it. The distinction matters for reporting: an
   * aggregation-layer stage has a position in the pipeline the user wrote, a
   * query-layer stage has a filter and an index.
   */
  readonly layer: PlanLayer;

  /**
   * Position in the *executed* pipeline, for aggregation-layer stages only.
   *
   * This is explain's own ordering, not an index into the pipeline as written.
   * The optimiser merges, reorders and absorbs stages into `$cursor`, so the two
   * do not reliably line up and pretending otherwise would point people at the
   * wrong line of their own code.
   */
  readonly pipelineIndex: number | undefined;

  /** Shard that produced this node, when the explain was sharded. */
  readonly shard: string | undefined;

  readonly metrics: NodeMetrics;

  /** The untouched node, for `--json` output and for fields no rule reads yet. */
  readonly raw: JsonObject;

  readonly children: readonly PlanNode[];
}

export type PlanLayer = 'query' | 'aggregation';

/**
 * Every per-stage number a rule is allowed to reason about, extracted once.
 *
 * Field names on the right of each comment are the server's, kept here so the
 * mapping is auditable against the MongoDB manual in one place instead of being
 * spread across five rules.
 */
export interface NodeMetrics {
  /** `nReturned` — documents this stage passed on. */
  readonly nReturned: number | undefined;
  /** `executionTimeMillisEstimate`, or `executionTimeMillis` at the root. */
  readonly executionTimeMillis: number | undefined;
  /** `docsExamined` on COLLSCAN/FETCH. */
  readonly docsExamined: number | undefined;
  /** `keysExamined` on IXSCAN. */
  readonly keysExamined: number | undefined;

  // Spill stats. Present on stages that can spill: $sort, $group,
  // $setWindowFields, $bucketAuto, $graphLookup, $lookup.
  /** `usedDisk` — the headline signal. */
  readonly usedDisk: boolean | undefined;
  /** `spills` — number of spill events. */
  readonly spills: number | undefined;
  /** `spilledBytes` — written pre-compression. */
  readonly spilledBytes: number | undefined;
  /** `spilledRecords` */
  readonly spilledRecords: number | undefined;
  /** `spilledDataStorageSize` — on-disk size after compression. */
  readonly spilledDataStorageSize: number | undefined;
  /** `peakTrackedMemBytes` — MongoDB 8.3+ only. */
  readonly peakTrackedMemBytes: number | undefined;

  // SORT stages carry their own budget: memLimit is 104857600 (100MB) unless
  // the server was reconfigured.
  readonly memLimit: number | undefined;
  readonly memUsage: number | undefined;

  /** `indexName` on IXSCAN. */
  readonly indexName: string | undefined;
  /** `keyPattern` on IXSCAN — the index's own field order. */
  readonly keyPattern: JsonObject | undefined;
  /** `filter` on COLLSCAN/IXSCAN/FETCH — the predicate that actually ran. */
  readonly filter: Json | undefined;
  /** `sortPattern` on SORT. */
  readonly sortPattern: JsonObject | undefined;
}

/** Depth-first walk, root first. Rules iterate; they do not recurse themselves. */
export function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

/** Depth-first walk over several roots — a sharded explain has one per shard. */
export function* walkAll(nodes: Iterable<PlanNode>): Generator<PlanNode> {
  for (const node of nodes) yield* walk(node);
}

/**
 * Stage-name matching, case-insensitively and ignoring the `$` prefix, so one
 * call catches `SORT` (classic), `sort` (slot-based) and `$sort` (aggregation
 * layer). The three are the same stage wearing three engines' clothes.
 */
export function isStage(node: PlanNode, ...names: readonly string[]): boolean {
  const actual = canonicalStageName(node.stage);
  return names.some((name) => canonicalStageName(name) === actual);
}

function canonicalStageName(name: string): string {
  return name.replace(/^\$/, '').toLowerCase();
}
