/**
 * Exit codes are the CI contract: a build step reads these, not the prose.
 *
 * The distinction that matters is 1 against 2. "I looked and found problems" and
 * "I could not read the input" are opposite answers, and a pipeline that treats
 * a parse failure as a clean run is worse than no check at all.
 */
export const EXIT = {
  /** Analysed, nothing to report. */
  clean: 0,
  /** Analysed, findings reported. */
  findings: 1,
  /** Could not analyse: unreadable or malformed input, bad usage. */
  malformed: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
