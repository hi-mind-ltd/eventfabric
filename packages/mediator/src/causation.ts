import type { Transaction } from "@eventfabric/core";
import type { CommandContext } from "./command-handler";

/**
 * Builds the event metadata to stamp on events emitted from inside a
 * command handler.
 *
 * Conventions:
 *   - `causationId` is always the command's `commandId`. Every event
 *     emitted by a command points back to the command that caused it.
 *   - `correlationId` falls back to the command's `commandId` when the
 *     command itself wasn't part of an existing correlation chain. This
 *     way the very first command in a flow seeds its own correlation,
 *     and later commands (issued by sagas, retries, etc.) inherit the
 *     incoming correlationId.
 *
 * Pass the result to `session.saveChangesAsync({ meta })` or to
 * `repository.save(agg, { meta })`.
 */
export function commandContextToEventMeta<TTx extends Transaction>(
  ctx: CommandContext<TTx>
): { correlationId: string; causationId: string } {
  return {
    correlationId: ctx.metadata.correlationId ?? ctx.metadata.commandId,
    causationId: ctx.metadata.commandId,
  };
}
