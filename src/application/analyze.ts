import {
  DEFAULT_THRESHOLDS,
  RULES,
  normaliseExplain,
  signatureOf,
  suggestIndexes,
  titleWithoutShard,
  type ExecutionEngine,
  type Finding,
  type NormalisedExplain,
  type Note,
  type Rule,
  type CollectionContext,
  type IndexSuggestion,
  type RuleId,
  type Severity,
  type Thresholds,
} from '../domain/index.ts';

/**
 * The use case, and the whole library in one function: an explain object in, a
 * report out. No connection, no ODM, no state.
 */

export interface AnalyzeOptions {
  /** Override individual thresholds; anything omitted keeps its default. */
  readonly thresholds?: Partial<Thresholds>;
  /** Restrict the run to these rules. Defaults to all of them. */
  readonly rules?: readonly RuleId[];
  /**
   * The collection's real index list and document count — what explain output
   * does not carry. Without it the index analysis still runs, but it will not
   * print a command: it cannot rule out duplicating an index already there.
   */
  readonly collection?: CollectionContext;
}

export interface Report {
  readonly summary: ReportSummary;
  /** Highest severity first; within a severity, registry order. */
  readonly findings: readonly Finding[];
  /** Index analysis for the queries that findings were raised against. */
  readonly suggestions: readonly IndexSuggestion[];
  /** What could not be decided, and why. Never a substitute for a finding. */
  readonly notes: readonly Note[];
  /** The normalised input, for callers that want to walk it themselves. */
  readonly explain: NormalisedExplain;
}

export interface ReportSummary {
  readonly namespace: string | undefined;
  readonly serverVersion: string | undefined;
  readonly engine: ExecutionEngine;
  readonly sharded: boolean;
  readonly shardCount: number;
  readonly hasExecutionStats: boolean;
  readonly executionTimeMillis: number | undefined;
  readonly nReturned: number | undefined;
  readonly totalDocsExamined: number | undefined;
  readonly totalKeysExamined: number | undefined;
  readonly findingCount: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly suggestionCount: number;
}

const SEVERITY_ORDER: readonly Severity[] = ['high', 'medium', 'low'];

/**
 * Analyse explain output.
 *
 * @param input Anything `explain("executionStats")` produced — from mongosh, the
 *   driver, or any version of Mongoose. It is validated, not trusted.
 * @throws {MalformedExplainError} when the input is not explain output.
 */
export function analyzeExplain(input: unknown, options: AnalyzeOptions = {}): Report {
  const explain = normaliseExplain(input);
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const rules = selectRules(options.rules);

  const findings: Finding[] = [];
  const notes: Note[] = [...describeInput(explain)];
  const seen = new Set<string>();

  for (const rule of rules) {
    // Rules run in registry order and see what came before, so a later rule can
    // defer to a stronger finding instead of restating it.
    const outcome = rule.evaluate({ explain, thresholds, findingsSoFar: findings });

    for (const finding of outcome.findings) {
      const signature = signatureOf(finding);
      if (seen.has(signature)) continue;
      seen.add(signature);
      findings.push(finding);
    }
    notes.push(...outcome.notes);
  }

  // Suggestions are built from the unmerged findings, which still carry the
  // shard each was raised on; they are deduplicated on their own terms after.
  const suggestions = suggestIndexes(explain, findings, {
    context: options.collection,
    maxSelectivity: thresholds.suggestionMaxSelectivity,
  });

  const reported = sortFindings(mergeAcrossShards(findings));
  return {
    summary: summarise(explain, reported, suggestions),
    findings: reported,
    suggestions,
    notes,
    explain,
  };
}

function selectRules(ids: readonly RuleId[] | undefined): readonly Rule[] {
  if (ids === undefined) return RULES;
  const wanted = new Set(ids);
  return RULES.filter((rule) => wanted.has(rule.id));
}

