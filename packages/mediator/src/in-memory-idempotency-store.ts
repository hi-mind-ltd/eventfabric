import type { Transaction } from "@eventfabric/core";
import type { ClaimResult, IdempotencyStore } from "./idempotency-store";

type Slot =
  | { status: "in_flight"; commandId: string; commandType: string; requestHash?: string }
  | { status: "completed"; result: unknown; commandType: string; requestHash?: string };

/**
 * Process-local idempotency store. Suitable for unit tests and single-process
 * deployments where the trade-off (lost state on restart) is acceptable.
 * Multi-process production deployments should use the postgres-backed store.
 *
 * The map is scoped per-tenant so the same idempotency key in different
 * tenants does not collide.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore<Transaction> {
  private readonly slots = new Map<string, Slot>();

  private slotKey(tenantId: string | undefined, key: string): string {
    return `${tenantId ?? "default"}::${key}`;
  }

  async claim(
    _tx: Transaction,
    params: { key: string; commandType: string; commandId: string; tenantId?: string; requestHash?: string }
  ): Promise<ClaimResult> {
    const slotKey = this.slotKey(params.tenantId, params.key);
    const existing = this.slots.get(slotKey);
    if (!existing) {
      this.slots.set(slotKey, {
        status: "in_flight",
        commandId: params.commandId,
        commandType: params.commandType,
        requestHash: params.requestHash,
      });
      return { state: "claimed" };
    }
    if (existing.status === "completed") {
      return {
        state: "completed",
        result: existing.result,
        commandType: existing.commandType,
        ...(existing.requestHash !== undefined ? { requestHash: existing.requestHash } : {}),
      };
    }
    return { state: "in_flight" };
  }

  async complete(
    _tx: Transaction,
    params: { key: string; tenantId?: string; result: unknown }
  ): Promise<void> {
    const slotKey = this.slotKey(params.tenantId, params.key);
    const prior = this.slots.get(slotKey);
    this.slots.set(slotKey, {
      status: "completed",
      result: params.result,
      commandType: prior?.commandType ?? "",
      requestHash: prior?.requestHash,
    });
  }

  async release(
    _tx: Transaction,
    params: { key: string; tenantId?: string; error: Error }
  ): Promise<void> {
    const slotKey = this.slotKey(params.tenantId, params.key);
    this.slots.delete(slotKey);
  }

  /** Test-only helper: drops all slots. */
  clear(): void {
    this.slots.clear();
  }
}
