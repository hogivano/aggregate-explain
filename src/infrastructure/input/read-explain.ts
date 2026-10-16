import { readFile } from 'node:fs/promises';
import { text as readStream } from 'node:stream/consumers';
import {
  MalformedExplainError,
  isObject,
  numberAt,
  readIndexes,
  type CollectionContext,
  type Json,
} from '../../domain/index.ts';

/**
 * Getting the explain output off disk or off a pipe, and into an object.
 *
 * The only I/O in the tool. The core never touches this file; it takes the
 * object this module produces.
 */

export interface ExplainInput {
  /** Where it came from, for error messages: a path, or `stdin`. */
  readonly origin: string;
  readonly value: unknown;
}

/** Reads `path`, or standard input when the path is absent or `-`. */
export async function readExplainInput(path: string | undefined): Promise<ExplainInput> {
  if (path === undefined || path === '-') {
    const raw = await readStream(process.stdin);
    if (raw.trim() === '') {
      throw new MalformedExplainError('no input on stdin', [
        'Pipe explain output in, or pass a file:',
        '  mongosh --quiet --eval \'...\' | npx aggregate-explain',
        '  npx aggregate-explain explain.json',
      ]);
    }
    return { origin: 'stdin', value: parseExplain(raw, 'stdin') };
  }

  const raw = await readFile(path, 'utf8').catch((cause: NodeJS.ErrnoException) => {
    throw new MalformedExplainError(`cannot read ${path}`, [cause.message]);
  });
  return { origin: path, value: parseExplain(raw, path) };
}

/**
 * Parses explain JSON, with one fallback for shell output.
 *
 * `JSON.parse` handles everything a driver produces. What it does not handle is
 * a block copied out of mongosh, which prints unquoted keys and type
 * constructors — `ObjectId('...')`, `NumberLong(4)` — and that is exactly how
 * most people will get the output into a file. So a failed strict parse is
 * retried once against a de-shelled copy.
 *
 * The repair is deliberately a fallback rather than the default path: it edits
 * text with regular expressions and could in principle corrupt a string value
 * that happens to look like a constructor call. Valid JSON never reaches it.
 */
export function parseExplain(raw: string, origin: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (strictError) {
    try {
      return JSON.parse(deShell(raw));
    } catch {
      throw new MalformedExplainError(`${origin} is not valid JSON`, [
        (strictError as Error).message,
        'If this was copied out of mongosh, print it as JSON instead:',
        "  JSON.stringify(db.c.explain('executionStats').aggregate([...]))",
      ]);
    }
  }
}

/** Shell literals -> JSON. Each rule handles one thing mongosh prints. */
function deShell(raw: string): string {
  return (
    raw
      // ObjectId('..') / ISODate("..") / UUID('..') -> the string inside
      .replace(/\b[A-Z]\w*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, value: string) =>
        JSON.stringify(value),
      )
      // NumberLong(42) / NumberInt(7) -> the number
      .replace(/\bNumber(?:Long|Int|Decimal|Double)\(\s*(-?[\d.eE+]+)\s*\)/g, '$1')
      // Anything else that looks like a constructor call is data we do not read.
      .replace(/\b[A-Z]\w*\([^()]*\)/g, 'null')
      // Single-quoted strings, which the shell prefers and JSON forbids.
      .replace(/'((?:[^'\\]|\\.)*)'/g, (_match, value: string) =>
        JSON.stringify(value.replace(/\\'/g, "'")),
      )
      // Unquoted keys, as the shell's inspection format prints them.
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      // Trailing commas, which the shell does not print but hand-edited files do.
      .replace(/,(\s*[}\]])/g, '$1')
  );
}

/**
 * Loads the collection context: `db.c.getIndexes()` output, or an object
 * `{ indexes, documentCount }` carrying the count as well.
 *
 * An empty index list is rejected rather than accepted as "no indexes": every
 * collection has `_id_`, so an empty array means the capture went wrong, and
 * treating it as fact would let a suggestion through on the strength of a file
 * that says nothing.
 */
export async function readCollectionContext(path: string): Promise<CollectionContext> {
  const raw = await readFile(path, 'utf8').catch((cause: NodeJS.ErrnoException) => {
    throw new MalformedExplainError(`cannot read ${path}`, [cause.message]);
  });
  const parsed = parseExplain(raw, path) as Json;
  const indexes = readIndexes(parsed);

  if (indexes.length === 0) {
    throw new MalformedExplainError(`${path} contains no indexes`, [
      'Expected the output of db.collection.getIndexes(), which always includes _id_,',
      'or an object { indexes, documentCount }.',
    ]);
  }

  const documentCount = isObject(parsed) ? numberAt(parsed, 'documentCount') : undefined;
  return { indexes, ...(documentCount === undefined ? {} : { documentCount }) };
}
