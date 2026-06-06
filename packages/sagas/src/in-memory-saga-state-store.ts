import type { Transaction } from "@eventfabric/core";
import type { SagaInstance } from "./saga";
import type { SagaStateStore } from "./saga-state-store";

/**
 * Process-local saga state store. Test fixture and reference impl —
 * production deployments use the postgres-backed store.
 */
export class InMemorySagaStateStore<TState>
  implements SagaStateStore<TState, Transaction>
{
  private readonly instances = new Map<string, SagaInstance<TState>>();

  private key(sagaName: string, instanceId: string, tenantId: string): string {
    return `${tenantId}::${sagaName}::${instanceId}`;
  }

  async load(
    _tx: Transaction,
    params: { sagaName: string; instanceId: string; tenantId: string }
  ): Promise<SagaInstance<TState> | null> {
    const k = this.key(params.sagaName, params.instanceId, params.tenantId);
    const found = this.instances.get(k);
    return found ? structuredClone(found) : null;
  }

  async insert(_tx: Transaction, instance: SagaInstance<TState>): Promise<void> {
    const k = this.key(instance.sagaName, instance.instanceId, instance.tenantId);
    if (this.instances.has(k)) {
      throw new Error(
        `Saga instance ${instance.sagaName}:${instance.instanceId} (tenant ${instance.tenantId}) already exists`
      );
    }
    this.instances.set(k, structuredClone(instance));
  }

  async update(
    _tx: Transaction,
    instance: SagaInstance<TState>,
    expectedVersion: number
  ): Promise<boolean> {
    const k = this.key(instance.sagaName, instance.instanceId, instance.tenantId);
    const current = this.instances.get(k);
    if (!current) return false;
    if (current.stateVersion !== expectedVersion) return false;
    this.instances.set(k, structuredClone(instance));
    return true;
  }

  /** Test-only: list all instances regardless of status. */
  list(): SagaInstance<TState>[] {
    return [...this.instances.values()].map((v) => structuredClone(v));
  }

  /** Test-only: drop everything. */
  clear(): void {
    this.instances.clear();
  }
}
