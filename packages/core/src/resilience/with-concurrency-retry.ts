import { computeBackoffMs, sleep, type BackoffOptions } from "./backoff";

export type ConcurrencyRetryOptions = {
  /** Max total attempts including the first try. Default: 3. */
  maxAttempts?: number;
  /** Exponential backoff between retries. Default: no delay between retries. */
  backoff?: BackoffOptions;
  /**
   * Predicate that decides whether an error should trigger a retry.
   * Default: matches anything with `name === "ConcurrencyError"` — works for
   * the framework's own ConcurrencyError without coupling core to postgres.
   */
  isConcurrencyError?: (err: unknown) => boolean;
};

const defaultIsConcurrencyError = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { name?: string }).name === "ConcurrencyError";

/**
 * Runs `fn` and retries it if it throws a concurrency error. The caller is
 * responsible for doing a complete load → decide → save cycle inside `fn` —
 * retry re-invokes the whole function, so the aggregate must be re-loaded
 * from the store and the command handler re-run against the fresh state.
 *
 * Only opt in when you are certain the command is safe to re-run: no side
 * effects outside the transaction, no user-visible operations that already
 * fired, and no business decision that changes meaning under a different
 * starting state. When in doubt, don't retry — surface the error and let
 * the caller (API, job, user) decide.
 */
export async function withConcurrencyRetry<T>(
  fn: () => Promise<T>,
  opts: ConcurrencyRetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const isConcurrency = opts.isConcurrencyError ?? defaultIsConcurrencyError;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isConcurrency(err)) throw err;
      if (opts.backoff) await sleep(computeBackoffMs(attempt, opts.backoff));
    }
  }
}
