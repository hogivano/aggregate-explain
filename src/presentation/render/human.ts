import {
  formatCount,
  formatDuration,
  keyToString,
  plural,
  type Finding,
  type IndexInfo,
  type IndexSuggestion,
  type Note,
} from '../../domain/index.ts';
import type { Report, ReportSummary } from '../../application/analyze.ts';

/**
 * Verdict first, then the numbers that produced it, then what it means.
 *
 * The thing this must never become is a pretty-printed dump: that already exists
 * as `explain()` itself, and it is the reason anybody needs this tool. Every line
 * below either states a conclusion or supports one.
 *
 * Plain text, no colour codes. Half of these reports end up pasted into a chat
 * window or read out of a CI log, where escape sequences become noise.
 */

const WIDTH = 78;

/** One character per severity, in a fixed column, so the shape reads at a glance. */
const SIGILS: Record<Finding['severity'], string> = { high: '!', medium: '~', low: '-' };

export function renderReport(report: Report): string {
  const lines: string[] = ['', ...headline(report), ''];

  for (const finding of report.findings) lines.push(...renderFinding(finding), '');
  if (report.findings.length === 0) lines.push(...renderClean(report.summary), '');
  for (const suggestion of report.suggestions) lines.push(...renderSuggestion(suggestion), '');
  if (report.notes.length > 0) lines.push(...renderNotes(report.notes), '');

  return lines.join('\n');
}

function headline(report: Report): string[] {
  const { summary } = report;
  const elapsed =
    summary.executionTimeMillis === undefined
      ? 'Pipeline'
      : `Pipeline: ${formatDuration(summary.executionTimeMillis)}`;
  const findings =
    summary.findingCount === 0 ? 'no findings' : plural(summary.findingCount, 'finding');

  return [
    `  ${elapsed} · ${findings}${severityBreakdown(summary)}`,
    ...packParts(context(summary), 2),
  ];
}

function severityBreakdown(summary: ReportSummary): string {
  const parts = (['high', 'medium', 'low'] as const)
    .filter((severity) => summary.bySeverity[severity] > 0)
    .map((severity) => `${summary.bySeverity[severity]} ${severity}`);
  return parts.length > 1 ? ` (${parts.join(', ')})` : '';
}

/** The second header line: what was measured, and on what. */
function context(summary: ReportSummary): string[] {
  const parts: string[] = [];
  if (summary.namespace !== undefined) parts.push(summary.namespace);
  if (summary.totalDocsExamined !== undefined) {
    parts.push(`${formatCount(summary.totalDocsExamined)} docs examined`);
  }
  if (summary.nReturned !== undefined) parts.push(`${formatCount(summary.nReturned)} returned`);
  if (summary.serverVersion !== undefined) parts.push(`mongod ${summary.serverVersion}`);
  if (summary.engine !== 'unknown') parts.push(`${summary.engine} engine`);
  if (summary.sharded) parts.push(`${summary.shardCount} shards`);
  return parts;
}

function renderFinding(finding: Finding): string[] {
  return [
    ...wrap(finding.title, 2, `  ${SIGILS[finding.severity]} `),
    // Evidence is near-verbatim server output — a filter document, a list of
    // counters — so it wraps only when it has to, and never gets reformatted.
    ...finding.evidence.flatMap((line) => wrap(line, 8, '      ')),
    // A blank line before the prose: the reader should be able to stop after the
    // numbers, and see at a glance where the explanation starts.
    ...finding.explanation.flatMap((paragraph) => ['', ...wrap(paragraph, 6)]),
  ];
}

/**
 * The zero-findings case, which carries more weight than it looks: a tool that
 * always finds something gets ignored, so when it finds nothing it should say so
 * with the numbers that justify the silence.
 */
function renderClean(summary: ReportSummary): string[] {
  if (!summary.hasExecutionStats) return ['  Nothing to report from a plan alone.'];

  const examined = summary.totalDocsExamined;
  const returned = summary.nReturned;
  if (examined === undefined || returned === undefined) return ['  No findings.'];

  return wrap(
    `No findings. ${formatCount(examined)} documents examined to return` +
      ` ${formatCount(returned)} — nothing in this pipeline is doing work it should not.`,
    2,
  );
}

/**
 * The index analysis. Four aligned rows of fact, then either a command or the
 * reasons there is not one.
 *
 * The rows are not decoration: the E-S-R breakdown is the reasoning, the index
 * list is what stops a duplicate recommendation, and the counts are what stop an
 * index on a field with three distinct values. A suggestion printed without them
 * is a suggestion the reader has to take on trust.
 */
