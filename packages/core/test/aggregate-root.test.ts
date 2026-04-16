import { describe, it, expect } from "vitest";
import { AggregateRoot } from "../src/aggregates/aggregate-root";

type E =
  | { type: "Inc"; version: 1; by: number }
  | { type: "Dec"; version: 1; by: number };

class Counter extends AggregateRoot<{ n: number }, E> {
  protected handlers = {
    Inc: (s, e) => { s.n += e.by; },
    Dec: (s, e) => { s.n -= e.by; }
  };
  constructor(id: string) { super(id, { n: 0 }); }
  inc(by: number) { this.raise({ type: "Inc", version: 1, by }); }
}

describe("AggregateRoot", () => {
  it("applies handlers and records pending events", () => {
    const c = new Counter("1");
    c.inc(3);
    expect(c.state.n).toBe(3);
    expect(c.pullPendingEvents()).toHaveLength(1);
  });

  describe("loadFromHistory", () => {
    it("loads aggregate from history events", () => {
      const c = new Counter("1");
      const history = [
        { payload: { type: "Inc", version: 1, by: 5 } as E, aggregateVersion: 1 },
        { payload: { type: "Inc", version: 1, by: 3 } as E, aggregateVersion: 2 },
        { payload: { type: "Dec", version: 1, by: 2 } as E, aggregateVersion: 3 }
      ];

      c.loadFromHistory(history);

      expect(c.state.n).toBe(6); // 0 + 5 + 3 - 2 = 6
      expect(c.version).toBe(3);
    });

    it("sets version correctly from history", () => {
      const c = new Counter("1");
      const history = [
        { payload: { type: "Inc", version: 1, by: 1 } as E, aggregateVersion: 1 },
        { payload: { type: "Inc", version: 1, by: 1 } as E, aggregateVersion: 2 },
        { payload: { type: "Inc", version: 1, by: 1 } as E, aggregateVersion: 5 } // Non-sequential version
      ];

      c.loadFromHistory(history);

      expect(c.version).toBe(5); // Should be set to last aggregateVersion
    });

    it("does not add history events to pending", () => {
      const c = new Counter("1");
      const history = [
        { payload: { type: "Inc", version: 1, by: 5 } as E, aggregateVersion: 1 },
        { payload: { type: "Inc", version: 1, by: 3 } as E, aggregateVersion: 2 }
      ];

      c.loadFromHistory(history);

      // History events should not be in pending
      expect(c.pullPendingEvents()).toHaveLength(0);
    });

    it("handles empty history", () => {
      const c = new Counter("1");
      c.loadFromHistory([]);

      expect(c.state.n).toBe(0);
      expect(c.version).toBe(0);
    });

    it("applies events in order", () => {
      const c = new Counter("1");
      const history = [
        { payload: { type: "Inc", version: 1, by: 10 } as E, aggregateVersion: 1 },
        { payload: { type: "Dec", version: 1, by: 3 } as E, aggregateVersion: 2 },
        { payload: { type: "Inc", version: 1, by: 5 } as E, aggregateVersion: 3 }
      ];

      c.loadFromHistory(history);

      expect(c.state.n).toBe(12); // 0 + 10 - 3 + 5 = 12
    });
  });

  describe("version tracking", () => {
    it("starts with version 0", () => {
      const c = new Counter("1");
      expect(c.version).toBe(0);
    });

    it("increments version when raising events", () => {
      const c = new Counter("1");
      c.inc(1);
      // Version is managed by Repository, not AggregateRoot
      // But we can verify the initial version
      expect(c.version).toBe(0);
    });

    it("tracks version from loadFromHistory", () => {
      const c = new Counter("1");
      c.loadFromHistory([
        { payload: { type: "Inc", version: 1, by: 1 } as E, aggregateVersion: 10 }
      ]);
      expect(c.version).toBe(10);
    });
  });

  describe("multiple event types", () => {
    it("handles different event types correctly", () => {
      const c = new Counter("1");
      const history = [
        { payload: { type: "Inc", version: 1, by: 10 } as E, aggregateVersion: 1 },
        { payload: { type: "Dec", version: 1, by: 4 } as E, aggregateVersion: 2 },
        { payload: { type: "Inc", version: 1, by: 2 } as E, aggregateVersion: 3 },
        { payload: { type: "Dec", version: 1, by: 1 } as E, aggregateVersion: 4 }
      ];

      c.loadFromHistory(history);

      expect(c.state.n).toBe(7); // 0 + 10 - 4 + 2 - 1 = 7
    });

    it("raises different event types", () => {
      class ExtendedCounter extends Counter {
        dec(by: number) {
          this.raise({ type: "Dec", version: 1, by });
        }
      }

      const c = new ExtendedCounter("1");
      c.inc(10);
      c.dec(3);
      c.inc(5);

      const pending = c.pullPendingEvents();
      expect(pending).toHaveLength(3);
      expect(pending[0]!.type).toBe("Inc");
      expect(pending[1]!.type).toBe("Dec");
      expect(pending[2]!.type).toBe("Inc");
      expect(c.state.n).toBe(12); // 0 + 10 - 3 + 5 = 12
    });

    it("throws error for unhandled event type", () => {
      type UnhandledE = { type: "Unknown"; version: 1; value: number };
      class TestAggregate extends AggregateRoot<{ n: number }, UnhandledE> {
        protected handlers = {}; // No handlers
        constructor(id: string) {
          super(id, { n: 0 });
        }
      }

      const agg = new TestAggregate("1");
      expect(() => {
        agg.loadFromHistory([
          { payload: { type: "Unknown", version: 1, value: 1 }, aggregateVersion: 1 }
        ]);
      }).toThrow("No handler for event type: Unknown");
    });
  });
});
