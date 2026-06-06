import type { Transaction } from "@eventfabric/core";
import type { Command, CommandMetadata } from "./command";

/**
 * Per-invocation context handed to a command handler. `tx` is the open
 * transaction that the bus has already started; the handler should use it
 * to construct a Session, call Repository.save, etc., so the handler's
 * effects commit atomically with the idempotency record.
 */
export interface CommandContext<TTx extends Transaction = Transaction> {
  readonly tx: TTx;
  readonly metadata: CommandMetadata;
}

export interface CommandHandler<
  TCmd extends Command,
  TResult,
  TTx extends Transaction = Transaction
> {
  readonly commandType: TCmd["type"];
  handle(cmd: TCmd, ctx: CommandContext<TTx>): Promise<TResult>;
}

/**
 * Per-handler registration options.
 *
 * `idempotency: "off"` disables the idempotency middleware for this
 * specific handler — used for commands that legitimately must run on every
 * call (e.g. RotateApiKey, RecordAuditPing). The default is "required":
 * every command must carry an idempotencyKey and the slot is enforced.
 */
export interface HandlerRegistrationOptions {
  readonly idempotency?: "required" | "off";
}
