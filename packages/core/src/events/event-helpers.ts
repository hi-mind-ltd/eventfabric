/**
 * Event metadata definition. Use this to define the type and version of an event.
 * The type and version are automatically populated when creating events.
 * 
 * @example
 * ```ts
 * const UserRegistered = defineEvent("UserRegistered", 1);
 * 
 * // Then create events with only the event-specific fields:
 * const event = UserRegistered.create<UserRegistered>({ 
 *   email: "test@example.com",
 *   displayName: "John Doe",
 *   userId: "user-1"
 * });
 * ```
 */
export function defineEvent<T extends string, V extends number>(
  type: T,
  version: V
) {
  return {
    type,
    version,
    /**
     * Creates an event instance with the specified type and version automatically populated.
     * You only need to provide the event-specific fields (excluding type and version).
     * 
     * @example
     * ```ts
     * const UserRegistered = defineEvent("UserRegistered", 1);
     * 
     * // ✅ Correct usage - only provide event-specific fields:
     * const event = UserRegistered.create<UserRegistered>({ 
     *   email: "test@example.com",
     *   displayName: "John Doe",
     *   userId: "user-1"
     * });
     * // event.type is automatically "UserRegistered"
     * // event.version is automatically 1
     * ```
     */
    create: <E extends { type: T; version: V }>(
      data: Omit<E, "type" | "version">
    ): E => ({
      type: type as T,
      version: version as V,
      ...data,
    } as E),
  };
}

/**
 * Legacy helper function for creating events (deprecated - use defineEvent instead).
 * 
 * @deprecated Use `defineEvent()` instead for better type safety and automatic type/version population.
 */
export function createEvent<E extends { type: string; version: number }>(
  event: E
): E {
  return event;
}