function renderSuggestion(suggestion: IndexSuggestion): string[] {
  const { esr } = suggestion;
  const lines = [
    `  = Index analysis · ${suggestion.namespace ?? 'the query'} (${suggestion.location.stage})`,
    ...row('equality', esr.equality.join(', ')),
    ...row('sort', esr.sort.map((field) => `${field.field}: ${field.direction}`).join(', ')),
    ...row('range', esr.range.join(', ')),
    ...row('key', esr.recommendedKey.length === 0 ? '' : keyToString(esr.recommendedKey)),
    ...indexRows(suggestion),
    ...row('counts', countsOf(suggestion)),
  ];

  if (suggestion.command !== undefined) {
    lines.push('', '      Suggested:', `        ${suggestion.command}`);
  }
  return [...lines, ...suggestion.reasons.flatMap((reason) => ['', ...wrap(reason, 6)])];
}

/**
 * Which index list we are showing, and how much it is worth. The distinction is
 * load-bearing: the full list rules out a duplicate, the plan's partial view
 * cannot, and saying so is what keeps the reader from treating them alike.
 */
function indexRows(suggestion: IndexSuggestion): string[] {
  if (suggestion.existingIndexes !== undefined) {
    return row('existing', describeIndexes(suggestion.existingIndexes));
  }
  return [
    ...row('observed', describeIndexes(suggestion.observedIndexes)),
    ...row('', '(only the ones this query considered — pass --indexes for the full list)'),
  ];
}

function describeIndexes(indexes: readonly IndexInfo[]): string {
  if (indexes.length === 0) return 'none';
  return indexes.map((index) => `${index.name} ${keyToString(index.key)}`).join(' · ');
}

function countsOf(suggestion: IndexSuggestion): string {
  const { documentsExamined, documentsReturned, collectionDocuments, selectivity } =
    suggestion.counts;
  const parts: string[] = [];

  if (documentsExamined !== undefined) parts.push(`${formatCount(documentsExamined)} read`);
  if (documentsReturned !== undefined) {
    // "of them", not "of the collection": after an index scan those are
    // different numbers, and the row must not quietly claim the stronger one.
    const share = selectivity === undefined ? '' : ` (${formatPercent(selectivity)} of them)`;
    parts.push(`${formatCount(documentsReturned)} matched${share}`);
  }
  if (collectionDocuments !== undefined) {
    parts.push(`${formatCount(collectionDocuments)} in the collection`);
  }
  return parts.join(' · ');
}

function formatPercent(ratio: number): string {
  return ratio >= 0.1 ? `${Math.round(ratio * 100)}%` : `${(ratio * 100).toFixed(1)}%`;
}

/**
 * A labelled row in the analysis block, wrapped under its own value column so a
 * long index list stays readable. An empty value prints as a dash.
 */
function row(label: string, value: string): string[] {
  const gutter = 6;
  const column = 9;
  return wrap(value === '' ? '—' : value, gutter + column, `${' '.repeat(gutter)}${label.padEnd(column)}`);
}

function renderNotes(notes: readonly Note[]): string[] {
  return ['  Notes', ...notes.flatMap((note) => wrap(note.text, 4))];
}

/**
 * Greedy wrap at `WIDTH`. Continuation lines are indented by `indent`; the first
 * line takes `firstPrefix` when it differs — that is how a severity sigil sits
 * in its own column with the wrapped remainder lined up under the text.
 */
function wrap(paragraph: string, indent: number, firstPrefix?: string): string[] {
  const prefix = ' '.repeat(indent);
  const lines: string[] = [];
  let current = '';

  const prefixFor = (): string => (lines.length === 0 ? (firstPrefix ?? prefix) : prefix);

  for (const word of paragraph.split(/\s+/).filter((token) => token !== '')) {
    if (current === '') current = word;
    else if (prefixFor().length + current.length + 1 + word.length <= WIDTH) current += ` ${word}`;
    else {
      lines.push(prefixFor() + current);
      current = word;
    }
  }
  if (current !== '') lines.push(prefixFor() + current);
  return lines;
}

/** Packs ` · `-separated parts onto as few lines as they fit on. */
function packParts(parts: readonly string[], indent: number): string[] {
  const prefix = ' '.repeat(indent);
  const lines: string[] = [];
  let current = '';

  for (const part of parts) {
    const candidate = current === '' ? part : `${current} · ${part}`;
    if (prefix.length + candidate.length <= WIDTH) current = candidate;
    else {
      if (current !== '') lines.push(prefix + current);
      current = part;
    }
  }
  if (current !== '') lines.push(prefix + current);
  return lines;
}
