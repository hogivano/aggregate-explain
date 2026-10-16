#!/usr/bin/env node
import { analyzeExplain, type ReportSummary } from './application/analyze.ts';
import { AggregateExplainError, type Finding, type Severity } from './domain/index.ts';
import { readCollectionContext, readExplainInput } from './infrastructure/input/read-explain.ts';
import { atOrAbove, parseArgs, UsageError } from './presentation/args.ts';
import { EXIT, type ExitCode } from './presentation/exit-codes.ts';
import { helpText } from './presentation/help.ts';
import { renderJson } from './presentation/render/json.ts';
import { renderReport } from './presentation/render/human.ts';
import { VERSION } from './version.ts';

/**
 * Read input, analyse it, print it, pick an exit code. Everything else lives a
 * layer down — this file should stay boring enough to read in one sitting.
 */
async function main(argv: readonly string[]): Promise<ExitCode> {
  const options = parseArgs(argv);
  const out = (text: string): void => void process.stdout.write(text);

  if (options.help) {
    out(helpText(VERSION));
    return EXIT.clean;
  }
  if (options.version) {
    out(`${VERSION}\n`);
    return EXIT.clean;
  }

  const input = await readExplainInput(options.file);
  const collection =
    options.indexesFile === undefined
      ? undefined
      : await readCollectionContext(options.indexesFile);
  const report = analyzeExplain(input.value, collection === undefined ? {} : { collection });

  // Severity filtering happens here rather than in the analyser: the report is
  // the truth, and what a given CI job chooses to fail on is a presentation
  // decision. Filtered-out findings do not affect the exit code either.
  const findings = report.findings.filter((finding) =>
    atOrAbove(finding.severity, options.minSeverity),
  );
  // With every finding filtered out there is nothing for an index analysis to be
  // about, so it goes too rather than floating on its own.
  const suggestions = findings.length === 0 ? [] : report.suggestions;
  const filtered = {
    ...report,
    findings,
    suggestions,
    summary: { ...summaryFor(report.summary, findings), suggestionCount: suggestions.length },
  };

  out(options.json ? renderJson(filtered) : renderReport(filtered));
  return findings.length > 0 ? EXIT.findings : EXIT.clean;
}

/** The summary counts what is printed, so a filtered report stays self-consistent. */
function summaryFor(summary: ReportSummary, findings: readonly Finding[]): ReportSummary {
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;
  return { ...summary, findingCount: findings.length, bySeverity };
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`\n  error: ${error.message}\n  Run \`aggregate-explain --help\`.\n\n`);
    process.exitCode = EXIT.malformed;
  } else if (error instanceof AggregateExplainError) {
    process.stderr.write(`\n  error: ${error.message}\n`);
    for (const line of error.details) process.stderr.write(`  ${line}\n`);
    process.stderr.write('\n');
    process.exitCode = EXIT.malformed;
  } else {
    // Not a failure we anticipated. Show the stack — hiding it helps nobody.
    process.stderr.write('\n  unexpected error\n');
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n\n`);
    process.exitCode = EXIT.malformed;
  }
}
