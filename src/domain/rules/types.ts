import type { Finding, Note, RuleId } from '../finding.ts';
import type { JsonObject } from '../json.ts';
import type { NormalisedExplain } from '../normalize.ts';

/**
 * A rule looks at the normalised explain and returns a verdict or nothing. It
 * never guesses: when the data needed to decide is absent, it says so in a note
 * and returns no finding.
 */
export interface Rule {
  readonly id: RuleId;
  /** One line, used by `--help` and the JSON output. */
  readonly summary: string;
  evaluate(context: RuleContext): RuleOutcome;
}

export interface RuleContext {
  readonly explain: NormalisedExplain;
  readonly thresholds: Thresholds;
  /**
   * Findings from rules that ran earlier, in registry order.
   *
   * Rules are independent detectors but overlapping reporters: a collection scan
   * already states its scan ratio, and a spilled `$sort` is a worse fact than an
   * unindexed one. Later rules defer rather than say the same thing twice.
   */
  readonly findingsSoFar: readonly Finding[];
}

export interface RuleOutcome {
  readonly findings: readonly Finding[];
  readonly notes: readonly Note[];
}

/**
 * The numbers that decide whether a ratio is a problem.
 *
 * Every one of these is a floor as well as a ratio, and the floor is the part
 * that matters: examining 400 documents to return 40 is a 10:1 ratio and
 * completely fine. A tool that reports it gets uninstalled by Friday.
 */
export interface Thresholds {
  /** `totalDocsExamined / nReturned`. */
  readonly scanRatio: RatioThreshold;
  /** `totalKeysExamined / nReturned`, when an index is in use. */
  readonly keyRatio: RatioThreshold;
  /** A collection scan below this many documents is not worth anyone's evening. */
  readonly collectionScanMinDocs: number;
  /** Above this, a collection scan is reported as `high` rather than `medium`. */
  readonly collectionScanSevereDocs: number;
  /**
   * Share of the documents read that a filter may match and still be worth an
   * index. Above it, an index is read, mostly matches, and keeps costing writes
   * — so the numbers get printed instead of a command.
   */
  readonly suggestionMaxSelectivity: number;
}

export interface RatioThreshold {
  readonly minRatio: number;
  /** Absolute floor on the examined count, so small collections stay quiet. */
  readonly minExamined: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  scanRatio: { minRatio: 10, minExamined: 1_000 },
  keyRatio: { minRatio: 10, minExamined: 1_000 },
  collectionScanMinDocs: 1_000,
  collectionScanSevereDocs: 100_000,
  suggestionMaxSelectivity: 0.2,
};

/** `a · b · c`, skipping the parts that had no value to report. */
export function evidenceLine(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

/** True when an earlier rule already reported on this shard. */
export function alreadyReported(
  context: RuleContext,
  rule: RuleId,
  shard: string | undefined,
): boolean {
  return context.findingsSoFar.some(
    (finding) => finding.rule === rule && finding.location.shard === shard,
  );
}

/**
 * Drops the keys the server did not report, so `--json` carries facts rather
 * than a wall of nulls that a consumer has to filter itself.
 */
export function numericData(values: Record<string, number | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}
