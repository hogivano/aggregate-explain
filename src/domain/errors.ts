/**
 * Errors the CLI knows how to print without a stack trace. Anything else is a
 * bug and gets the stack, because hiding an unexpected failure is worse than
 * showing one.
 */
export class AggregateExplainError extends Error {
  /** Extra lines printed under the message, already human-readable. */
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'AggregateExplainError';
    this.details = details;
  }
}

/**
 * The input is not explain output. Malformed input is its own exit code (2)
 * because "I could not read this" and "I read it and found nothing wrong" are
 * opposite answers, and a CI job must not confuse them.
 */
export class MalformedExplainError extends AggregateExplainError {
  constructor(message: string, details: readonly string[] = []) {
    super(message, details);
    this.name = 'MalformedExplainError';
  }
}
