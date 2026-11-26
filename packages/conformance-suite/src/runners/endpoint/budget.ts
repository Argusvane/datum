/**
 * The request budget of an endpoint run: a hard cap on requests, a pause
 * between them, and the one rule for a 429 (obey a `Retry-After` of at most a minute, once;
 * otherwise stop). Serial by construction: `take()` is awaited before every request.
 */
export class BudgetExhausted extends Error {
  constructor(public readonly max: number) {
    super(`the request budget (${max}) is spent; raise --max-requests or run fewer vectors`);
    this.name = "BudgetExhausted";
  }
}

/** The server said "too many requests" and the run cannot or may not wait it out. */
export class RateLimitedOut extends Error {
  constructor(
    public readonly retryAfterSeconds: number | undefined,
    public readonly status: number
  ) {
    super(
      retryAfterSeconds === undefined
        ? "the server answered 429 without a Retry-After; the run stops here"
        : `the server answered 429 with Retry-After ${retryAfterSeconds} s (more than the 60 s the run will wait, or already waited once); the run stops here`
    );
    this.name = "RateLimitedOut";
  }
}

export interface BudgetOptions {
  maxRequests: number;
  delayMs: number;
  /** Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const MAX_RETRY_AFTER_SECONDS = 60;

export class Budget {
  public sent = 0;
  public rateLimited = false;
  /** How many 429 answers were seen (the REC-14 row reads them). */
  public answers429 = 0;
  private waitedOnce = false;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(private readonly options: BudgetOptions) {
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public get maxRequests(): number {
    return this.options.maxRequests;
  }

  /** Counts one request (and pauses before every request after the first). Throws when the cap is reached. */
  public async take(): Promise<void> {
    if (this.sent >= this.options.maxRequests) {
      throw new BudgetExhausted(this.options.maxRequests);
    }
    if (this.sent > 0 && this.options.delayMs > 0) {
      await this.sleepFn(this.options.delayMs);
    }
    this.sent += 1;
  }

  /**
   * A 429 was answered. Returns true when the caller should retry once (after the wait done
   * here); throws {@link RateLimitedOut} when it must stop.
   */
  public async onTooManyRequests(retryAfterSeconds: number | undefined, status = 429): Promise<true> {
    this.answers429 += 1;
    if (!this.waitedOnce && retryAfterSeconds !== undefined && retryAfterSeconds >= 0 && retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS) {
      this.waitedOnce = true;
      await this.sleepFn(retryAfterSeconds * 1000);
      return true;
    }
    this.rateLimited = true;
    throw new RateLimitedOut(retryAfterSeconds, status);
  }
}

/** A `Retry-After` header as seconds: a number, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}
