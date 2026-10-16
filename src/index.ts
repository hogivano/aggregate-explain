/**
 * Library surface — the core, and the whole product.
 *
 * It takes an explain object and returns a report. It has no dependencies, opens
 * no connections, and imports no ODM, because `explain()` output is produced by
 * the MongoDB *server*: Mongoose and the driver only pass it through. That is
 * what makes this layer version-proof by construction and testable against
 * static fixtures.
 *
 * The Mongoose convenience wrapper is a separate entry point,
 * `aggregate-explain/mongoose`, so that importing this one never resolves it.
 */
export { analyzeExplain } from './application/analyze.ts';
export type { AnalyzeOptions, Report, ReportSummary } from './application/analyze.ts';

export {
  AggregateExplainError,
  DEFAULT_THRESHOLDS,
  MalformedExplainError,
  RULES,
  buildEsr,
  isStage,
  keyToString,
  normaliseExplain,
  readIndexes,
  readPredicates,
  suggestIndexes,
  walk,
  walkAll,
} from './domain/index.ts';
export type {
  CollectionContext,
  EsrAnalysis,
  ExecutionEngine,
  ExecutionTotals,
  ExecutionUnit,
  Finding,
  FindingLocation,
  IndexInfo,
  IndexKeyField,
  IndexSuggestion,
  NodeMetrics,
  NormalisedExplain,
  Note,
  PlanNode,
  Predicate,
  Rule,
  RuleId,
  Severity,
  Thresholds,
} from './domain/index.ts';

export { renderReport } from './presentation/render/human.ts';
export { renderJson, JSON_SCHEMA_VERSION } from './presentation/render/json.ts';
export { EXIT } from './presentation/exit-codes.ts';
export type { ExitCode } from './presentation/exit-codes.ts';
export { VERSION } from './version.ts';
