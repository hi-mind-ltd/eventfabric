import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  computeEventHash,
  computeAnchorHash,
  streamGenesis,
  anchorGenesis,
  hashesEqual,
  toSecret,
  type ChainableEvent,
} from "../src/integrity/hash-chain";

const SECRET = toSecret("test-secret-key");
const OTHER_SECRET = toSecret("different-secret-key");

function makeEvent(overrides: Partial<ChainableEvent> = {}): ChainableEvent {
  return {
    tenantId: "acme",
    aggregateName: "audit",
    aggregateId: "a-1",
    aggregateVersion: 1,
    eventId: "11111111-1111-1111-1111-111111111111",
    type: "AuditRecorded",
    version: 1,
    payload: { action: "login", actor: "u-1" },
    correlationId: null,
    causationId: null,
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("is independent of object key insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively in nested objects", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it("preserves array order (arrays are ordered)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("omits undefined object properties (JSON semantics)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ x: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: Infinity })).toThrow(/non-finite/);
  });

  it("rejects bigint", () => {
    expect(() => canonicalJson({ x: 10n })).toThrow(/bigint/);
  });

  it("normalizes equal numbers to the same form (jsonb round-trip safety)", () => {
    // 1.10 and 1.1 are the same JS number; both must hash identically.
    expect(canonicalJson({ n: 1.1 })).toBe(canonicalJson({ n: 1.10 }));
  });
});

describe("computeEventHash", () => {
  it("is deterministic", () => {
    const prev = streamGenesis(SECRET, "acme", "audit", "a-1");
    const h1 = computeEventHash(SECRET, prev, makeEvent());
    const h2 = computeEventHash(SECRET, prev, makeEvent());
    expect(hashesEqual(h1, h2)).toBe(true);
    expect(h1.length).toBe(32);
  });

  it("changes when the payload changes", () => {
    const prev = streamGenesis(SECRET, "acme", "audit", "a-1");
    const base = computeEventHash(SECRET, prev, makeEvent());
    const tampered = computeEventHash(SECRET, prev, makeEvent({ payload: { action: "logout", actor: "u-1" } }));
    expect(hashesEqual(base, tampered)).toBe(false);
  });

  it("changes when any covered field changes", () => {
    const prev = streamGenesis(SECRET, "acme", "audit", "a-1");
    const base = computeEventHash(SECRET, prev, makeEvent());
    for (const override of [
      { aggregateVersion: 2 },
      { eventId: "22222222-2222-2222-2222-222222222222" },
      { type: "Other" },
      { version: 2 },
      { tenantId: "other" },
      { aggregateId: "a-2" },
      { correlationId: "c-1" },
    ] as Partial<ChainableEvent>[]) {
      expect(hashesEqual(base, computeEventHash(SECRET, prev, makeEvent(override)))).toBe(false);
    }
  });

  it("changes when the previous hash changes (the chain link)", () => {
    const prevA = streamGenesis(SECRET, "acme", "audit", "a-1");
    const prevB = streamGenesis(SECRET, "acme", "audit", "a-2");
    expect(hashesEqual(
      computeEventHash(SECRET, prevA, makeEvent()),
      computeEventHash(SECRET, prevB, makeEvent()),
    )).toBe(false);
  });

  it("changes when the secret changes (HMAC keying)", () => {
    const prev = streamGenesis(SECRET, "acme", "audit", "a-1");
    expect(hashesEqual(
      computeEventHash(SECRET, prev, makeEvent()),
      computeEventHash(OTHER_SECRET, prev, makeEvent()),
    )).toBe(false);
  });

  it("links a multi-event batch so each event depends on its predecessor", () => {
    // e1 -> e2 -> e3, mirroring how append() chains a batch in version order.
    let prev = streamGenesis(SECRET, "acme", "audit", "a-1");
    const hashes: Buffer[] = [];
    for (let v = 1; v <= 3; v++) {
      const h = computeEventHash(SECRET, prev, makeEvent({ aggregateVersion: v, eventId: `e-${v}` }));
      hashes.push(h);
      prev = h;
    }
    expect(new Set(hashes.map((h) => h.toString("hex"))).size).toBe(3);
  });
});

describe("streamGenesis / anchorGenesis", () => {
  it("is domain-separated by stream identity", () => {
    const g1 = streamGenesis(SECRET, "acme", "audit", "a-1");
    const g2 = streamGenesis(SECRET, "acme", "audit", "a-2");
    const g3 = streamGenesis(SECRET, "other", "audit", "a-1");
    expect(hashesEqual(g1, g2)).toBe(false);
    expect(hashesEqual(g1, g3)).toBe(false);
  });

  it("stream and anchor genesis differ for the same tenant", () => {
    expect(hashesEqual(
      streamGenesis(SECRET, "acme", "audit", "a-1"),
      anchorGenesis(SECRET, "acme"),
    )).toBe(false);
  });
});

describe("computeAnchorHash", () => {
  const m = (aggregateId: string, version: number, fill: number) => ({
    aggregateName: "audit", aggregateId, version, headHash: Buffer.alloc(32, fill),
  });

  it("is order-sensitive over the member set", () => {
    const prev = anchorGenesis(SECRET, "acme");
    expect(hashesEqual(
      computeAnchorHash(SECRET, prev, [m("a", 1, 1), m("b", 1, 2)]),
      computeAnchorHash(SECRET, prev, [m("b", 1, 2), m("a", 1, 1)]),
    )).toBe(false);
  });

  it("is deterministic for the same members and prev", () => {
    const prev = anchorGenesis(SECRET, "acme");
    const members = [m("a", 3, 7), m("b", 5, 9)];
    expect(hashesEqual(
      computeAnchorHash(SECRET, prev, members),
      computeAnchorHash(SECRET, prev, members),
    )).toBe(true);
  });

  it("changes when a member's sealed version or head changes", () => {
    const prev = anchorGenesis(SECRET, "acme");
    const base = computeAnchorHash(SECRET, prev, [m("a", 3, 7)]);
    expect(hashesEqual(base, computeAnchorHash(SECRET, prev, [m("a", 4, 7)]))).toBe(false);
    expect(hashesEqual(base, computeAnchorHash(SECRET, prev, [m("a", 3, 8)]))).toBe(false);
  });

  it("changes when a member is added (whole-stream coverage)", () => {
    const prev = anchorGenesis(SECRET, "acme");
    expect(hashesEqual(
      computeAnchorHash(SECRET, prev, [m("a", 3, 7)]),
      computeAnchorHash(SECRET, prev, [m("a", 3, 7), m("b", 1, 2)]),
    )).toBe(false);
  });
});

describe("hashesEqual", () => {
  it("returns false for null/length mismatch and true for identical buffers", () => {
    expect(hashesEqual(null, Buffer.alloc(32))).toBe(false);
    expect(hashesEqual(Buffer.alloc(16), Buffer.alloc(32))).toBe(false);
    expect(hashesEqual(Buffer.alloc(32, 5), Buffer.alloc(32, 5))).toBe(true);
  });
});
