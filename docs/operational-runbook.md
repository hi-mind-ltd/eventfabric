# Operational Runbook

## What to monitor
- Outbox backlog (`totalPending`, `oldestAgeSeconds`)
- Projection checkpoint lag (tip - checkpoint)
- DLQ size and top errors

## DLQ actions
- Inspect dead letters
- Requeue by DLQ id or global position
- Purge if the event is permanently bad and your business can tolerate skipping
