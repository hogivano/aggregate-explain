import type { Report } from '../../application/analyze.ts';

/**
 * `--json` output. A stable contract for anything that reads this in CI, so it
 * is built explicitly rather than by serialising internal objects: the shape
 * below changes only on purpose.
 *
 * The normalised explain tree is deliberately not included. It would be the
 * largest part of the payload and it is a restatement of the input the caller
 * already has.
 */

/** Bumped only for a breaking change to the shape below. */
export const JSON_SCHEMA_VERSION = 1;

export function renderJson(report: Report): string {
  return `${JSON.stringify(
    {
      schemaVersion: JSON_SCHEMA_VERSION,
      summary: report.summary,
      findings: report.findings.map((finding) => ({
        rule: finding.rule,
        severity: finding.severity,
        title: finding.title,
        location: finding.location,
        evidence: finding.evidence,
        explanation: finding.explanation,
        data: finding.data,
      })),
      suggestions: report.suggestions.map((suggestion) => ({
        namespace: suggestion.namespace,
        location: suggestion.location,
        esr: suggestion.esr,
        existingIndexes: suggestion.existingIndexes ?? null,
        observedIndexes: suggestion.observedIndexes,
        counts: suggestion.counts,
        command: suggestion.command ?? null,
        reasons: suggestion.reasons,
      })),
      notes: report.notes,
    },
    null,
    2,
  )}\n`;
}
