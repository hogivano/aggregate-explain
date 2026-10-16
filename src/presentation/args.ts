import type { Severity } from '../domain/index.ts';

/**
 * A small argv parser instead of a dependency. One command and five flags do not
 * justify a framework, and hand-rolling it keeps the parser and the help text in
 * neighbouring files where they cannot drift apart.
 */

export interface CliOptions {
  /** Path to read, or undefined for stdin. */
  readonly file: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  /** Findings below this severity are not printed and do not affect the exit code. */
  readonly minSeverity: Severity;
  /**
   * Path to the collection's index list — `db.c.getIndexes()`, or an object
   * `{ indexes, documentCount }`. Without it the index analysis still runs but
   * will not print a command.
   */
  readonly indexesFile: string | undefined;
}

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low'];

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): CliOptions {
  let file: string | undefined;
  let json = false;
  let help = false;
  let version = false;
  let minSeverity: Severity = 'low';
  let indexesFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === '--json') json = true;
    else if (token === '--help' || token === '-h') help = true;
    else if (token === '--version' || token === '-V') version = true;
    else if (token.startsWith('--min-severity')) {
      const value = token.includes('=') ? token.split('=')[1] : argv[(i += 1)];
      minSeverity = asSeverity(value);
    } else if (token.startsWith('--indexes')) {
      indexesFile = token.includes('=') ? token.split('=')[1] : argv[(i += 1)];
      if (indexesFile === undefined) throw new UsageError('--indexes needs a file');
    } else if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`unknown flag: ${token}`);
    } else if (file === undefined) {
      file = token;
    } else {
      throw new UsageError(`unexpected argument: ${token} (one file at a time)`);
    }
  }

  return { file, json, help, version, minSeverity, indexesFile };
}

function asSeverity(value: string | undefined): Severity {
  if (value !== undefined && (SEVERITIES as readonly string[]).includes(value)) {
    return value as Severity;
  }
  throw new UsageError(`--min-severity must be one of ${SEVERITIES.join(', ')}`);
}

/** Keeps only findings at or above `floor`. */
export function atOrAbove(severity: Severity, floor: Severity): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(floor);
}
