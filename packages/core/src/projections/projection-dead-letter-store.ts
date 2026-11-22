import type { Transaction } from "../types";

/**
 * An event a projection failed to handle `maxAttempts` times. The projection
 * daemon records it here and moves the projection's checkpoint past it, so
 * one poison event does not block the projection for that tenant.
 */
export type ProjectionDeadLetter = {
  id: string | number;
  projectionName: string;
  tenantId: string;
  globalPosition: bigint;
  eventId: string;
  eventType: string;
  attempts: number;
  lastError: string | null;
  deadLetteredAt: string;
};

export type NewProjectionDeadLetter = Omit<ProjectionDeadLetter, "id" | "deadLetteredAt">;

export type ListProjectionDeadLettersOptions = {
  projectionName?: string;
  tenantId?: string;
  limit?: number;
  offset?: number;
};

/**
 * Storage for projection dead letters. Operations are cross-tenant (admin
 * scope): filter by `tenantId` explicitly where needed.
 */
export interface ProjectionDeadLetterStore<TTx extends Transaction = Transaction> {
  /** Record a dead letter. Re-recording the same (projection, tenant, position) updates it. */
  add(tx: TTx, item: NewProjectionDeadLetter): Promise<void>;
  get(tx: TTx, id: ProjectionDeadLetter["id"]): Promise<ProjectionDeadLetter | null>;
  /** Oldest first. */
  list(tx: TTx, opts?: ListProjectionDeadLettersOptions): Promise<ProjectionDeadLetter[]>;
  delete(tx: TTx, id: ProjectionDeadLetter["id"]): Promise<void>;
  /** Delete a projection's dead letters (optionally for one tenant). Returns the number deleted. */
  purge(tx: TTx, opts: { projectionName: string; tenantId?: string }): Promise<number>;
}
