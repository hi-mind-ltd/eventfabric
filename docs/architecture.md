# Architecture

## Core ideas
- Events are strongly typed (`type` + `version`) and stored append-only.
- Aggregate streams are identified by `(aggregate_name, aggregate_id)`.
- Each append is concurrency-checked via `expectedAggregateVersion`.
- Postgres adapter assigns a monotonic `global_position` for total ordering.

## Projections
- Inline projections run in the same DB transaction as the append.
- Async projections run from an outbox table, with SKIP LOCKED claiming.

## Snapshots
- Latest-only snapshot row per aggregate stream.
- Snapshot schema versioning + upcasting supported.
