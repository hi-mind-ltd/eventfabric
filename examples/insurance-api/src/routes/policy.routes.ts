import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { type SessionFactory, query } from "@eventfabric/postgres";
import { withConcurrencyRetry } from "@eventfabric/core";
import type { InsuranceEvent } from "../domain/events";
import { PolicyAggregate } from "../domain/policy.aggregate";
import { PolicyholderAggregate } from "../domain/policyholder.aggregate";
import { PolicyIssued } from "../domain/policy.events";

type Deps = {
  sessionFactory: SessionFactory<InsuranceEvent>;
  pool: Pool;
};

export async function registerPolicyRoutes(app: FastifyInstance, { sessionFactory, pool }: Deps): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: {
      policyholderId: string;
      productCode: string;
      coverageAmount: number;
      premiumAmount: number;
      currency?: string;
      effectiveDate: string;
      expiryDate: string;
    };
  }>(
    "/policies/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["policyholderId", "productCode", "coverageAmount", "premiumAmount", "effectiveDate", "expiryDate"],
          properties: {
            policyholderId: { type: "string", minLength: 1 },
            productCode: { type: "string", minLength: 1 },
            coverageAmount: { type: "number", exclusiveMinimum: 0 },
            premiumAmount: { type: "number", exclusiveMinimum: 0 },
            currency: { type: "string" },
            effectiveDate: { type: "string" },
            expiryDate: { type: "string" }
          }
        }
      }
    },
    async (req, reply) => {
      const session = sessionFactory.createSession(req.tenantId);
      try {
        // Guard: the policyholder must exist and be verified/not-suspended.
        const holder = await session.loadAggregateAsync<PolicyholderAggregate>(req.body.policyholderId);
        if (!holder.isVerified) {
          return reply.code(409).send({ error: "Policyholder must be verified before issuing a policy" });
        }
        if (holder.isSuspended) {
          return reply.code(409).send({ error: "Cannot issue policy to a suspended policyholder" });
        }

        session.startStream(req.params.id, PolicyIssued({
          policyId: req.params.id,
          policyholderId: req.body.policyholderId,
          productCode: req.body.productCode,
          coverageAmount: req.body.coverageAmount,
          premiumAmount: req.body.premiumAmount,
          currency: req.body.currency ?? "GBP",
          effectiveDate: req.body.effectiveDate,
          expiryDate: req.body.expiryDate
        }));
        await session.saveChangesAsync();
        return reply.code(201).send({ ok: true, policyId: req.params.id });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { paymentId: string; amount: number };
  }>(
    "/policies/:id/premium",
    async (req, reply) => {
      try {
        const totalPaid = await withConcurrencyRetry(
          async () => {
            const session = sessionFactory.createSession(req.tenantId);
            const policy = await session.loadAggregateAsync<PolicyAggregate>(req.params.id);
            policy.payPremium(req.body.paymentId, req.body.amount);
            await session.saveChangesAsync();
            return policy.totalPaid;
          },
          { maxAttempts: 3, backoff: { minMs: 10, maxMs: 100, factor: 2, jitter: 0.2 } }
        );
        return reply.send({ ok: true, totalPaid });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { newExpiryDate: string; newPremiumAmount: number };
  }>(
    "/policies/:id/renew",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const policy = await session.loadAggregateAsync<PolicyAggregate>(req.params.id);
        policy.renew(req.body.newExpiryDate, req.body.newPremiumAmount);
        await session.saveChangesAsync();
        return reply.send({ ok: true, newExpiryDate: policy.expiryDate });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { reason: string; refundAmount: number };
  }>(
    "/policies/:id/cancel",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const policy = await session.loadAggregateAsync<PolicyAggregate>(req.params.id);
        policy.cancel(req.body.reason, req.body.refundAmount);
        await session.saveChangesAsync();
        return reply.send({ ok: true, status: policy.status });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/policies/:id/expire",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const policy = await session.loadAggregateAsync<PolicyAggregate>(req.params.id);
        policy.expire();
        await session.saveChangesAsync();
        return reply.send({ ok: true, status: policy.status });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/policies/:id",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const policy = await session.loadAggregateAsync<PolicyAggregate>(req.params.id);
        return reply.send({
          id: policy.id,
          policyholderId: policy.policyholderId,
          coverageAmount: policy.coverageAmount,
          totalPaid: policy.totalPaid,
          status: policy.status,
          expiryDate: policy.expiryDate
        });
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    }
  );

  // Raw-SQL event-sourced projection query: count active policies by
  // product code for the calling tenant. Reads straight from the events
  // table — handy as an ops view, no separate read-model needed.
  app.get<{
    Querystring: { productCode?: string };
  }>(
    "/policies/stats/by-product",
    async (req, reply) => {
      type Row = { product_code: string; issued: number };

      const rows = await query<Row>(pool)
        .sql`
          SELECT payload->>'productCode' AS product_code,
                 COUNT(*)::int AS issued
          FROM eventfabric.events
          WHERE tenant_id = ${req.tenantId}
            AND type = 'PolicyIssued'
            AND (${req.query.productCode ?? null}::text IS NULL
                 OR payload->>'productCode' = ${req.query.productCode ?? null})
          GROUP BY payload->>'productCode'
          ORDER BY issued DESC
        `
        .toList();

      return reply.send({ tenantId: req.tenantId, stats: rows });
    }
  );
}
