import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { trace, metrics, type Tracer, type Meter } from "@opentelemetry/api";
import {
  PgEventStore,
  PgSnapshotStore,
  PgUnitOfWork,
  PgChainAnchorSealer,
  PgChainAnchorRunner,
  SessionFactory,
  ConjoinedTenantResolver,
  createAsyncProjectionRunner,
  createCatchUpProjector,
  migrate,
  type TenantResolver
} from "@eventfabric/postgres";
import { sleep } from "@eventfabric/core";
import { createAsyncRunnerObserver, createCatchUpObserver } from "@eventfabric/opentelemetry";

import type { InsuranceEvent } from "./domain/events";
import { PolicyholderAggregate, type PolicyholderState } from "./domain/policyholder.aggregate";
import { PolicyAggregate, type PolicyState } from "./domain/policy.aggregate";
import { ClaimAggregate, type ClaimState } from "./domain/claim.aggregate";
import { policyEventUpcaster } from "./domain/policy.upcasters";

import { insuranceNotificationProjection } from "./projections/notification-projection";
import { createClaimSettlementProjection } from "./projections/claim-settlement-projection";
import { premiumAuditProjection } from "./projections/premium-audit";

import { registerTenantPlugin } from "./plugins/tenant.plugin";
import { registerOtelPlugin } from "./plugins/otel.plugin";
import { registerPolicyholderRoutes } from "./routes/policyholder.routes";
import { registerPolicyRoutes } from "./routes/policy.routes";
import { registerClaimRoutes } from "./routes/claim.routes";

export type InsuranceAppOptions = {
  pool: Pool;
  /** Allowlist of permitted tenant IDs. Omit to accept any tenant id. */
  allowedTenants?: ReadonlySet<string>;
  /** OpenTelemetry tracer. Defaults to the registered global tracer. */
  tracer?: Tracer;
  /** OpenTelemetry meter. Defaults to the registered global meter. */
  meter?: Meter;
  /** Fastify logger setting. Defaults to false (quiet, good for tests). */
  logger?: boolean;
  /** HMAC secret for the tamper-evident claim ledger. Keep it out of source
   *  (env/KMS); a dev fallback is used if unset. */
  chainSecret?: string;
};

export type InsuranceApp = {
  app: FastifyInstance;
  sessionFactory: SessionFactory<InsuranceEvent>;
  store: PgEventStore<InsuranceEvent>;
  /** Tamper-evidence anchor sealer (per-tenant), exposed for ops + tests. */
  anchorSealer: PgChainAnchorSealer;
  tenantResolver: TenantResolver;
  /**
   * Start background projection workers (notifications outbox runner +
   * catch-up projector). Returns an `AbortController` so the caller can
   * stop workers cleanly on shutdown.
   */
  startWorkers(): { controller: AbortController; done: Promise<void> };
};

/**
 * Build a fully-wired insurance API instance.
 *
 * This is the composition root — all the moving parts (event store, session
 * factory, projections, OTel observers, Fastify plugins, routes) meet here.
 * Exposed as a function so integration tests can spin up a real instance
 * against a testcontainer without touching process.env or module-level state.
 */
