/**
 * Metadata carried by every command.
 *
 * `commandId` and `idempotencyKey` are required: the bus uses `commandId` as
 * the `causationId` stamped on emitted events, and `idempotencyKey` as the
 * dedup slot in the idempotency store. Callers that don't care about
 * client-supplied dedup can set `idempotencyKey` equal to `commandId` for
 * a per-command-instance unique key (no dedup ever fires).
 */
export interface CommandMetadata {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly issuedAt: string;
  readonly tenantId?: string;
  readonly principalId?: string;
}

/**
 * Envelope for a single command.
 *
 * Mirrors the shape of `EventEnvelope<E>` so operators only learn one
 * mental model. `version` is reserved for command schema evolution; it is
 * not yet consumed by the bus but should be set to 1 by callers today.
 */
export interface Command<TPayload = unknown> {
  readonly type: string;
  readonly version: number;
  readonly payload: TPayload;
  readonly metadata: CommandMetadata;
}
