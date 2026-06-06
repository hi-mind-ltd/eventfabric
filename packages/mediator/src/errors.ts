/**
 * Thrown by validation middleware when payload validation fails. The bus
 * does not retry on this — it's a deterministic client error.
 */
export class CommandValidationError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
    this.name = "CommandValidationError";
  }
}

/**
 * Thrown by auth middleware when the principal is not allowed to issue
 * this command type or this specific payload.
 */
export class CommandUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandUnauthorizedError";
  }
}

/**
 * Thrown by idempotency middleware when another worker holds the slot for
 * this idempotency key and the bus is configured to reject-immediately
 * rather than wait-and-retry.
 */
export class ConcurrentCommandInFlightError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Command with idempotency key ${idempotencyKey} is already in flight`);
    this.name = "ConcurrentCommandInFlightError";
  }
}

/**
 * Thrown when bus.send is called for a command type that has no
 * registered handler.
 */
export class NoHandlerRegisteredError extends Error {
  constructor(public readonly commandType: string) {
    super(`No handler registered for command type "${commandType}"`);
    this.name = "NoHandlerRegisteredError";
  }
}

/**
 * Thrown by the bus when `requireTenantId: true` and a command arrives
 * without `metadata.tenantId`. Indicates application code forgot to
 * stamp the authenticated tenant onto the command before send().
 */
export class MissingTenantIdError extends Error {
  constructor(public readonly commandType: string) {
    super(
      `Command "${commandType}" arrived without metadata.tenantId; bus is configured with requireTenantId=true`
    );
    this.name = "MissingTenantIdError";
  }
}
