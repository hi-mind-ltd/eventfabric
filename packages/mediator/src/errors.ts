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
 * Thrown by idempotency middleware when an idempotency key that already
 * completed is reused for a different command: another command type, or
 * the same type with a different payload. Returning the stored result would
 * report success for a command that never ran.
 */
export class IdempotencyKeyConflictError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly commandType: string,
    public readonly originalCommandType: string,
    /** What differed: the command type, the payload, or the principal sending it. */
    public readonly reason: "command-type" | "payload" | "principal" = "command-type"
  ) {
    super(
      reason === "principal"
        ? `Idempotency key ${idempotencyKey} was already used by a different principal; ` +
          `a stored result is only returned to the principal that first sent the command`
        : reason === "payload"
        ? `Idempotency key ${idempotencyKey} was already used for a "${commandType}" command with a ` +
          `different payload; use a new key for a new request`
        : `Idempotency key ${idempotencyKey} was already used for a "${originalCommandType}" command; ` +
          `it cannot be reused for "${commandType}"`
    );
    this.name = "IdempotencyKeyConflictError";
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

/**
 * Thrown by the bus when a command's `metadata.tenantId` would switch the
 * transaction to another tenant and the bus was given neither a
 * `tenantValidator` nor `trustTenantMetadata: true`. The bus routes by that
 * field, so somebody has to vouch for it: a validator that compares it with
 * the authenticated caller, or an explicit statement that every sender is
 * trusted.
 */
export class UnvalidatedTenantError extends Error {
  constructor(public readonly commandType: string, public readonly tenantId: string) {
    super(
      `Command "${commandType}" targets tenant "${tenantId}", but the bus has no tenantValidator. ` +
        `Pass tenantValidator to check the tenant against the authenticated caller, or ` +
        `trustTenantMetadata: true if every sender of commands is trusted.`
    );
    this.name = "UnvalidatedTenantError";
  }
}
