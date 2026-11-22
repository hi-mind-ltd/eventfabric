import type { Pool } from "pg";
import type { HighWaterMark } from "@eventfabric/core";
import { sleep } from "@eventfabric/core";

export type PgHighWaterMarkOptions = {
  /** Schema-qualified events table. Default: "eventfabric.events". */
  eventsTable?: string;
  /** Delay between samples while waiting. Default: 25 ms. */
  pollMs?: number;
  /**
   * Escape hatch for a long-running write transaction that holds the mark
   * back. When set, a position that has been waiting for longer than this
   * is treated as safe even though a transaction that was in flight when
   * it was sampled is still open. Any event that transaction later commits
   * at or below that position will NOT be projected.
   *
   * Default: undefined — never skip past a live transaction (the mark just
   * waits, the same as Marten's default).
   */
  skipLiveTransactionsAfterMs?: number;
};

type Sample = { maxPosition: bigint; xmax: bigint; at: number };

/** Upper bound on remembered samples while the mark is held back. */
const MAX_PENDING = 10_000;

/**
 * PostgreSQL high water mark based on transaction snapshots.
 *
 * Each sample reads, in one statement (so from one MVCC snapshot):
 *   - M: the highest visible global_position, and
 *   - xmax: the snapshot's xmax — every transaction id below it was either
 *     finished or in progress when the snapshot was taken.
 *
 * Any position <= M that was not yet visible was allocated before M, by a
 * transaction that was in progress at that moment (an appending transaction
 * always has a transaction id before it allocates a position, because
 * `PgEventStore.append` writes `stream_versions` first). Once the oldest
 * running transaction is at or past the sample's xmax, every such
 * transaction has committed or rolled back, so every position <= M is final
 * and M becomes the safe mark. When nothing is in flight (xmin = xmax) the
 * sample is safe immediately.
 *
 * Gaps from rolled-back transactions need no special handling: they simply
 * never appear, and the mark moves past them like any other position.
 *
 * Requires PostgreSQL 13+ (pg_current_snapshot / xid8).
 *
 * The mark is tracked in memory per instance. A new instance starts at 0
 * and catches up after its first sample settles.
 */
export class PgHighWaterMark implements HighWaterMark {
  private readonly eventsTable: string;
  private readonly pollMs: number;
  private readonly skipAfterMs: number | undefined;
  private safe = 0n;
  private pending: Sample[] = [];

  constructor(
    private readonly pool: Pool,
    opts: PgHighWaterMarkOptions = {}
  ) {
    this.eventsTable = opts.eventsTable ?? "eventfabric.events";
    this.pollMs = opts.pollMs ?? 25;
    this.skipAfterMs = opts.skipLiveTransactionsAfterMs;
  }

  async safePosition(opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<bigint> {
    const deadline = Date.now() + (opts.waitMs ?? 0);
    let target: bigint | undefined;

    for (;;) {
      const s = await this.sample();
      target ??= s.maxPosition;
      this.record(s);
      this.promote(s.xmin);

      if (this.safe >= target || Date.now() >= deadline || opts.signal?.aborted) return this.safe;
      try {
        await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())), opts.signal);
      } catch {
        return this.safe; // aborted
      }
    }
  }

  private async sample(): Promise<{ maxPosition: bigint; xmin: bigint; xmax: bigint }> {
    // One statement => one snapshot for both the max position and xmin/xmax.
    const res = await this.pool.query(
      `SELECT (SELECT COALESCE(MAX(global_position), 0) FROM ${this.eventsTable})::text AS max_position,
              pg_snapshot_xmin(s)::text AS xmin,
              pg_snapshot_xmax(s)::text AS xmax
       FROM pg_current_snapshot() AS s`
    );
    const r = res.rows[0];
    return { maxPosition: BigInt(r.max_position), xmin: BigInt(r.xmin), xmax: BigInt(r.xmax) };
  }

  private record(s: { maxPosition: bigint; xmax: bigint }): void {
    if (s.maxPosition <= this.safe) return;
    const last = this.pending[this.pending.length - 1];
    if (last && last.maxPosition >= s.maxPosition) return; // already waiting on this position
    const entry: Sample = { maxPosition: s.maxPosition, xmax: s.xmax, at: Date.now() };
    if (this.pending.length >= MAX_PENDING) {
      // Replace the newest entry: its successor has a higher position and a
      // later xmax, so it only becomes safe later. Conservative, never unsafe.
      this.pending[this.pending.length - 1] = entry;
    } else {
      this.pending.push(entry);
    }
  }

  private promote(currentXmin: bigint): void {
    const now = Date.now();
    let i = 0;
    for (; i < this.pending.length; i++) {
      const p = this.pending[i]!;
      const settled = currentXmin >= p.xmax;
      const forced = this.skipAfterMs !== undefined && now - p.at >= this.skipAfterMs;
      if (!settled && !forced) break;
      if (p.maxPosition > this.safe) this.safe = p.maxPosition;
    }
    // Samples are recorded in increasing xmax order, so a settled sample
    // implies every earlier one settled too; stop at the first unsettled.
    if (i > 0) this.pending = this.pending.slice(i);
  }
}
