/**
 * Process exit codes. Non-zero for everything but a clean pass, so CI
 * cannot read a half-run as success.
 */
export const EXIT = {
  /** Every scenario that ran passed (and, under `--fail-on untested`, every rule is tested). */
  passed: 0,
  /** A scenario failed or errored, the two sides disagreed (parity), a source had parse problems, or a rule is untested under `--fail-on untested`. */
  failed: 1,
  /** Usage or input error: bad flags, an unreadable definition, test file or program. */
  usage: 2,
  /** Inconclusive: no scenario came to a verdict (none found, or every one skipped). */
  inconclusive: 3,
  /** The tool itself broke. */
  internal: 4
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
