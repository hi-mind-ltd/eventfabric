import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildInsuranceApp, runMigrations, type InsuranceApp } from "../src/build-app";
import { ClaimSubmitted } from "../src/domain/claim.events";

const ACME = "acme";
const SECRET = "test-chain-secret";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
let insurance: InsuranceApp;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  insurance = buildInsuranceApp({
    pool,
    allowedTenants: new Set([ACME]),
    chainSecret: SECRET,
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
  await pool.query(`DELETE FROM eventfabric.event_chain_anchor_members`);
  await pool.query(`DELETE FROM eventfabric.event_chain_anchors`);
  await pool.query(`DELETE FROM eventfabric.stream_versions`);
  await pool.query(`DELETE FROM eventfabric.events`);
}, 60_000);

/** Seed a chained claim stream directly (bypasses the policy-coverage route guards). */
async function submitClaim(tenant: string, claimId: string, requestedAmount: number): Promise<void> {
  const session = insurance.sessionFactory.createSession(tenant);
  session.startStream(
    claimId,
    ClaimSubmitted({
      claimId,
      policyId: "pol-1",
      policyholderId: "ph-1",
      incidentDate: "2026-01-01",
      description: "water damage",
      requestedAmount,
      submittedAt: new Date().toISOString()
    })
  );
  await session.saveChangesAsync();
}

const hdr = (tenant: string) => ({ "x-tenant-id": tenant });

describe("insurance-api: tamper-evident claim ledger (multi-tenant)", () => {
  it("verifies an intact claim via GET /claims/:id/verify", async () => {
    await submitClaim(ACME, "claim-ok", 5000);
    const res = await app.inject({ method: "GET", url: "/claims/claim-ok/verify", headers: hdr(ACME) });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().eventsChecked).toBe(1);
  });

  it("flags a forged claim amount via the verify endpoint", async () => {
    await submitClaim(ACME, "claim-bad", 5000);
    await pool.query(
      `UPDATE eventfabric.events SET payload = jsonb_set(payload, '{requestedAmount}', '999999')
       WHERE tenant_id=$1 AND aggregate_name='Claim' AND aggregate_id=$2`,
      [ACME, "claim-bad"]
    );
    const res = await app.inject({ method: "GET", url: "/claims/claim-bad/verify", headers: hdr(ACME) });
    expect(res.statusCode).toBe(409);
    expect(res.json().ok).toBe(false);
    expect(res.json().reason).toMatch(/event_hash mismatch/);
  });

  it("anchor ops catch deletion of an entire claim stream", async () => {
    await submitClaim(ACME, "claim-anchored", 1000);

    const seal = await app.inject({ method: "POST", url: "/ops/chain/seal", headers: hdr(ACME) });
    expect(seal.statusCode).toBe(200);
    expect(seal.json().sealed).toBe(true);

    const ok = await app.inject({ method: "GET", url: "/ops/chain/verify", headers: hdr(ACME) });
    expect(ok.statusCode).toBe(200);

    // Erase the whole claim — per-claim verify can't catch this; the anchor does.
    await pool.query(`DELETE FROM eventfabric.events WHERE tenant_id=$1 AND aggregate_name='Claim' AND aggregate_id=$2`, [ACME, "claim-anchored"]);
    await pool.query(`DELETE FROM eventfabric.stream_versions WHERE tenant_id=$1 AND aggregate_name='Claim' AND aggregate_id=$2`, [ACME, "claim-anchored"]);

    const bad = await app.inject({ method: "GET", url: "/ops/chain/verify", headers: hdr(ACME) });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().failure.kind).toBe("sealed-event-missing");
  });
});
