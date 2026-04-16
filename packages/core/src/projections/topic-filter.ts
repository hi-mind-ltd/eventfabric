/**
 * Topic filter for routing messages to projections.
 * Used by async projection runners to determine which projections should process which messages.
 */
export type TopicFilter =
  | { mode: "all" }
  | { mode: "include"; topics: string[] }
  | { mode: "exclude"; topics: string[] };

/**
 * Checks if a topic matches the given filter.
 * 
 * @param filter - The topic filter to apply
 * @param topic - The topic to check (can be null)
 * @returns True if the topic matches the filter
 */
export function matchesTopic(filter: TopicFilter | undefined, topic: string | null): boolean {
  const f = filter ?? { mode: "all" as const };
  if (f.mode === "all") return true;
  const t = topic ?? "";
  if (f.mode === "include") return f.topics.includes(t);
  return !f.topics.includes(t);
}
