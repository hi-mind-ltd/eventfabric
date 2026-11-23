export type SnapshotPolicy = { everyNEvents: number };

/**
 * True when a save that moved a stream from `fromVersion` to `toVersion`
 * reached or passed a multiple of `everyNEvents`. Checking only
 * `toVersion % everyNEvents === 0` misses saves that write several events
 * and jump over the multiple (e.g. 4 → 7 with N = 5).
 */
export function shouldSnapshot(policy: SnapshotPolicy, fromVersion: number, toVersion: number): boolean {
  const n = policy.everyNEvents;
  if (!(n > 0)) return false;
  return Math.floor(toVersion / n) > Math.floor(fromVersion / n);
}
