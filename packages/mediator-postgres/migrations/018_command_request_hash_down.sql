-- Down migration for 018_command_request_hash.sql. Apply manually via psql.

ALTER TABLE eventfabric.command_idempotency
  DROP COLUMN IF EXISTS request_hash;

DELETE FROM eventfabric.schema_migrations WHERE name = '018_command_request_hash';
