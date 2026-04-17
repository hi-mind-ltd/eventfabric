import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality
} from "@opentelemetry/sdk-metrics";

import { buildInsuranceApp, runMigrations, type InsuranceApp } from "../src/build-app";
import { PolicyholderAggregate } from "../src/domain/policyholder.aggregate";
import { PolicyAggregate } from "../src/domain/policy.aggregate";
import { ClaimAggregate } from "../src/domain/claim.aggregate";
import type { InsuranceEvent } from "../src/domain/events";
import type { PolicyIssuedV1, PolicyIssuedV2 } from "../src/domain/policy.events";
import { policyEventUpcaster } from "../src/domain/policy.upcasters";
import { notificationGateway } from "../src/projections/notification-projection";
import { premiumAuditProjection } from "../src/projections/premium-audit";
import { createClaimSettlementProjection } from "../src/projections/claim-settlement-projection";
import { createCatchUpProjector, PgEventStore, type PgTx } from "@eventfabric/postgres";
import { createCatchUpObserver } from "@eventfabric/opentelemetry";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
let insurance: InsuranceApp;
let app: FastifyInstance;
let spanExporter: InMemorySpanExporter;
let metricExporter: InMemoryMetricExporter;
let metricReader: PeriodicExportingMetricReader;
let tracerProvider: BasicTracerProvider;
let meterProvider: MeterProvider;

