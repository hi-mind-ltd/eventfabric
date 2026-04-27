---
"@eventfabric/core": patch
"@eventfabric/opentelemetry": patch
"@eventfabric/postgres": patch
---

**Fix:** export `InlineProjection` interface from `@eventfabric/core`.

The interface was defined but never re-exported from the package barrel, so consumers couldn't import it to type their own inline projections. Also renamed the source file from `inline-protection.ts` to `inline-projection.ts` to fix the typo.
