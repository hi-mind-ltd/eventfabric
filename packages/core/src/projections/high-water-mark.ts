/**
 * Reports the event-log "high water mark": the highest global position at or
 * below which every event is final, meaning it is either committed and
 * visible, or it will never become visible (its transaction rolled back).
 *
 * Why it is needed: global positions are allocated when an event is
 * inserted, not when its transaction commits. A reader that simply takes
 * "everything after my checkpoint" can see position 102 commit while 101 is
 * still in flight, advance its checkpoint to 102, and never read 101. Reading
 * only up to the high water mark closes that hole: the mark does not move
 * past a position that an in-flight transaction might still commit.
 *
 * Implementations are backend specific (see `PgHighWaterMark`). Backends
 * that assign positions in commit order can return the current maximum.
 */
export interface HighWaterMark {
  /**
   * Return the current safe upper bound (inclusive).
   *
   * @param opts.waitMs - How long to wait for transactions that are in
   *   flight right now to finish, so the bound can cover everything already
   *   committed. 0 returns immediately with whatever is known to be safe.
   * @param opts.signal - Abort the wait early.
   */
  safePosition(opts?: { waitMs?: number; signal?: AbortSignal }): Promise<bigint>;
}
