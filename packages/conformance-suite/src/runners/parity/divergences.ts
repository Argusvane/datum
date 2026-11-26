/**
 * The divergence ledger: the only way two runtimes may differ. An unlisted
 * divergence is a FAIL; a listed one that no longer diverges is a WARN (stale, delete the entry);
 * an entry past `expires` excuses nothing and is a WARN too.
 */
export type ParityPair = "kernel-program" | "endpoint-program" | "browser-server";

export interface Divergence {
  /** What diverges: `<PAR id>/<item>`, e.g. `PAR-03/ISO-07` or `PAR-03/ISO-07#variant`; the item is the corpus vector or document. */
  vector: string;
  reason: string;
  /** ISO date; after it the entry no longer excuses the divergence. */
  expires?: string;
  /** Which comparison the entry is about. Only `kernel-program` entries are exercised in this build. */
  between: ParityPair;
}

/**
 * Entries known today. None is exercised by the kernel-versus-program comparison: those two are
 * the same source run by two engines and are expected to agree to the byte.
 */
export const DIVERGENCES: readonly Divergence[] = [
  {
    vector: "PAR-06/risky-pattern-composed",
    reason: "a composed risky regex: the server refuses it, the browser evaluates it",
    between: "browser-server"
  },
  {
    vector: "PAR-06/CAN-07",
    reason: "a lone surrogate or NUL key: PHP rejects it with 400, the program accepts it (logged as knownDivergence INFO)",
    between: "endpoint-program"
  }
];

export interface LedgerOutcome {
  /** Differences with no live entry: each one fails the vector. */
  undeclared: string[];
  /** Differences an entry excuses. */
  declared: { key: string; entry: Divergence }[];
  /** Entries for this comparison that the run exercised and found agreeing, or that have expired. */
  stale: { entry: Divergence; why: string }[];
}

/**
 * Settles the differences of one PAR vector against the ledger. `exercised` is every key the run
 * compared (agreeing or not); `differing` the ones that differed.
 */
export function settleAgainstLedger(
  parId: string,
  between: ParityPair,
  exercised: readonly string[],
  differing: readonly string[],
  ledger: readonly Divergence[] = DIVERGENCES,
  now: Date = new Date()
): LedgerOutcome {
  const entries = ledger.filter((entry) => entry.between === between && entry.vector.startsWith(`${parId}/`));
  const live = (entry: Divergence): boolean => entry.expires === undefined || new Date(entry.expires).getTime() >= now.getTime();
  const outcome: LedgerOutcome = { undeclared: [], declared: [], stale: [] };
  for (const key of differing) {
    const entry = entries.find((candidate) => candidate.vector === `${parId}/${key}`);
    if (entry !== undefined && live(entry)) {
      outcome.declared.push({ key, entry });
    } else {
      outcome.undeclared.push(key);
    }
  }
  for (const entry of entries) {
    const key = entry.vector.slice(parId.length + 1);
    if (!live(entry)) {
      outcome.stale.push({ entry, why: `expired ${entry.expires}` });
    } else if (exercised.includes(key) && !differing.includes(key)) {
      outcome.stale.push({ entry, why: "no longer diverges" });
    }
  }
  return outcome;
}
