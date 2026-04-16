/**
 * Options for exponential backoff calculation.
 */
export type BackoffOptions = {
  minMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

/**
 * Calculates the backoff delay in milliseconds for a given attempt number.
 * Uses exponential backoff with jitter to prevent thundering herd problems.
 * 
 * @param attempt - The attempt number (0-based)
 * @param o - Backoff options
 * @returns The backoff delay in milliseconds
 */
export function computeBackoffMs(attempt: number, o: BackoffOptions): number {
  const base = Math.min(o.maxMs, o.minMs * Math.pow(o.factor, attempt));
  const j = base * o.jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(base + j));
}

/**
 * Sleeps for the specified duration, with optional abort signal support.
 * 
 * @param ms - Milliseconds to sleep
 * @param signal - Optional AbortSignal to cancel the sleep
 * @throws AbortError if the signal is aborted
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
