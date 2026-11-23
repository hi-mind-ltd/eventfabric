import type { BackoffOptions } from "@eventfabric/core";

/** Backoff after a failed round, matching the async projection runner's default. */
export const DEFAULT_LOOP_BACKOFF: BackoffOptions = { minMs: 250, maxMs: 15_000, factor: 2, jitter: 0.2 };

/**
 * A sleep that `interrupt()` ends early, so `stop()` doesn't wait out an
 * idle sleep or an error backoff.
 */
export class InterruptibleSleep {
  private wake?: () => void;

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === done) self.wake = undefined;
        resolve();
      }
      this.wake = done;
    });
  }

  interrupt(): void {
    this.wake?.();
  }
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
