import { analyzeExplain, type AnalyzeOptions, type Report } from '../application/analyze.ts';
import {
  MalformedExplainError,
  numberAt,
  readIndexes,
  type CollectionContext,
  type Json,
} from '../domain/index.ts';

/**
 * The Mongoose convenience layer — and the only place in the package where the
 * Mongoose version matrix applies at all.
 *
 * It is deliberately thin. The work happens in the core, which never sees
 * Mongoose, because `explain()` output comes from the MongoDB server and
 * Mongoose only passes it through. All this layer does is call `.explain()` and
 * hand the result to `analyzeExplain`.
 *
 * Mongoose is a peer dependency, and an optional one. Nothing here imports it:
 * the types below are structural, so a Mongoose 5 `Aggregate` and a Mongoose 9
 * `Aggregate` both satisfy them without this package caring which it was handed
 * — or resolving Mongoose at all if the caller only wants the core.
 */

/** Anything with an `explain()`: a Mongoose `Aggregate`, or your own stand-in. */
export interface ExplainableAggregate {
  explain(verbosity?: string): unknown;
}

/** Anything with an `aggregate()`: a Mongoose `Model`. */
export interface AggregatableModel {
  aggregate(pipeline: readonly unknown[]): ExplainableAggregate;
  /**
   * The index list and document count, when the model exposes them. Optional,
   * and probed rather than required: the method names differ across the driver
   * versions behind Mongoose 5 through 9, and a missing one costs a suggestion,
   * not the analysis.
   */
  readonly collection?: {
    indexes?: () => unknown;
    getIndexes?: () => unknown;
  };
  estimatedDocumentCount?: () => unknown;
}

export interface ExplainOptions extends AnalyzeOptions {
  /**
   * Read the collection's index list and document count as well, so the index
   * analysis can rule out duplicating an index that already exists. Two extra
   * round trips; pass `false` to skip them, or supply `collection` yourself.
   */
  readonly withCollectionContext?: boolean;

  /**
   * Explain verbosity. `executionStats` is the default because the plan alone
   * cannot answer the questions this tool exists to answer — nothing is measured
   * at `queryPlanner` verbosity, so no rule that counts anything can fire.
   */
  readonly verbosity?: 'queryPlanner' | 'executionStats' | 'allPlansExecution';
}

/**
 * Runs an aggregation under `explain()` and analyses the result.
 *
 * The pipeline really executes — that is what `executionStats` means — so point
 * this at a development or staging database, not at production under load.
 */
export async function analyzeAggregate(
  aggregate: ExplainableAggregate,
  options: ExplainOptions = {},
): Promise<Report> {
  const { verbosity = 'executionStats', ...analyzeOptions } = options;
  const raw = await aggregate.explain(verbosity);
  return analyzeExplain(unwrap(raw), analyzeOptions);
}

/**
 * The same, starting from a model and a pipeline — and, unlike the aggregate on
 * its own, able to fetch the collection context that index suggestions need.
 */
export async function analyzePipeline(
  model: AggregatableModel,
  pipeline: readonly unknown[],
  options: ExplainOptions = {},
): Promise<Report> {
  const collection =
    options.collection ??
    (options.withCollectionContext === false ? undefined : await collectionContextOf(model));

  return analyzeAggregate(model.aggregate(pipeline), {
    ...options,
    ...(collection === undefined ? {} : { collection }),
  });
}

/**
 * The collection's real index list and document count.
 *
 * Everything here is best-effort by design: it probes for method names, and any
 * failure returns undefined rather than throwing. A permissions error on
 * `indexes()` should cost you the index suggestion, not the whole report — and
 * a partial index list is worse than none, so a failure must not degrade into a
 * half-answer either.
 */
export async function collectionContextOf(
  model: AggregatableModel,
): Promise<CollectionContext | undefined> {
  try {
    const source = model.collection;
    const raw = await (source?.indexes?.() ?? source?.getIndexes?.());
    const indexes = readIndexes(raw as Json);
    if (indexes.length === 0) return undefined;

    const count = await model.estimatedDocumentCount?.();
    const documentCount = numberAt({ count: (count ?? null) as Json }, 'count');

    return { indexes, ...(documentCount === undefined ? {} : { documentCount }) };
  } catch {
    return undefined;
  }
}

/** Minimal shape of a Mongoose schema — enough to attach a static to. */
export interface SchemaWithStatics {
  statics: Record<string, unknown>;
}

/**
 * Schema plugin: adds `Model.explainAggregate(pipeline, options)`.
 *
 *   schema.plugin(aggregateExplainPlugin);
 *   const report = await Order.explainAggregate(pipeline);
 *
 * Sugar over `analyzePipeline`, for codebases that would rather not import a
 * function into every test file.
 */
export function aggregateExplainPlugin(schema: SchemaWithStatics): void {
  schema.statics['explainAggregate'] = function explainAggregate(
    this: AggregatableModel,
    pipeline: readonly unknown[],
    options: ExplainOptions = {},
  ): Promise<Report> {
    return analyzePipeline(this, pipeline, options);
  };
}

/**
 * Some driver and Mongoose paths wrap explain output in a one-element array.
 * Unwrapping it here keeps that quirk out of the core, which should only ever
 * have to understand shapes the *server* produces.
 */
function unwrap(raw: unknown): unknown {
  if (Array.isArray(raw) && raw.length === 1) return raw[0];
  if (raw === null || raw === undefined) {
    throw new MalformedExplainError('explain() returned nothing', [
      'Check that the object passed in is a Mongoose Aggregate (or has .explain()).',
    ]);
  }
  return raw;
}