/**
 * Notes about the input itself, added before any rule runs.
 *
 * The first one is the important one: without execution stats every rule that
 * counts documents has nothing to count, and a silent "no findings" would be a
 * lie by omission.
 */
function describeInput(explain: NormalisedExplain): Note[] {
  const notes: Note[] = [];

  if (!explain.hasExecutionStats) {
    notes.push({
      kind: 'inconclusive',
      text:
        'This explain has no execution stats, so nothing was measured — only the plan is' +
        ' visible. Re-run with explain("executionStats") for document counts, timings and' +
        ' spill data.',
    });
  }
  // Only worth saying when the reader wrote more than one stage: below that,
  // "your one-stage pipeline became a query" is a fact with no consequence, and
  // a note nobody needs is a note that teaches people to skip the section.
  if (explain.units.some((unit) => unit.optimizedPipeline) && (explain.pipeline?.length ?? 0) > 1) {
    notes.push({
      kind: 'info',
      text:
        'The whole pipeline was pushed into the query layer (optimizedPipeline), so stages' +
        ' are reported by plan stage rather than by pipeline position.',
    });
  }
  if (explain.sharded) {
    notes.push({
      kind: 'info',
      text:
        `Sharded across ${explain.units.length} shards. Counts are summed across shards;` +
        ' the elapsed time is the slowest shard, not the total.',
    });
  }
  return notes;
}

function summarise(
  explain: NormalisedExplain,
  findings: readonly Finding[],
  suggestions: readonly IndexSuggestion[],
): ReportSummary {
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;

  return {
    namespace: explain.namespace,
    serverVersion: explain.server.version,
    engine: explain.server.engine,
    sharded: explain.sharded,
    shardCount: explain.sharded ? explain.units.length : 1,
    hasExecutionStats: explain.hasExecutionStats,
    executionTimeMillis: explain.totals?.executionTimeMillis,
    nReturned: explain.totals?.nReturned,
    totalDocsExamined: explain.totals?.totalDocsExamined,
    totalKeysExamined: explain.totals?.totalKeysExamined,
    findingCount: findings.length,
    bySeverity,
    suggestionCount: suggestions.length,
  };
}

/**
 * One problem on four shards is one problem.
 *
 * Findings that differ only by shard are collapsed into a single finding whose
 * evidence names each shard's numbers, so the explanation — the longest part —
 * is stated once. Repeating identical prose per shard is how a report starts
 * getting skimmed, and a skimmed report is a report that missed something.
 */
function mergeAcrossShards(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = [
      finding.rule,
      finding.location.stage,
      finding.location.pipelineIndex ?? '',
      finding.explanation.join(' '),
    ].join('|');
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  return [...groups.values()].map((group) =>
    group.length === 1 || group.some((finding) => finding.location.shard === undefined)
      ? group[0]!
      : merge(group),
  );
}

function merge(group: readonly Finding[]): Finding {
  const first = group[0]!;
  // Lines every shard reported — the filter, the index — are facts about the
  // query, not about a shard. They are stated once, after the per-shard numbers.
  const shared = first.evidence.filter((line) =>
    group.every((finding) => finding.evidence.includes(line)),
  );

  return {
    ...first,
    severity: SEVERITY_ORDER.find((severity) =>
      group.some((finding) => finding.severity === severity),
    )!,
    title: `${titleWithoutShard(first)} (${group.length} shards)`,
    location: { ...first.location, shard: undefined, label: first.location.stage },
    evidence: [
      ...group.flatMap((finding) =>
        finding.evidence
          .filter((line) => !shared.includes(line))
          .map((line) => `${finding.location.shard}: ${line}`),
      ),
      ...shared,
    ],
    data: { shards: group.map((finding) => finding.data) },
  };
}

/** Severity first, then the order the rules ran in, which is stable. */
function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  const ruleRank = new Map(RULES.map((rule, index) => [rule.id, index]));
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return (ruleRank.get(a.rule) ?? 0) - (ruleRank.get(b.rule) ?? 0);
  });
}