export function buildInsuranceApp(opts: InsuranceAppOptions): InsuranceApp {
  const { pool } = opts;
  const tracer = opts.tracer ?? trace.getTracer("insurance-api");
  const meter = opts.meter ?? metrics.getMeter("insurance-api");

  // ---- Event store + session factory --------------------------------------
  // ConjoinedTenantResolver: all tenants share one database, isolation is
  // enforced by the `tenant_id` column. Every store operation scopes by
  // `tx.tenantId`, and `createSession(tenantId)` threads the header-derived
  // tenant through to that level.
  const tenantResolver = new ConjoinedTenantResolver(pool);
  // Tamper-evidence: ClaimAggregate declares `static tamperEvident = true`, so the
  // store it's registered against must carry the HMAC secret.
  const chainSecret = opts.chainSecret ?? "dev-insecure-secret-change-me";
  const store = new PgEventStore<InsuranceEvent>({
    upcaster: policyEventUpcaster,
    hashChain: { secret: chainSecret }
  });
  const anchorSealer = new PgChainAnchorSealer({ secret: chainSecret });

  const sessionFactory = new SessionFactory<InsuranceEvent>(tenantResolver, store);

  // Snapshot stores — per aggregate. Long-running policies can accumulate
  // hundreds of premium-paid events; snapshots keep load times bounded.
  const policyholderSnapshots = new PgSnapshotStore<PolicyholderState>();
  const policySnapshots = new PgSnapshotStore<PolicyState>();
  const claimSnapshots = new PgSnapshotStore<ClaimState>();

  sessionFactory.registerAggregate(PolicyholderAggregate, [
    "PolicyholderRegistered",
    "PolicyholderVerified",
    "PolicyholderContactUpdated",
    "PolicyholderSuspended"
  ], "policyholder", { snapshotStore: policyholderSnapshots, snapshotPolicy: { everyNEvents: 25 } });

  sessionFactory.registerAggregate(PolicyAggregate, [
    "PolicyIssued",
    "PremiumPaid",
    "PolicyRenewed",
    "PolicyCancelled",
    "PolicyExpired"
  ], "policy", { snapshotStore: policySnapshots, snapshotPolicy: { everyNEvents: 50 } });

  sessionFactory.registerAggregate(ClaimAggregate, [
    "ClaimSubmitted",
    "ClaimAssigned",
    "ClaimApproved",
    "ClaimDenied",
    "ClaimPaid"
  ], "claim", { snapshotStore: claimSnapshots, snapshotPolicy: { everyNEvents: 25 } });

  // ---- OpenTelemetry observers --------------------------------------------
  const asyncObserver = createAsyncRunnerObserver({ tracer, meter });
  const catchUpObserver = createCatchUpObserver({ tracer, meter });

  // ---- Fastify app --------------------------------------------------------
  const app = Fastify({ logger: opts.logger ?? false });

  // Plugin order matters — tenant first so the OTel preHandler can tag the
  // span with the resolved tenant id.
  registerTenantPlugin(app, {
    allowedTenants: opts.allowedTenants,
    skipPrefixes: ["/health"]
  });
  registerOtelPlugin(app, tracer);

  app.get("/health", async (_req, reply) => reply.send({ ok: true }));

  // Register route groups. Each group handles its own URL-space.
  app.register(async (scope) => {
    await registerPolicyholderRoutes(scope, { sessionFactory });
    await registerPolicyRoutes(scope, { sessionFactory, pool });
    await registerClaimRoutes(scope, { sessionFactory, store, pool });

    // Tamper-evidence anchor ops (per-tenant): force a seal, or verify the
    // anchor chain (catches whole-stream deletion / rollback of claims).
    scope.post("/ops/chain/seal", async (req, reply) => {
      const result = await new PgUnitOfWork(pool, req.tenantId).withTransaction((tx) => anchorSealer.seal(tx));
      return reply.send(result);
    });
    scope.get("/ops/chain/verify", async (req, reply) => {
      const result = await new PgUnitOfWork(pool, req.tenantId).withTransaction((tx) => anchorSealer.verifyAnchors(tx));
      return reply.code(result.ok ? 200 : 409).send(result);
    });
  });

  // ---- Background workers --------------------------------------------------
  function startWorkers(): { controller: AbortController; done: Promise<void> } {
    const controller = new AbortController();

    // Outbox runner for external notifications. Emails/SMS are side effects
    // on third-party systems — exactly the case the outbox pattern exists for
    // (at-least-once delivery with per-message retry + DLQ).
    const notificationRunner = createAsyncProjectionRunner(
      pool,
      store,
      [insuranceNotificationProjection],
      {
        workerId: "notification-worker-1",
        batchSize: 20,
        idleSleepMs: 500,
        maxAttempts: 5,
        transactionMode: "batch",
        backoff: { minMs: 100, maxMs: 5000, factor: 2, jitter: 0.1 },
        observer: asyncObserver
      }
    );

    // Catch-up projector for internal process managers: claim-settlement
    // advances approved claims to paid, premium-audit logs payments. Both
    // share one projector — each tracks its own checkpoint.
    const catchUpProjections = [
      createClaimSettlementProjection(store),
      premiumAuditProjection
    ];
    const catchUpProjector = createCatchUpProjector<InsuranceEvent>(pool, store);

    const runnerDone = notificationRunner.start(controller.signal).catch((err) => {
      console.error("Notification runner error:", err);
    });

    const catchUpDone = (async () => {
      const idleMs = 300;
      while (!controller.signal.aborted) {
        try {
          await catchUpProjector.catchUpAll(catchUpProjections, {
            batchSize: 100,
            observer: catchUpObserver
          });
        } catch (err) {
          console.error("Catch-up projector error:", err);
        }
        try {
          await sleep(idleMs, controller.signal);
        } catch {
          break;
        }
      }
    })();

    // Tamper-evidence anchor sealer: snapshots chained claim heads per tenant
    // into the anchor chain, off the write path. Discovers tenants itself.
    const anchorRunner = new PgChainAnchorRunner(pool, anchorSealer, {
      intervalMs: 30_000,
      onError: (err, tenantId) => console.error("Anchor sealer error:", tenantId ?? "", err)
    });
    const anchorDone = anchorRunner.start(controller.signal).catch((err) => {
      if (err?.name !== "AbortError") console.error("Anchor runner error:", err);
    });

    return {
      controller,
      done: Promise.all([runnerDone, catchUpDone, anchorDone]).then(() => undefined)
    };
  }

  return { app, sessionFactory, store, anchorSealer, tenantResolver, startWorkers };
}

/**
 * Convenience helper: run schema migrations against the provided pool.
 * Equivalent to `tenantResolver.migrate()` for conjoined tenancy.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(pool);
}
