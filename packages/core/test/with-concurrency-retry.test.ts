import { describe, it, expect, vi } from "vitest";
import { withConcurrencyRetry } from "../src/resilience/with-concurrency-retry";

class ConcurrencyError extends Error {
  constructor(message = "concurrency") {
    super(message);
    this.name = "ConcurrencyError";
  }
}

describe("withConcurrencyRetry", () => {
  it("returns the result when fn succeeds on the first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withConcurrencyRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on ConcurrencyError and returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ConcurrencyError())
      .mockRejectedValueOnce(new ConcurrencyError())
      .mockResolvedValueOnce("ok");

    const result = await withConcurrencyRetry(fn, { maxAttempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after maxAttempts consecutive ConcurrencyErrors", async () => {
    const fn = vi.fn().mockRejectedValue(new ConcurrencyError("boom"));
    await expect(withConcurrencyRetry(fn, { maxAttempts: 4 })).rejects.toBeInstanceOf(
      ConcurrencyError
    );
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not retry on unrelated errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("unrelated"));
    await expect(withConcurrencyRetry(fn, { maxAttempts: 5 })).rejects.toThrow("unrelated");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("defaults to 3 attempts total", async () => {
    const fn = vi.fn().mockRejectedValue(new ConcurrencyError());
    await expect(withConcurrencyRetry(fn)).rejects.toBeInstanceOf(ConcurrencyError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("accepts a custom concurrency-error predicate", async () => {
    class CustomConflict extends Error {
      constructor() {
        super("conflict");
        this.name = "CustomConflict";
      }
    }

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new CustomConflict())
      .mockResolvedValueOnce("ok");

    const result = await withConcurrencyRetry(fn, {
      maxAttempts: 3,
      isConcurrencyError: (err) => err instanceof CustomConflict
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("applies backoff delay between retries when configured", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new ConcurrencyError())
        .mockResolvedValueOnce("ok");

      const promise = withConcurrencyRetry(fn, {
        maxAttempts: 3,
        backoff: { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 }
      });

      // First attempt rejects synchronously via the mock; let microtasks flush
      // so the retry path schedules its sleep.
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      // Before the backoff elapses, fn should not have been retried.
      await vi.advanceTimersByTimeAsync(50);
      expect(fn).toHaveBeenCalledTimes(1);

      // After advancing past the backoff window, the retry runs and resolves.
      await vi.advanceTimersByTimeAsync(200);
      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
