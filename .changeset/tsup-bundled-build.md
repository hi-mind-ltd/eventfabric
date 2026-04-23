---
"@eventfabric/core": patch
"@eventfabric/postgres": patch
"@eventfabric/opentelemetry": patch
---

**Fix:** switch each package's `build` from raw `tsc` to `tsup`, producing a single bundled `dist/index.js` plus a single `dist/index.d.ts`.

The previous build emitted extensionless re-exports in the published `dist/` (e.g. `export * from './types'`), which are not resolvable by Node's strict ESM loader or by TypeScript consumers using `moduleResolution: "nodenext"`. Affected consumers saw errors like `Cannot find module '.../dist/types' imported from .../dist/index.js` at runtime and `has no exported member 'HandlerMap'` at compile time.

Bundling with tsup eliminates the internal re-export chain entirely — each package ships one ESM module with one types file — so consumers load it cleanly regardless of their module resolution strategy, and the published artifact is a few KB smaller. Source is unchanged; `typecheck` still runs against `tsc` for full type coverage.

No API changes.
