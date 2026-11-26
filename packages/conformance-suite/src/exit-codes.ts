/** Process exit codes. Non-zero for everything but a clean PASS, so CI cannot read a half-run as success. */
export const EXIT = {
  /** Verdict PASS. */
  pass: 0,
  /** An enforced vector FAILed (or a WARN/XPASS under `--fail-on warn`). */
  fail: 1,
  /** Usage or configuration error: bad flags, unreadable program, missing fixture id. */
  usage: 2,
  /** INCONCLUSIVE: preflight failed, rate limited out, or an enforced vector errored. */
  inconclusive: 3,
  /** The suite itself broke. */
  internal: 4
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
