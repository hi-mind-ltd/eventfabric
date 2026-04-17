import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

export type TenantPluginOptions = {
  /** Incoming header name. Defaults to `x-tenant-id`. */
  header?: string;
  /**
   * Allowlist of tenant IDs. If set, requests with an unknown tenant ID
   * get a 403 before hitting any route. Pass `undefined` to disable the check
   * (dev-mode / tests can accept any tenant).
   */
  allowedTenants?: ReadonlySet<string>;
  /**
   * Routes whose path starts with any of these prefixes skip tenant
   * resolution entirely — useful for `/health`, `/metrics`, etc.
   */
  skipPrefixes?: readonly string[];
};

/**
 * Fastify plugin: extracts the tenant id from a request header and attaches
 * it to `request.tenantId`. Handlers downstream pass this to
 * `sessionFactory.createSession(request.tenantId)` so every database
 * operation is scoped to that tenant.
 *
 * Registered as a root-level hook (not a `fastify-plugin`) so the decorator
 * is visible to every route. Keep it registered *before* any route.
 */
export function registerTenantPlugin(app: FastifyInstance, opts: TenantPluginOptions = {}): void {
  const header = (opts.header ?? "x-tenant-id").toLowerCase();
  const allowed = opts.allowedTenants;
  const skip = opts.skipPrefixes ?? [];

  app.decorateRequest("tenantId", "");

  app.addHook("onRequest", async (req, reply) => {
    if (skip.some((p) => req.url.startsWith(p))) {
      return;
    }

    const raw = req.headers[header];
    const tenantId = typeof raw === "string" ? raw.trim() : "";

    if (!tenantId) {
      return reply.code(400).send({
        error: "tenant_id_missing",
        message: `Missing required ${header} header`
      });
    }

    if (allowed && !allowed.has(tenantId)) {
      return reply.code(403).send({
        error: "tenant_not_allowed",
        message: `Tenant ${tenantId} is not permitted`
      });
    }

    req.tenantId = tenantId;
  });
}

export function getTenantId(req: FastifyRequest): string {
  if (!req.tenantId) {
    throw new Error("tenantId missing — was registerTenantPlugin() registered before routes?");
  }
  return req.tenantId;
}