const ACME = "acme";
const CONTOSO = "contoso";
const EVIL = "unknown-tenant";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);

  spanExporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)]
  });

  metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000
  });
  meterProvider = new MeterProvider({ readers: [metricReader] });

  insurance = buildInsuranceApp({
    pool,
    allowedTenants: new Set([ACME, CONTOSO]),
    tracer: tracerProvider.getTracer("insurance-test"),
    meter: meterProvider.getMeter("insurance-test"),
    logger: false
  });
  app = insurance.app;
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.snapshots`);
  await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
  await pool.query(`DELETE FROM eventfabric.outbox`);
  await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
  await pool.query(`DELETE FROM eventfabric.stream_versions`);
  await pool.query(`DELETE FROM eventfabric.events`);
  spanExporter.reset();
  notificationGateway.clear();
}, 60_000);

// ---------- helpers ---------------------------------------------------------

async function registerHolder(tenantId: string, id: string, overrides: Partial<{ email: string; fullName: string; dateOfBirth: string }> = {}) {
  return app.inject({
    method: "POST",
    url: `/policyholders/${id}`,
    headers: { "x-tenant-id": tenantId, "content-type": "application/json" },
    payload: {
      email: overrides.email ?? `${id}@example.com`,
      fullName: overrides.fullName ?? "Test Holder",
      dateOfBirth: overrides.dateOfBirth ?? "1990-01-01"
    }
  });
}

async function verifyHolder(tenantId: string, id: string) {
  return app.inject({
    method: "POST",
    url: `/policyholders/${id}/verify`,
    headers: { "x-tenant-id": tenantId, "content-type": "application/json" },
    payload: { kycReference: `KYC-${id}` }
  });
}

async function issuePolicy(tenantId: string, policyId: string, holderId: string, overrides: Partial<{ coverageAmount: number; premiumAmount: number; productCode: string; effectiveDate: string; expiryDate: string }> = {}) {
  return app.inject({
    method: "POST",
    url: `/policies/${policyId}`,
    headers: { "x-tenant-id": tenantId, "content-type": "application/json" },
    payload: {
      policyholderId: holderId,
      productCode: overrides.productCode ?? "auto",
      coverageAmount: overrides.coverageAmount ?? 50_000,
      premiumAmount: overrides.premiumAmount ?? 1_200,
      currency: "GBP",
      effectiveDate: overrides.effectiveDate ?? "2026-01-01",
      expiryDate: overrides.expiryDate ?? "2027-01-01"
    }
  });
}

async function submitClaim(tenantId: string, claimId: string, policyId: string, overrides: Partial<{ requestedAmount: number; description: string; incidentDate: string }> = {}) {
  return app.inject({
    method: "POST",
    url: `/claims/${claimId}`,
    headers: { "x-tenant-id": tenantId, "content-type": "application/json" },
    payload: {
      policyId,
      incidentDate: overrides.incidentDate ?? "2026-02-15",
      description: overrides.description ?? "Collision with another vehicle",
      requestedAmount: overrides.requestedAmount ?? 5_000
    }
  });
}

// ============================================================================
// Tenant middleware
// ============================================================================

describe("tenant middleware", () => {
  it("rejects requests without x-tenant-id header", async () => {
    const res = await app.inject({ method: "POST", url: "/policyholders/ph-1", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tenant_id_missing" });
  });

  it("rejects requests with an unknown tenant id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/policyholders/ph-1",
      headers: { "x-tenant-id": EVIL, "content-type": "application/json" },
      payload: { email: "x@y.co", fullName: "X", dateOfBirth: "1990-01-01" }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "tenant_not_allowed" });
  });

  it("/health bypasses the tenant check", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

// ============================================================================
// Multi-tenancy isolation
// ============================================================================

describe("multi-tenancy isolation", () => {
  it("data written under one tenant is invisible to another", async () => {
    const r1 = await registerHolder(ACME, "ph-shared");
    expect(r1.statusCode).toBe(201);

    // Contoso cannot see Acme's policyholder
    const acmeView = await app.inject({
      method: "GET",
      url: "/policyholders/ph-shared",
      headers: { "x-tenant-id": ACME }
    });
    expect(acmeView.statusCode).toBe(200);
    expect(acmeView.json().fullName).toBe("Test Holder");

    const contosoView = await app.inject({
      method: "GET",
      url: "/policyholders/ph-shared",
      headers: { "x-tenant-id": CONTOSO }
    });
    expect(contosoView.statusCode).toBe(404);
  });

  it("the same aggregate id can exist independently in two tenants", async () => {
    await registerHolder(ACME, "ph-common", { fullName: "Acme Alice" });
    await registerHolder(CONTOSO, "ph-common", { fullName: "Contoso Carol" });

    const acme = await app.inject({
      method: "GET",
      url: "/policyholders/ph-common",
      headers: { "x-tenant-id": ACME }
    });
    const contoso = await app.inject({
      method: "GET",
      url: "/policyholders/ph-common",
      headers: { "x-tenant-id": CONTOSO }
    });

    expect(acme.json().fullName).toBe("Acme Alice");
    expect(contoso.json().fullName).toBe("Contoso Carol");
  });

  it("events in the events table are tagged with the issuing tenant_id", async () => {
    await registerHolder(ACME, "ph-tag-a");
    await registerHolder(CONTOSO, "ph-tag-b");

    const { rows } = await pool.query(
      `SELECT tenant_id, aggregate_id FROM eventfabric.events ORDER BY global_position`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenant_id: ACME, aggregate_id: "ph-tag-a" });
    expect(rows[1]).toMatchObject({ tenant_id: CONTOSO, aggregate_id: "ph-tag-b" });
  });

  it("stats query only returns rows for the calling tenant", async () => {
    await registerHolder(ACME, "ph-s1");
    await verifyHolder(ACME, "ph-s1");
    await issuePolicy(ACME, "pol-a1", "ph-s1", { productCode: "auto" });
    await issuePolicy(ACME, "pol-a2", "ph-s1", { productCode: "home" });

    await registerHolder(CONTOSO, "ph-s2");
    await verifyHolder(CONTOSO, "ph-s2");
    await issuePolicy(CONTOSO, "pol-c1", "ph-s2", { productCode: "auto" });

    const acme = await app.inject({
      method: "GET",
      url: "/policies/stats/by-product",
      headers: { "x-tenant-id": ACME }
    });
    expect(acme.statusCode).toBe(200);
    const acmeBody = acme.json();
    expect(acmeBody.tenantId).toBe(ACME);
    expect(acmeBody.stats).toEqual(
      expect.arrayContaining([
        { product_code: "auto", issued: 1 },
        { product_code: "home", issued: 1 }
      ])
    );

    const contoso = await app.inject({
      method: "GET",
      url: "/policies/stats/by-product",
      headers: { "x-tenant-id": CONTOSO }
    });
    expect(contoso.json().stats).toEqual([{ product_code: "auto", issued: 1 }]);
  });
});

// ============================================================================
// Policyholder lifecycle
// ============================================================================

describe("policyholder lifecycle", () => {
  it("register → verify → update contact flow", async () => {
    await registerHolder(ACME, "ph-alice", { email: "alice@acme.co", fullName: "Alice" });

    const verify = await verifyHolder(ACME, "ph-alice");
    expect(verify.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: "/policyholders/ph-alice/contact",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { phone: "+44 20 7946 0000" }
    });
    expect(patch.statusCode).toBe(200);

    const session = insurance.sessionFactory.createSession(ACME);
    const aggregate = await session.loadAggregateAsync<PolicyholderAggregate>("ph-alice");
    expect(aggregate.isVerified).toBe(true);
    expect(aggregate.isSuspended).toBe(false);
  });

  it("rejects duplicate registration", async () => {
    await registerHolder(ACME, "ph-dup");
    const again = await registerHolder(ACME, "ph-dup");
    // second startStream raises a ConcurrencyError inside save → 400
    expect(again.statusCode).toBe(400);
  });

  it("rejects verification of a suspended policyholder", async () => {
    await registerHolder(ACME, "ph-susp");

    const suspend = await app.inject({
      method: "POST",
      url: "/policyholders/ph-susp/suspend",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { reason: "Fraud flag" }
    });
    expect(suspend.statusCode).toBe(200);

    const verify = await verifyHolder(ACME, "ph-susp");
    expect(verify.statusCode).toBe(400);
    expect(verify.json().error).toContain("suspended");
  });

  it("rejects contact update without any field", async () => {
    await registerHolder(ACME, "ph-empty");
    const patch = await app.inject({
      method: "PATCH",
      url: "/policyholders/ph-empty/contact",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: {}
    });
    expect(patch.statusCode).toBe(400);
  });
});

// ============================================================================
// Policy lifecycle
// ============================================================================

describe("policy lifecycle", () => {
  async function setupHolder() {
    await registerHolder(ACME, "ph-P");
    await verifyHolder(ACME, "ph-P");
  }

  it("issue requires a verified policyholder", async () => {
    await registerHolder(ACME, "ph-unverified");
    const res = await issuePolicy(ACME, "pol-1", "ph-unverified");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("verified");
  });

  it("issue → pay premium → renew → cancel", async () => {
    await setupHolder();

    const issued = await issuePolicy(ACME, "pol-full", "ph-P", {
      coverageAmount: 100_000,
      premiumAmount: 2_400,
      effectiveDate: "2026-01-01",
      expiryDate: "2027-01-01"
    });
    expect(issued.statusCode).toBe(201);

    const pay1 = await app.inject({
      method: "POST",
      url: "/policies/pol-full/premium",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { paymentId: "pay-1", amount: 600 }
    });
    expect(pay1.statusCode).toBe(200);
    expect(pay1.json().totalPaid).toBe(600);

    const pay2 = await app.inject({
      method: "POST",
      url: "/policies/pol-full/premium",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { paymentId: "pay-2", amount: 600 }
    });
    expect(pay2.json().totalPaid).toBe(1200);

    const renew = await app.inject({
      method: "POST",
      url: "/policies/pol-full/renew",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { newExpiryDate: "2028-01-01", newPremiumAmount: 2600 }
    });
    expect(renew.statusCode).toBe(200);
    expect(renew.json().newExpiryDate).toBe("2028-01-01");

    const cancel = await app.inject({
      method: "POST",
      url: "/policies/pol-full/cancel",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { reason: "customer request", refundAmount: 200 }
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
  });

  it("rejects premium payment that exceeds currency mismatch or on cancelled policy", async () => {
    await setupHolder();
    await issuePolicy(ACME, "pol-cancel", "ph-P", { coverageAmount: 10_000, premiumAmount: 500 });

    await app.inject({
      method: "POST",
      url: "/policies/pol-cancel/cancel",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { reason: "x", refundAmount: 0 }
    });

    const pay = await app.inject({
      method: "POST",
      url: "/policies/pol-cancel/premium",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { paymentId: "p1", amount: 100 }
    });
    expect(pay.statusCode).toBe(400);
    expect(pay.json().error).toContain("cancelled");
  });

  it("expire advances status to expired", async () => {
    await setupHolder();
    await issuePolicy(ACME, "pol-expire", "ph-P");
    const res = await app.inject({
      method: "POST",
      url: "/policies/pol-expire/expire",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("expired");
  });

  it("schema validation rejects non-positive coverage", async () => {
    await setupHolder();
    const res = await app.inject({
      method: "POST",
      url: "/policies/pol-bad",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: {
        policyholderId: "ph-P",
        productCode: "auto",
        coverageAmount: 0,
        premiumAmount: 500,
        effectiveDate: "2026-01-01",
        expiryDate: "2027-01-01"
      }
    });
    expect(res.statusCode).toBe(400);
  });
});

// ============================================================================
// Claim lifecycle + catch-up settlement process manager
// ============================================================================

describe("claim lifecycle and settlement process manager", () => {
  async function setupPolicy(policyId = "pol-claim", coverage = 20_000) {
    await registerHolder(ACME, "ph-claim");
    await verifyHolder(ACME, "ph-claim");
    await issuePolicy(ACME, policyId, "ph-claim", { coverageAmount: coverage });
  }

  it("rejects claim exceeding coverage", async () => {
    await setupPolicy("pol-cov", 1000);
    const res = await submitClaim(ACME, "cl-too-big", "pol-cov", { requestedAmount: 5000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("coverage");
  });

  it("full happy path: submit → assign → approve → settlement projection pays it", async () => {
    await setupPolicy("pol-happy");
    const sub = await submitClaim(ACME, "cl-happy", "pol-happy", { requestedAmount: 3000 });
    expect(sub.statusCode).toBe(201);

    const assign = await app.inject({
      method: "POST",
      url: "/claims/cl-happy/assign",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { adjusterId: "adj-42" }
    });
    expect(assign.json().status).toBe("under_review");

    const approve = await app.inject({
      method: "POST",
      url: "/claims/cl-happy/approve",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { approvedAmount: 2500, approvedBy: "manager-7" }
    });
    expect(approve.json().status).toBe("approved");
    expect(approve.json().approvedAmount).toBe(2500);

    // Drive the settlement projection until fixed point
    const projector = createCatchUpProjector<InsuranceEvent>(pool, insurance.store);
    const projections = [createClaimSettlementProjection(insurance.store)];

    const start = Date.now();
    let prev = -1;
    while (Date.now() - start < 10_000) {
      await projector.catchUpAll(projections, { batchSize: 100 });
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.events`);
      const cur = rows[0]!.c as number;
      if (cur === prev) break;
      prev = cur;
    }

    const session = insurance.sessionFactory.createSession(ACME);
    const claim = await session.loadAggregateAsync<ClaimAggregate>("cl-happy");
    expect(claim.status).toBe("paid");
  }, 15_000);

  it("deny path: submit → assign → deny (projection does nothing)", async () => {
    await setupPolicy("pol-deny");
    await submitClaim(ACME, "cl-deny", "pol-deny", { requestedAmount: 100 });
    await app.inject({
      method: "POST",
      url: "/claims/cl-deny/assign",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { adjusterId: "adj-1" }
    });
    const deny = await app.inject({
      method: "POST",
      url: "/claims/cl-deny/deny",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { reason: "Not covered by policy terms", deniedBy: "manager-9" }
    });
    expect(deny.json().status).toBe("denied");

    const projector = createCatchUpProjector<InsuranceEvent>(pool, insurance.store);
    await projector.catchUpAll([createClaimSettlementProjection(insurance.store)], { batchSize: 100 });

    const session = insurance.sessionFactory.createSession(ACME);
    const claim = await session.loadAggregateAsync<ClaimAggregate>("cl-deny");
    expect(claim.status).toBe("denied");
  });

  it("rejects approval of unassigned claim", async () => {
    await setupPolicy("pol-unass");
    await submitClaim(ACME, "cl-unass", "pol-unass", { requestedAmount: 500 });
    const approve = await app.inject({
      method: "POST",
      url: "/claims/cl-unass/approve",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { approvedAmount: 500, approvedBy: "m" }
    });
    expect(approve.statusCode).toBe(400);
    expect(approve.json().error).toContain("submitted");
  });

  it("settlement projection respects tenant isolation — acme's approvals don't touch contoso claims", async () => {
    // Same claim id in two tenants, but only acme approves
    await registerHolder(ACME, "ph-iso");
    await verifyHolder(ACME, "ph-iso");
    await issuePolicy(ACME, "pol-iso", "ph-iso");
    await submitClaim(ACME, "cl-iso", "pol-iso", { requestedAmount: 1000 });
    await app.inject({
      method: "POST",
      url: "/claims/cl-iso/assign",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { adjusterId: "a" }
    });
    await app.inject({
      method: "POST",
      url: "/claims/cl-iso/approve",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { approvedAmount: 800, approvedBy: "m" }
    });

    await registerHolder(CONTOSO, "ph-iso-c");
    await verifyHolder(CONTOSO, "ph-iso-c");
    await issuePolicy(CONTOSO, "pol-iso", "ph-iso-c");
    await submitClaim(CONTOSO, "cl-iso", "pol-iso", { requestedAmount: 1000 });

    const projector = createCatchUpProjector<InsuranceEvent>(pool, insurance.store);
    await projector.catchUpAll([createClaimSettlementProjection(insurance.store)], { batchSize: 100 });

    // Only acme's claim should be paid; contoso's is still in `submitted`
    const acmeSession = insurance.sessionFactory.createSession(ACME);
    const acmeClaim = await acmeSession.loadAggregateAsync<ClaimAggregate>("cl-iso");
    expect(acmeClaim.status).toBe("paid");

    const contosoSession = insurance.sessionFactory.createSession(CONTOSO);
    const contosoClaim = await contosoSession.loadAggregateAsync<ClaimAggregate>("cl-iso");
    expect(contosoClaim.status).toBe("submitted");
  });
});

