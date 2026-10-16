import { MalformedExplainError } from './errors.ts';
import {
  arrayAt,
  booleanAt,
  isObject,
  numberAt,
  objectAt,
  stringAt,
  type Json,
  type JsonObject,
} from './json.ts';
import { walkAll, type NodeMetrics, type PlanLayer, type PlanNode } from './plan-node.ts';

/**
 * Normalisation: build this wrong and the tool silently reports nothing.
 *
 * The same aggregation, explained, arrives in one of four layouts:
 *
 *   1. `{ stages: [ { $cursor: {...} }, { $group: {...} } ] }`
 *      the usual case — stages the optimiser could not push into the query
 *      layer stay in the aggregation layer and report their own stats
 *   2. `{ queryPlanner: {...}, executionStats: {...} }`
 *      the whole pipeline was pushed down; `queryPlanner.optimizedPipeline` is
 *      true and it looks exactly like a `find()` explain
 *   3. slot-based execution, where `winningPlan.queryPlan` holds the tree that
 *      sits directly under `winningPlan` in the classic engine
 *   4. sharded, where either of the above nests under a `shards` map
 *
 * Every one of them collapses here into units of `PlanNode`s. A rule that had to
 * know which of the four it was looking at would be a rule that quietly finds
 * nothing on the fourth.
 */

export interface NormalisedExplain {
  readonly server: ServerInfo;
  readonly namespace: string | undefined;
  readonly sharded: boolean;
  /** One per shard, or exactly one when the explain is not sharded. */
  readonly units: readonly ExecutionUnit[];
  /** Summed across units. Undefined when the explain has no execution stats. */
  readonly totals: ExecutionTotals | undefined;
  /** True when `explain("executionStats")` (or better) produced the input. */
  readonly hasExecutionStats: boolean;
  /** The pipeline as written, from `command.pipeline`, when the server echoed it. */
  readonly pipeline: readonly Json[] | undefined;
  readonly raw: JsonObject;
}

export interface ServerInfo {
  /** `serverInfo.version`, e.g. `8.0.4`. */
  readonly version: string | undefined;
  /** `explainVersion`: "1" is the classic engine, "2" is slot-based. */
  readonly explainVersion: string | undefined;
  readonly engine: ExecutionEngine;
}

export type ExecutionEngine = 'classic' | 'slot-based' | 'unknown';

/** One shard's worth of work — or the whole query, when there is only one. */
export interface ExecutionUnit {
  readonly shard: string | undefined;
  readonly namespace: string | undefined;
  /** `queryPlanner.optimizedPipeline`: the pipeline became a plain query. */
  readonly optimizedPipeline: boolean;
  /**
   * `queryPlanner.parsedQuery`: the filter after the server canonicalised it.
   * The best available statement of what this query actually tested, and the
   * input the index analysis wants — a hand-written filter can say
   * `{ status: 'open' }` where the server says `{ status: { $eq: 'open' } }`.
   */
  readonly parsedQuery: Json | undefined;
  readonly totals: ExecutionTotals | undefined;
  readonly hasExecutionStats: boolean;
  /** Tree roots: aggregation stages in executed order, then the query plan. */
  readonly roots: readonly PlanNode[];
  /** Every node under every root, flattened once so rules do not re-walk. */
  readonly nodes: readonly PlanNode[];
}

export interface ExecutionTotals {
  readonly nReturned: number | undefined;
  readonly executionTimeMillis: number | undefined;
  readonly totalDocsExamined: number | undefined;
  readonly totalKeysExamined: number | undefined;
}

/** Keys whose value is a child stage. Known names first; unknown ones are found
 *  structurally below, so a new server release adds nodes rather than losing them. */
const CHILD_KEYS = [
  'inputStage',
  'inputStages',
  'innerStage',
  'outerStage',
  'leftStage',
  'rightStage',
  'thenStage',
  'elseStage',
  'queryPlan',
];

/** Top-level keys that mark the input as explain output rather than some other JSON. */
const EXPLAIN_MARKERS = ['queryPlanner', 'stages', 'executionStats', 'shards'];

/**
 * Turn anything explain-shaped into the internal model.
 *
 * @throws {MalformedExplainError} when the input is not explain output at all.
 */
export function normaliseExplain(input: unknown): NormalisedExplain {
  const raw = asExplainObject(input);
  const server = readServerInfo(raw);
  const units = readUnits(raw);
  const totals = sumTotals(units);

  return {
    server,
    namespace: units.find((unit) => unit.namespace !== undefined)?.namespace,
    sharded: units.some((unit) => unit.shard !== undefined),
    units,
    totals,
    hasExecutionStats: units.some((unit) => unit.hasExecutionStats),
    pipeline: readPipeline(raw),
    raw,
  };
}

