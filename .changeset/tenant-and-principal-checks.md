---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
"@eventfabric/mediator": patch
"@eventfabric/mediator-postgres": patch
---

Tighten tenant and caller checks.

- **Command bus (mediator):** a command whose `metadata.tenantId` would switch the transaction to another tenant is rejected with `UnvalidatedTenantError` unless the bus has a `tenantValidator` or the new `trustTenantMetadata: true`. The bus used to follow the metadata unchecked. Single-tenant setups are not affected. A multi-tenant bus that a saga dispatcher sends to needs one of the two.
- **Idempotency (mediator, mediator-postgres):** the principal that first used a key is stored (migration `020_command_principal` adds `command_idempotency.principal_id`). The same key from a different principal throws `IdempotencyKeyConflictError` with `reason: "principal"` instead of returning the first caller's result. Run `migrate()` before the new version handles commands.
- **`loadGlobal` (core, postgres):** without `tenantId` it returns the transaction's tenant only. Cross-tenant reads need `allTenants: true`.
