import type { Transaction } from "@eventfabric/core";
import type { Command } from "@eventfabric/mediator";
import type {
  SagaCommandQueue,
  SagaCommandQueueItem,
} from "./saga-command-queue";

interface Row {
  id: string;
  tenantId: string;
  sagaName: string;
  instanceId: string;
  command: Command;
  attempts: number;
  status: "pending" | "claimed" | "dispatched";
  enqueuedAt: number;
  lastError?: string;
  causationEventId: string | null;
  nextAttemptAt: number | null;
}

/**
 * Process-local saga command queue. Test fixture and reference impl.
 */
export class InMemorySagaCommandQueue implements SagaCommandQueue<Transaction> {
  private readonly rows: Row[] = [];
  private nextId = 1;

  async enqueue(
    _tx: Transaction,
    params: {
      tenantId: string;
      sagaName: string;
      instanceId: string;
      command: Command;
      causationEventId?: string | null;
    }
  ): Promise<void> {
    this.rows.push({
      id: String(this.nextId++),
      tenantId: params.tenantId,
      sagaName: params.sagaName,
      instanceId: params.instanceId,
      command: structuredClone(params.command),
      attempts: 0,
      status: "pending",
      enqueuedAt: Date.now(),
      causationEventId: params.causationEventId ?? null,
      nextAttemptAt: null,
    });
  }

  async claimBatch(
    _tx: Transaction,
    params: { batchSize: number }
  ): Promise<SagaCommandQueueItem[]> {
    const now = Date.now();
    const claimed: SagaCommandQueueItem[] = [];
    for (const row of this.rows) {
      if (claimed.length >= params.batchSize) break;
      if (row.status !== "pending") continue;
      if (row.nextAttemptAt !== null && row.nextAttemptAt > now) continue;
      row.status = "claimed";
      row.attempts++;
      claimed.push({
        id: row.id,
        tenantId: row.tenantId,
        sagaName: row.sagaName,
        instanceId: row.instanceId,
        command: structuredClone(row.command),
        attempts: row.attempts,
        causationEventId: row.causationEventId,
      });
    }
    return claimed;
  }

  async ack(_tx: Transaction, params: { id: string }): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === params.id);
    if (idx >= 0) this.rows[idx]!.status = "dispatched";
  }

  async releaseWithError(
    _tx: Transaction,
    params: { id: string; error: Error; delayUntil?: Date }
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === params.id);
    if (row) {
      row.status = "pending";
      row.lastError = params.error.message;
      row.nextAttemptAt = params.delayUntil ? params.delayUntil.getTime() : null;
    }
  }

  /** Test-only: snapshot of pending rows in enqueue order. */
  pendingRows(): Pick<Row, "id" | "sagaName" | "instanceId" | "command" | "attempts">[] {
    return this.rows
      .filter((r) => r.status === "pending")
      .map((r) => ({
        id: r.id,
        sagaName: r.sagaName,
        instanceId: r.instanceId,
        command: structuredClone(r.command),
        attempts: r.attempts,
      }));
  }

  clear(): void {
    this.rows.length = 0;
    this.nextId = 1;
  }
}