function asExplainObject(input: unknown): JsonObject {
  // mongosh and some driver paths hand back a one-element array.
  const unwrapped = Array.isArray(input) && input.length === 1 ? input[0] : input;

  if (!isObject(unwrapped)) {
    throw new MalformedExplainError('input is not a JSON object', [
      'Expected the output of db.collection.explain("executionStats").aggregate(...)',
      `Got ${Array.isArray(input) ? `an array of ${input.length}` : typeof input}.`,
    ]);
  }
  if (!EXPLAIN_MARKERS.some((key) => key in unwrapped)) {
    throw new MalformedExplainError('input does not look like explain output', [
      `Expected one of ${EXPLAIN_MARKERS.join(', ')} at the top level;`,
      `found ${Object.keys(unwrapped).slice(0, 6).join(', ') || '(no keys)'}.`,
    ]);
  }
  return unwrapped;
}

function readServerInfo(raw: JsonObject): ServerInfo {
  // On a sharded cluster the engine is a property of the shards, not of mongos:
  // `explainVersion` and the plan shape live inside each shard's own explain, so
  // the first shard answers a question the top level cannot.
  const body = readShardBodies(raw)[0]?.body ?? raw;
  const explainVersion = readExplainVersion(body);

  return {
    version:
      stringAt(objectAt(raw, 'serverInfo') ?? {}, 'version') ??
      stringAt(objectAt(body, 'serverInfo') ?? {}, 'version'),
    explainVersion,
    engine: readEngine(body, explainVersion),
  };
}

