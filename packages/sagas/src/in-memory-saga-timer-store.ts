import type { Transaction } from "@eventfabric/core";
import type { TimerMessage } from "./saga";
import type { SagaTimerStore, SagaTimerStoreItem } from "./saga-timer-store";

interface Row {
  tenantId: string;
  sagaName: string;
  instanceId: string;
  id: string;
  fireAt: Date;
  message: TimerMessage;
  status: "pending" | "claimed" | "fired" | "cancelled";
}

/**
 * Process-local timer store. Test fixture and reference impl. The PG
 * version supports SKIP LOCKED multi-worker dispatch; this one is
 * single-worker but has the same semantics.
 */
export class InMemorySagaTimerStore implements SagaTimerStore<Transaction> {
  private readonly rows: Row[] = [];

  private match(
    row: Row,
    params: { tenantId: string; sagaName: string; instanceId: string; id?: string }
  ): boolean {
    if (row.tenantId !== params.tenantId) return false;
    if (row.sagaName !== params.sagaName) return false;
    if (row.instanceId !== params.instanceId) return false;
    if (params.id !== undefined && row.id !== params.id) return false;
    return true;
  }

  async schedule(
    _tx: Transaction,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
      fireAt: Date;
      message: TimerMessage;
    }
  ): Promise<void> {
    // Replace any existing pending row with the same key — re-scheduling
    // an id is the documented way to update fireAt or payload.
    const existing = this.rows.find(
      (r) => this.match(r, params) && r.status === "pending"
    );
    if (existing) {
      existing.fireAt = new Date(params.fireAt);
      existing.message = structuredClone(params.message);
      return;
    }
    this.rows.push({
      tenantId: params.tenantId,
      sagaName: params.sagaName,
      instanceId: params.instanceId,
      id: params.id,
      fireAt: new Date(params.fireAt),
      message: structuredClone(params.message),
      status: "pending",
    });
  }

  async cancel(
    _tx: Transaction,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      ids: readonly string[];
    }
  ): Promise<number> {
    let cancelled = 0;
    for (const row of this.rows) {
      if (row.status !== "pending" && row.status !== "claimed") continue;
      if (!this.match(row, params)) continue;
      if (!params.ids.includes(row.id)) continue;
      row.status = "cancelled";
      cancelled++;
    }
    return cancelled;
  }

  async claimDue(
    _tx: Transaction,
    params: { now: Date; batchSize: number }
  ): Promise<SagaTimerStoreItem[]> {
    const claimed: SagaTimerStoreItem[] = [];
    const sorted = [...this.rows]
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.status === "pending" && r.fireAt.getTime() <= params.now.getTime())
      .sort((a, b) => a.r.fireAt.getTime() - b.r.fireAt.getTime());

    for (const { r } of sorted) {
      if (claimed.length >= params.batchSize) break;
      r.status = "claimed";
      claimed.push({
        tenantId: r.tenantId,
        sagaName: r.sagaName,
        instanceId: r.instanceId,
        id: r.id,
        fireAt: new Date(r.fireAt),
        message: structuredClone(r.message),
      });
    }
    return claimed;
  }

  async markFired(
    _tx: Transaction,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
    }
  ): Promise<void> {
    const row = this.rows.find(
      (r) => this.match(r, params) && r.status === "claimed"
    );
    if (row) row.status = "fired";
  }

  /**
   * Releases a claimed row back to pending. Used by the scheduler when
   * delivery to the saga reports a CAS miss — the timer should be tried
   * again on the next round.
   */
  async release(
    _tx: Transaction,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      id: string;
    }
  ): Promise<void> {
    const row = this.rows.find(
      (r) => this.match(r, params) && r.status === "claimed"
    );
    if (row) row.status = "pending";
  }

  /** Test-only. */
  pendingTimers(): Pick<Row, "tenantId" | "sagaName" | "instanceId" | "id" | "fireAt">[] {
    return this.rows
      .filter((r) => r.status === "pending")
      .map((r) => ({
        tenantId: r.tenantId,
        sagaName: r.sagaName,
        instanceId: r.instanceId,
        id: r.id,
        fireAt: new Date(r.fireAt),
      }));
  }

  clear(): void {
    this.rows.length = 0;
  }
}