// ============================================================================
// OpenTelemetry integration
// ============================================================================

describe("opentelemetry", () => {
  it("emits a span for each HTTP request with tenant_id attribute", async () => {
    await registerHolder(ACME, "ph-otel-http");
    await tracerProvider.forceFlush();

    const spans = spanExporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name.includes("POST") && s.name.includes("policyholder"));
    expect(httpSpan).toBeDefined();
    expect(httpSpan!.attributes["http.method"]).toBe("POST");
    expect(httpSpan!.attributes["eventfabric.tenant_id"]).toBe(ACME);
    expect(httpSpan!.attributes["http.status_code"]).toBe(201);
  });

  it("catch-up observer produces spans and metrics when settlement runs", async () => {
    await registerHolder(ACME, "ph-otel-cu");
    await verifyHolder(ACME, "ph-otel-cu");
    await issuePolicy(ACME, "pol-otel", "ph-otel-cu");
    await submitClaim(ACME, "cl-otel", "pol-otel", { requestedAmount: 1000 });
    await app.inject({
      method: "POST",
      url: "/claims/cl-otel/assign",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { adjusterId: "a" }
    });
    await app.inject({
      method: "POST",
      url: "/claims/cl-otel/approve",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { approvedAmount: 700, approvedBy: "m" }
    });

    const observer = createCatchUpObserver({
      tracer: tracerProvider.getTracer("test"),
      meter: meterProvider.getMeter("test")
    });
    const projector = createCatchUpProjector<InsuranceEvent>(pool, insurance.store);

    const start = Date.now();
    let prev = -1;
    while (Date.now() - start < 10_000) {
      await projector.catchUpAll([createClaimSettlementProjection(insurance.store)], { batchSize: 100, observer });
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM eventfabric.events`);
      const cur = rows[0]!.c as number;
      if (cur === prev) break;
      prev = cur;
    }

    await tracerProvider.forceFlush();
    const spans = spanExporter.getFinishedSpans();
    const settlementSpans = spans.filter((s) => s.attributes["eventfabric.projection"] === "claim-settlement");
    expect(settlementSpans.length).toBeGreaterThan(0);

    await metricReader.forceFlush();
    const allMetrics = metricExporter
      .getMetrics()
      .flatMap((m) => m.scopeMetrics.flatMap((s) => s.metrics));
    const handled = allMetrics.find((m) => m.descriptor.name === "eventfabric.catch_up.events_handled");
    expect(handled).toBeDefined();
  }, 15_000);
});

// ============================================================================
// Notification projection (unit-style; does not run the outbox runner)
// ============================================================================

describe("notification projection", () => {
  it("sends a policy-issued email for PolicyIssued events", async () => {
    const before = notificationGateway.getSent().length;

    const { insuranceNotificationProjection } = await import("../src/projections/notification-projection");
    await insuranceNotificationProjection.handle({} as PgTx, {
      eventId: "e1",
      tenantId: ACME,
      aggregateId: "pol-n",
      aggregateName: "Policy",
      aggregateVersion: 1,
      globalPosition: 1n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "PolicyIssued" as const,
        version: 2 as const,
        policyId: "pol-n",
        policyholderId: "ph-n",
        productCode: "auto",
        coverageAmount: 100_000,
        premiumAmount: 1200,
        currency: "GBP",
        effectiveDate: "2026-01-01",
        expiryDate: "2027-01-01"
      }
    });

    const after = notificationGateway.getSent().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]!.tenantId).toBe(ACME);
    expect(after[0]!.channel).toBe("email");
    expect(after[0]!.subject).toContain("pol-n");
    expect(after[0]!.body).toContain("auto");
  });

  it("sends sms on PremiumPaid", async () => {
    const before = notificationGateway.getSent().length;
    const { insuranceNotificationProjection } = await import("../src/projections/notification-projection");
    await insuranceNotificationProjection.handle({} as PgTx, {
      eventId: "e2",
      tenantId: CONTOSO,
      aggregateId: "pol-pp",
      aggregateName: "Policy",
      aggregateVersion: 2,
      globalPosition: 2n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "PremiumPaid" as const,
        version: 1 as const,
        policyId: "pol-pp",
        paymentId: "pay-1",
        amount: 600,
        paidAt: new Date().toISOString(),
        installmentNumber: 1,
        totalPaid: 600
      }
    });
    const after = notificationGateway.getSent().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]!.tenantId).toBe(CONTOSO);
    expect(after[0]!.channel).toBe("sms");
  });

  it("skips events it does not care about", async () => {
    const before = notificationGateway.getSent().length;
    const { insuranceNotificationProjection } = await import("../src/projections/notification-projection");
    await insuranceNotificationProjection.handle({} as PgTx, {
      eventId: "e3",
      tenantId: ACME,
      aggregateId: "cl-x",
      aggregateName: "Claim",
      aggregateVersion: 1,
      globalPosition: 3n,
      occurredAt: new Date().toISOString(),
      payload: {
        type: "ClaimAssigned" as const,
        version: 1 as const,
        claimId: "cl-x",
        adjusterId: "a",
        assignedAt: new Date().toISOString()
      }
    });
    const after = notificationGateway.getSent().slice(before);
    expect(after).toHaveLength(0);
  });
});

// ============================================================================
// PolicyIssued V1 upcaster
// ============================================================================

describe("policy-issued upcaster", () => {
  it("adds productCode='legacy' to V1 events on load", () => {
    const v1: PolicyIssuedV1 = {
      type: "PolicyIssued",
      version: 1,
      policyId: "pol-v1",
      policyholderId: "ph-v1",
      coverageAmount: 50_000,
      premiumAmount: 1000,
      currency: "GBP",
      effectiveDate: "2020-01-01",
      expiryDate: "2021-01-01"
    };
    const result = policyEventUpcaster(v1) as PolicyIssuedV2;
    expect(result.version).toBe(2);
    expect(result.productCode).toBe("legacy");
    expect(result.coverageAmount).toBe(50_000);
  });

  it("passes V2 events through unchanged", () => {
    const v2: PolicyIssuedV2 = {
      type: "PolicyIssued",
      version: 2,
      policyId: "pol-v2",
      policyholderId: "ph-v2",
      productCode: "home",
      coverageAmount: 75_000,
      premiumAmount: 1500,
      currency: "GBP",
      effectiveDate: "2026-01-01",
      expiryDate: "2027-01-01"
    };
    expect(policyEventUpcaster(v2)).toEqual(v2);
  });

  it("historical V1 events loaded through PgEventStore arrive as V2", async () => {
    const store = new PgEventStore<InsuranceEvent>({ upcaster: policyEventUpcaster });
    const tx: PgTx = { client: await pool.connect(), tenantId: ACME } as any;
    try {
      await tx.client.query("BEGIN");
      await tx.client.query(
        `INSERT INTO eventfabric.stream_versions (tenant_id, aggregate_name, aggregate_id, current_version) VALUES ($1, 'Policy', 'pol-historical', 1)`,
        [ACME]
      );
      await tx.client.query(
        `INSERT INTO eventfabric.events (tenant_id, event_id, aggregate_name, aggregate_id, aggregate_version, type, version, payload)
         VALUES ($1, gen_random_uuid(), 'Policy', 'pol-historical', 1, 'PolicyIssued', 1, $2::jsonb)`,
        [
          ACME,
          JSON.stringify({
            type: "PolicyIssued",
            version: 1,
            policyId: "pol-historical",
            policyholderId: "ph-historical",
            coverageAmount: 25_000,
            premiumAmount: 500,
            currency: "GBP",
            effectiveDate: "2019-01-01",
            expiryDate: "2020-01-01"
          })
        ]
      );
      await tx.client.query("COMMIT");
    } finally {
      tx.client.release();
    }

    const tx2: PgTx = { client: await pool.connect(), tenantId: ACME } as any;
    try {
      const events = await store.loadStream(tx2, "pol-historical", PolicyAggregate);
      expect(events).toHaveLength(1);
      const payload = events[0]!.payload as PolicyIssuedV2;
      expect(payload.version).toBe(2);
      expect(payload.productCode).toBe("legacy");
    } finally {
      tx2.client.release();
    }
  });
});

// ============================================================================
// Premium audit (forEventType helper)
// ============================================================================

describe("premium-audit projection", () => {
  it("advances its checkpoint past PremiumPaid events", async () => {
    await registerHolder(ACME, "ph-audit");
    await verifyHolder(ACME, "ph-audit");
    await issuePolicy(ACME, "pol-audit", "ph-audit");
    await app.inject({
      method: "POST",
      url: "/policies/pol-audit/premium",
      headers: { "x-tenant-id": ACME, "content-type": "application/json" },
      payload: { paymentId: "p-a", amount: 100 }
    });

    const projector = createCatchUpProjector<InsuranceEvent>(pool, insurance.store);
    await projector.catchUpAll([premiumAuditProjection], { batchSize: 100 });

    const { rows } = await pool.query(
      `SELECT last_global_position FROM eventfabric.projection_checkpoints WHERE projection_name = 'premium-audit'`
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].last_global_position)).toBeGreaterThan(0);
  });
});

// ============================================================================
// Domain rules (unit tests, no database)
// ============================================================================

describe("domain invariants", () => {
  it("PolicyAggregate rejects expiry <= effective date", () => {
    const p = new PolicyAggregate("pol-bad");
    expect(() => p.issue({
      policyholderId: "ph",
      productCode: "auto",
      coverageAmount: 1000,
      premiumAmount: 100,
      effectiveDate: "2026-02-01",
      expiryDate: "2026-02-01"
    })).toThrow("after effective");
  });

  it("PolicyAggregate forbids premium payment on cancelled policy", () => {
    const p = new PolicyAggregate("pol-c");
    p.issue({
      policyholderId: "ph",
      productCode: "auto",
      coverageAmount: 1000,
      premiumAmount: 100,
      effectiveDate: "2026-01-01",
      expiryDate: "2027-01-01"
    });
    p.cancel("x", 0);
    expect(() => p.payPremium("p", 50)).toThrow("cancelled");
  });

  it("ClaimAggregate cannot approve more than requested", () => {
    const c = new ClaimAggregate("cl");
    c.submit({
      policyId: "pol",
      policyholderId: "ph",
      incidentDate: "2026-02-01",
      description: "x",
      requestedAmount: 500
    });
    c.assignAdjuster("adj");
    expect(() => c.approve(600, "m")).toThrow("cannot exceed");
  });

  it("ClaimAggregate cannot transition from submitted to paid directly", () => {
    const c = new ClaimAggregate("cl2");
    c.submit({
      policyId: "pol",
      policyholderId: "ph",
      incidentDate: "2026-02-01",
      description: "x",
      requestedAmount: 500
    });
    expect(() => c.markPaid("ref")).toThrow("submitted");
  });

  it("PolicyholderAggregate forbids double suspension", () => {
    const h = new PolicyholderAggregate("ph");
    h.register("x@y.co", "X", "1990-01-01");
    h.suspend("first");
    expect(() => h.suspend("second")).toThrow("already suspended");
  });
});
