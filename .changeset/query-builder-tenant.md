---
"@eventfabric/postgres": patch
---

Query builder: new `tenantId` option (and `tenantColumn`, default `tenant_id`) restricts every query from a builder to one tenant. The condition is put in front of the other conditions, which are grouped so an `orWhere` can't widen it. The builder has no tenant filter otherwise, including on `eventfabric.snapshots`; the multi-tenancy docs now list every API that is not filtered by tenant and no longer take the tenant from a request header.