/** `explainVersion` is a string in current servers and a number in some older output. */
function readExplainVersion(raw: JsonObject): string | undefined {
  const value = raw['explainVersion'];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function readEngine(raw: JsonObject, explainVersion: string | undefined): ExecutionEngine {
  if (explainVersion === '2') return 'slot-based';
  if (explainVersion === '1') return 'classic';
  // No version field: fall back to the shape itself. `slotBasedPlan` and a
  // nested `queryPlan` only exist under slot-based execution.
  const winningPlan = objectAt(objectAt(raw, 'queryPlanner') ?? {}, 'winningPlan');
  if (winningPlan && ('slotBasedPlan' in winningPlan || 'queryPlan' in winningPlan)) {
    return 'slot-based';
  }
  return 'unknown';
}

function readPipeline(raw: JsonObject): readonly Json[] | undefined {
  return arrayAt(objectAt(raw, 'command') ?? {}, 'pipeline');
}

// --- Units ------------------------------------------------------------------

function readUnits(raw: JsonObject): readonly ExecutionUnit[] {
  const shards = readShardBodies(raw);
  if (shards.length > 0) return shards.map(({ name, body }) => buildUnit(body, name));
  return [buildUnit(raw, undefined)];
}

/**
 * Sharded aggregation explain nests each shard's own explain under `shards`,
 * keyed by shard name. Some server versions and the `find`-shaped output use an
 * array of `{ shardName, ... }` instead, so both are accepted.
 */
function readShardBodies(raw: JsonObject): { name: string; body: JsonObject }[] {
  const shards = raw['shards'];

  if (isObject(shards)) {
    return Object.entries(shards)
      .filter((entry): entry is [string, JsonObject] => isObject(entry[1]))
      .map(([name, body]) => ({ name, body }));
  }
  if (Array.isArray(shards)) {
    return shards.filter(isObject).map((body, index) => ({
      name: stringAt(body, 'shardName') ?? `shard${index}`,
      body,
    }));
  }
  return [];
}

function buildUnit(body: JsonObject, shard: string | undefined): ExecutionUnit {
  const stages = arrayAt(body, 'stages');
  const roots =
    stages !== undefined
      ? buildAggregationStages(stages, shard)
      : buildQueryRoots(body, shard);

  const queryPlanner = findInUnit(body, 'queryPlanner');
  const executionStats = findInUnit(body, 'executionStats');

  return {
    shard,
    namespace: stringAt(queryPlanner ?? {}, 'namespace'),
    optimizedPipeline: booleanAt(queryPlanner ?? {}, 'optimizedPipeline') ?? false,
    parsedQuery: queryPlanner?.['parsedQuery'],
    totals: executionStats ? readTotals(executionStats, roots) : undefined,
    hasExecutionStats: executionStats !== undefined,
    roots,
    nodes: [...walkAll(roots)],
  };
}

/**
 * `queryPlanner` and `executionStats` sit at the top of the unit when the
 * pipeline was pushed down, and inside `$cursor` when it was not. Same numbers
 * for the same work either way — but only one of the two places exists.
 */
function findInUnit(body: JsonObject, key: 'queryPlanner' | 'executionStats'): JsonObject | undefined {
  const top = objectAt(body, key);
  if (top) return top;

  for (const cursor of cursorBodies(body)) {
    const nested = objectAt(cursor, key);
    if (nested) return nested;
  }
  return undefined;
}

/** The bodies of every `$cursor`-like stage in a `stages` array. */
function cursorBodies(body: JsonObject): JsonObject[] {
  return (arrayAt(body, 'stages') ?? [])
    .filter(isObject)
    .map(findCursorBody)
    .filter((cursor): cursor is JsonObject => cursor !== undefined);
}

function readTotals(executionStats: JsonObject, roots: readonly PlanNode[]): ExecutionTotals {
  return {
    nReturned: numberAt(executionStats, 'nReturned'),
    executionTimeMillis: elapsedFor(executionStats, roots),
    totalDocsExamined: numberAt(executionStats, 'totalDocsExamined'),
    totalKeysExamined: numberAt(executionStats, 'totalKeysExamined'),
  };
}

/**
 * How long the pipeline took.
 *
 * In the pushed-down shape `executionStats.executionTimeMillis` is the answer.
 * In the `stages` shape it is not: that number lives inside `$cursor` and covers
 * only the query layer, so a pipeline whose four seconds were spent in a later
 * `$group` would be reported as fast. Aggregation stages report a cumulative
 * estimate, so the largest of them is the closer answer.
 */
function elapsedFor(executionStats: JsonObject, roots: readonly PlanNode[]): number | undefined {
  const candidates = [
    numberAt(executionStats, 'executionTimeMillis'),
    ...roots
      .filter((root) => root.layer === 'aggregation')
      .map((root) => root.metrics.executionTimeMillis),
  ].filter((value) => value !== undefined);

  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/**
 * Across shards the counters add up and the durations do not: shards run in
 * parallel, so the pipeline took as long as its slowest shard, not their sum.
 */
function sumTotals(units: readonly ExecutionUnit[]): ExecutionTotals | undefined {
  const present = units.map((unit) => unit.totals).filter((totals) => totals !== undefined);
  if (present.length === 0) return undefined;

  const add = (pick: (totals: ExecutionTotals) => number | undefined): number | undefined => {
    const values = present.map(pick).filter((value) => value !== undefined);
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
  };
  const max = (pick: (totals: ExecutionTotals) => number | undefined): number | undefined => {
    const values = present.map(pick).filter((value) => value !== undefined);
    return values.length === 0 ? undefined : Math.max(...values);
  };

  return {
    nReturned: add((totals) => totals.nReturned),
    executionTimeMillis: max((totals) => totals.executionTimeMillis),
    totalDocsExamined: add((totals) => totals.totalDocsExamined),
    totalKeysExamined: add((totals) => totals.totalKeysExamined),
  };
}

// --- Aggregation layer ------------------------------------------------------

/**
 * A `stages` entry is a single-key object: `{ "$group": {...}, nReturned, ... }`
 * where the stage's own spill and timing stats sit *beside* the operator key,
 * not inside it.
 */
function buildAggregationStages(stages: readonly Json[], shard: string | undefined): PlanNode[] {
  return stages.filter(isObject).map((stage, index) => {
    const name = operatorKey(stage) ?? '(unknown stage)';
    const cursor = findCursorBody(stage);

    return {
      stage: name,
      layer: 'aggregation' as PlanLayer,
      pipelineIndex: index,
      shard,
      metrics: readMetrics(stage),
      raw: stage,
      // A `$cursor` stage is the query layer wearing an aggregation-stage
      // wrapper: its plan hangs underneath as this stage's children.
      children: cursor ? buildQueryRoots(cursor, shard) : [],
    };
  });
}

/** The `$`-prefixed key that names the stage, e.g. `$group`. */
function operatorKey(stage: JsonObject): string | undefined {
  return Object.keys(stage).find((key) => key.startsWith('$'));
}

/** `$cursor` and `$geoNearCursor` both carry a nested query-layer explain. */
function findCursorBody(stage: JsonObject): JsonObject | undefined {
  const key = operatorKey(stage);
  if (key === undefined || !key.toLowerCase().includes('cursor')) return undefined;
  const body = objectAt(stage, key);
  return body && ('queryPlanner' in body || 'executionStats' in body) ? body : undefined;
}

// --- Query layer ------------------------------------------------------------

/**
 * Roots for the query layer of one unit.
 *
 * Under the classic engine `executionStages` is the winning plan with the
 * counters filled in, so it supersedes `winningPlan` and we return one tree.
 * Under slot-based execution the two are genuinely different trees — `queryPlan`
 * names the stages (`COLLSCAN`, `SORT`) while `executionStages` holds the
 * slot-based operators that carry the spill counters — so both are returned and
 * duplicate findings are collapsed later by signature.
 */
function buildQueryRoots(body: JsonObject, shard: string | undefined): PlanNode[] {
  const executionStages = objectAt(objectAt(body, 'executionStats') ?? {}, 'executionStages');
  const winningPlan = objectAt(objectAt(body, 'queryPlanner') ?? {}, 'winningPlan');
  const queryPlan = winningPlan ? objectAt(winningPlan, 'queryPlan') : undefined;

  const roots: PlanNode[] = [];
  if (executionStages) roots.push(buildQueryNode(executionStages, shard));

  const plannerRoot = queryPlan ?? winningPlan;
  // Keep the planner tree only when it says something the execution tree does
  // not: either there are no execution stats, or slot-based execution renamed
  // everything underneath.
  if (plannerRoot && (executionStages === undefined || queryPlan !== undefined)) {
    roots.push(buildQueryNode(plannerRoot, shard));
  }
  return roots;
}

function buildQueryNode(node: JsonObject, shard: string | undefined): PlanNode {
  return {
    stage: stringAt(node, 'stage') ?? '(unknown stage)',
    layer: 'query',
    pipelineIndex: undefined,
    // A SHARD_MERGE node names the shard each subtree came from; that name wins
    // over the enclosing unit's, which is undefined in this shape anyway.
    shard: stringAt(node, 'shardName') ?? shard,
    metrics: readMetrics(node),
    raw: node,
    children: readChildren(node, stringAt(node, 'shardName') ?? shard),
  };
}

function readChildren(node: JsonObject, shard: string | undefined): PlanNode[] {
  const children: PlanNode[] = [];
  const seen = new Set<string>();

  const take = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const value = node[key];
    if (isObject(value)) children.push(buildQueryNode(value, shard));
    else if (Array.isArray(value)) {
      for (const entry of value.filter(isObject)) children.push(buildQueryNode(entry, shard));
    }
  };

  for (const key of CHILD_KEYS) if (key in node) take(key);

  // Structural fallback. `shards` (find-shaped sharded output) arrives this way,
  // and so will whatever the next server release names its child pointer: any
  // nested object that has a `stage` of its own is a stage of its own.
  for (const [key, value] of Object.entries(node)) {
    if (seen.has(key) || key === 'raw') continue;
    if (looksLikeStage(value) || (Array.isArray(value) && value.some(looksLikeStage))) take(key);
  }
  return children;
}

function looksLikeStage(value: Json | undefined): boolean {
  return (
    isObject(value) &&
    (typeof value['stage'] === 'string' ||
      isObject(value['executionStages']) ||
      isObject(value['queryPlan']))
  );
}

// --- Metrics ----------------------------------------------------------------

/**
 * One place where server field names are read. Every rule reads `NodeMetrics`
 * instead, so a renamed field is a one-line change here rather than a hunt.
 */
function readMetrics(node: JsonObject): NodeMetrics {
  return {
    nReturned: numberAt(node, 'nReturned'),
    executionTimeMillis:
      numberAt(node, 'executionTimeMillisEstimate') ?? numberAt(node, 'executionTimeMillis'),
    docsExamined: numberAt(node, 'docsExamined'),
    keysExamined: numberAt(node, 'keysExamined'),

    usedDisk: booleanAt(node, 'usedDisk'),
    spills: numberAt(node, 'spills'),
    spilledBytes: numberAt(node, 'spilledBytes'),
    spilledRecords: numberAt(node, 'spilledRecords'),
    spilledDataStorageSize: numberAt(node, 'spilledDataStorageSize'),
    peakTrackedMemBytes: numberAt(node, 'peakTrackedMemBytes'),

    memLimit: numberAt(node, 'memLimit'),
    memUsage: numberAt(node, 'memUsage') ?? numberAt(node, 'totalDataSizeSortedBytesEstimate'),

    indexName: stringAt(node, 'indexName'),
    keyPattern: objectAt(node, 'keyPattern'),
    filter: node['filter'],
    sortPattern: objectAt(node, 'sortPattern'),
  };
}
