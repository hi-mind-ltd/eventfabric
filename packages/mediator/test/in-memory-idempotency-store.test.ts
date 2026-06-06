import { describe, it, expect } from "vitest";
import { InMemoryIdempotencyStore } from "../src/in-memory-idempotency-store";

describe("InMemoryIdempotencyStore", () => {
  const tx = {} as const;

  it("first claim wins, returns claimed", async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await store.claim(tx, { key: "k1", commandType: "X", commandId: "c1" });
    expect(result).toEqual({ state: "claimed" });
  });

  it("second claim while in-flight returns in_flight", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim(tx, { key: "k1", commandType: "X", commandId: "c1" });
    const second = await store.claim(tx, { key: "k1", commandType: "X", commandId: "c2" });
    expect(second).toEqual({ state: "in_flight" });
  });

  it("after complete, claim returns completed with stored result", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim(tx, { key: "k1", commandType: "X", commandId: "c1" });
    await store.complete(tx, { key: "k1", result: { ok: true } });
    const second = await store.claim(tx, { key: "k1", commandType: "X", commandId: "c2" });
    expect(second).toEqual({ state: "completed", result: { ok: true } });
  });

  it("release clears the slot, next claim wins", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim(tx, { key: "k1", commandType: "X", commandId: "c1" });
    await store.release(tx, { key: "k1", error: new Error("boom") });
    const second = await store.claim(tx, { key: "k1", commandType: "X", commandId: "c2" });
    expect(second).toEqual({ state: "claimed" });
  });

  it("scopes slots per tenant — same key in different tenants does not collide", async () => {
    const store = new InMemoryIdempotencyStore();
    const a = await store.claim(tx, { key: "k1", commandType: "X", commandId: "c1", tenantId: "acme" });
    const b = await store.claim(tx, { key: "k1", commandType: "X", commandId: "c2", tenantId: "contoso" });
    expect(a).toEqual({ state: "claimed" });
    expect(b).toEqual({ state: "claimed" });
  });

  it("clear() drops all slots", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim(tx, { key: "k1", commandType: "X", commandId: "c1" });
    store.clear();
    const after = await store.claim(tx, { key: "k1", commandType: "X", commandId: "c2" });
    expect(after).toEqual({ state: "claimed" });
  });
});
