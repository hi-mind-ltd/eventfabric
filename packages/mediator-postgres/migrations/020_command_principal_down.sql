-- Down migration for 020_command_principal.sql. Apply manually via psql.

ALTER TABLE eventfabric.command_idempotency
  DROP COLUMN IF EXISTS principal_id;

DELETE FROM eventfabric.schema_migrations WHERE name = '020_command_principal';
