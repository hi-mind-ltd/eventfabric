import type { AnyEvent, Transaction } from "../types";

/** Outcome of verifying one stream's tamper-evidence hash chain. */
export type ChainVerificationResult = {
  ok: boolean;
  tenantId: string;
  aggregateName: string;
  aggregateId: string;
  /** Number of protected (chained) events checked. */
  eventsChecked: number;
  /** The aggregate_version at which the chain first broke, or null when ok. */
  firstBrokenAt: number | null;
  /** Human-readable cause when `ok` is false. */
  reason?: string;
};

/**
 * Optional capability an {@link EventStore} implementation can expose when it
 * supports tamper-evident hash chaining. Kept separate from the base
 * `EventStore` so stores that don't chain aren't forced to implement it, and so
 * application code (or a future non-Postgres backend) can depend on the
 * verification contract rather than a concrete adapter.
 *
 * Enable chaining per aggregate type (e.g. a `static tamperEvident = true` on
 * the aggregate, honored at registration) and configure the HMAC secret on the
 * adapter. The chain *format* is defined by the shared primitives in
 * `@eventfabric/core` (canonicalJson / computeEventHash / genesis), so chains
 * are comparable across implementations.
 */
export interface TamperEvidentEventStore<E extends AnyEvent, TTx extends Transaction = Transaction> {
  /**
   * Walk one stream's hash chain and report whether it is intact. Detects
   * payload/metadata mutation, event removal, and tail truncation. Reads the
   * raw stored payload (not upcasted) since the hash is over stored bytes.
   */
  verifyStream(
    tx: TTx,
    params: { aggregateName: string; aggregateId: string }
  ): Promise<ChainVerificationResult>;

  /**
   * Verify every stream of the given aggregate for the transaction's tenant.
   * One result per stream; callers typically filter on `!r.ok`.
   */
  verifyAggregate(
    tx: TTx,
    params: { aggregateName: string }
  ): Promise<ChainVerificationResult[]>;
}
