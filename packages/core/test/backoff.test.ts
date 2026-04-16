import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeBackoffMs, sleep, type BackoffOptions } from "../src/resilience/backoff";

describe("backoff", () => {
  describe("computeBackoffMs", () => {
    it("calculates exponential backoff for attempt 0", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
      const result = computeBackoffMs(0, opts);
      expect(result).toBe(100); // minMs * 2^0 = 100
    });

    it("calculates exponential backoff for attempt 1", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
      const result = computeBackoffMs(1, opts);
      expect(result).toBe(200); // minMs * 2^1 = 200
    });

    it("calculates exponential backoff for attempt 2", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
      const result = computeBackoffMs(2, opts);
      expect(result).toBe(400); // minMs * 2^2 = 400
    });

    it("calculates exponential backoff for attempt 3", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
      const result = computeBackoffMs(3, opts);
      expect(result).toBe(800); // minMs * 2^3 = 800
    });

    it("caps at maxMs when calculated value exceeds max", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 500, factor: 2, jitter: 0 };
      const result = computeBackoffMs(5, opts);
      // minMs * 2^5 = 3200, but should be capped at 500
      expect(result).toBe(500);
    });

    it("handles different factor values", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 10000, factor: 1.5, jitter: 0 };
      const result = computeBackoffMs(2, opts);
      expect(result).toBe(225); // 100 * 1.5^2 = 225
    });

    it("handles factor 1 (no exponential growth)", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 1, jitter: 0 };
      const result1 = computeBackoffMs(0, opts);
      const result2 = computeBackoffMs(5, opts);
      expect(result1).toBe(100);
      expect(result2).toBe(100); // Always minMs when factor is 1
    });

    it("applies jitter within expected range", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0.2 };
      const base = 100 * Math.pow(2, 1); // 200
      const maxJitter = base * 0.2; // 40
      
      // Run multiple times to check jitter range
      const results: number[] = [];
      for (let i = 0; i < 100; i++) {
        results.push(computeBackoffMs(1, opts));
      }

      // All results should be within [base - maxJitter, base + maxJitter]
      // But since we floor, the minimum is floor(base - maxJitter)
      const minExpected = Math.floor(base - maxJitter);
      const maxExpected = Math.floor(base + maxJitter);

      results.forEach(result => {
        expect(result).toBeGreaterThanOrEqual(minExpected);
        expect(result).toBeLessThanOrEqual(maxExpected);
      });
    });

    it("handles zero jitter", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
      const result1 = computeBackoffMs(1, opts);
      const result2 = computeBackoffMs(1, opts);
      expect(result1).toBe(200);
      expect(result2).toBe(200); // No jitter, same result
    });

    it("handles large jitter values", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0.5 };
      const base = 100 * Math.pow(2, 1); // 200
      const results: number[] = [];
      for (let i = 0; i < 50; i++) {
        results.push(computeBackoffMs(1, opts));
      }

      // With 0.5 jitter, range is [100, 300] (200 ± 100)
      const minExpected = Math.floor(base - base * 0.5);
      const maxExpected = Math.floor(base + base * 0.5);

      results.forEach(result => {
        expect(result).toBeGreaterThanOrEqual(minExpected);
        expect(result).toBeLessThanOrEqual(maxExpected);
      });
    });

    it("returns non-negative values even with negative jitter effect", () => {
      const opts: BackoffOptions = { minMs: 10, maxMs: 1000, factor: 2, jitter: 1.0 };
      // With jitter 1.0, we could get negative values, but Math.max(0, ...) prevents it
      const results: number[] = [];
      for (let i = 0; i < 100; i++) {
        const result = computeBackoffMs(0, opts);
        expect(result).toBeGreaterThanOrEqual(0);
        results.push(result);
      }
    });

    it("floors the result to integer", () => {
      const opts: BackoffOptions = { minMs: 33, maxMs: 1000, factor: 1.5, jitter: 0 };
      const result = computeBackoffMs(1, opts);
      // 33 * 1.5 = 49.5, should be floored to 49
      expect(result).toBe(49);
      expect(Number.isInteger(result)).toBe(true);
    });

    it("handles very small minMs", () => {
      const opts: BackoffOptions = { minMs: 1, maxMs: 1000, factor: 2, jitter: 0 };
      const result = computeBackoffMs(3, opts);
      expect(result).toBe(8); // 1 * 2^3 = 8
    });

    it("handles very large attempt numbers", () => {
      const opts: BackoffOptions = { minMs: 100, maxMs: 1000, factor: 2, jitter: 0 };
      const result = computeBackoffMs(100, opts);
      // Should be capped at maxMs
      expect(result).toBe(1000);
    });

    it("handles minMs equal to maxMs", () => {
      const opts: BackoffOptions = { minMs: 500, maxMs: 500, factor: 2, jitter: 0 };
      const result1 = computeBackoffMs(0, opts);
      const result2 = computeBackoffMs(10, opts);
      expect(result1).toBe(500);
      expect(result2).toBe(500); // Always capped at maxMs
    });
  });

  describe("sleep", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("sleeps for the specified duration", async () => {
      const sleepPromise = sleep(1000);
      expect(vi.getTimerCount()).toBe(1);
      
      vi.advanceTimersByTime(1000);
      await sleepPromise;
      
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns immediately for zero milliseconds", async () => {
      await sleep(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns immediately for negative milliseconds", async () => {
      await sleep(-100);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("can be aborted via AbortSignal", async () => {
      const ac = new AbortController();
      const sleepPromise = sleep(1000, ac.signal);

      // Abort before timeout
      ac.abort();

      await expect(sleepPromise).rejects.toMatchObject({ 
        message: "Aborted",
        name: "AbortError" 
      });
    });

    it("rejects with AbortError when aborted", async () => {
      const ac = new AbortController();
      const sleepPromise = sleep(1000, ac.signal);

      ac.abort();

      try {
        await sleepPromise;
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).toBe("Aborted");
        expect(e.name).toBe("AbortError");
      }
    });

    it("handles already aborted signal", async () => {
      const ac = new AbortController();
      ac.abort();

      const sleepPromise = sleep(1000, ac.signal);

      await expect(sleepPromise).rejects.toThrow("Aborted");
      expect(vi.getTimerCount()).toBe(0); // No timer should be set
    });

    it("cleans up timeout when aborted", async () => {
      const ac = new AbortController();
      const sleepPromise = sleep(1000, ac.signal);

      expect(vi.getTimerCount()).toBe(1);
      ac.abort();

      try {
        await sleepPromise;
      } catch {
        // Expected
      }

      expect(vi.getTimerCount()).toBe(0);
    });

    it("works without AbortSignal", async () => {
      const sleepPromise = sleep(500);
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(500);
      await sleepPromise;

      expect(vi.getTimerCount()).toBe(0);
    });

    it("handles multiple abort calls gracefully", async () => {
      const ac = new AbortController();
      const sleepPromise = sleep(1000, ac.signal);

      ac.abort();
      ac.abort(); // Second abort should not cause issues

      await expect(sleepPromise).rejects.toThrow("Aborted");
    });

    it("handles abort after sleep completes", async () => {
      const ac = new AbortController();
      const sleepPromise = sleep(100, ac.signal);

      vi.advanceTimersByTime(100);
      await sleepPromise; // Should complete successfully

      // Abort after completion should not affect anything
      ac.abort();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("handles very short sleep durations", async () => {
      const sleepPromise = sleep(1);
      vi.advanceTimersByTime(1);
      await sleepPromise;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("handles very long sleep durations", async () => {
      const sleepPromise = sleep(100000);
      expect(vi.getTimerCount()).toBe(1);
      
      vi.advanceTimersByTime(100000);
      await sleepPromise;
      
      expect(vi.getTimerCount()).toBe(0);
    });

    it("handles multiple concurrent sleeps", async () => {
      const sleep1 = sleep(100);
      const sleep2 = sleep(200);
      const sleep3 = sleep(300);

      expect(vi.getTimerCount()).toBe(3);

      vi.advanceTimersByTime(100);
      await sleep1;
      expect(vi.getTimerCount()).toBe(2);

      vi.advanceTimersByTime(100);
      await sleep2;
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(100);
      await sleep3;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("handles aborting one of multiple concurrent sleeps", async () => {
      const ac = new AbortController();
      const sleep1 = sleep(100);
      const sleep2 = sleep(200, ac.signal);
      const sleep3 = sleep(300);

      expect(vi.getTimerCount()).toBe(3);

      ac.abort();
      await expect(sleep2).rejects.toThrow("Aborted");
      expect(vi.getTimerCount()).toBe(2);

      vi.advanceTimersByTime(100);
      await sleep1;
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(200);
      await sleep3;
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

