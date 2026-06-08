import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { PgUnitOfWork } from "@eventfabric/postgres";
import type { PgEventStore, SessionFactory } from "@eventfabric/postgres";
import type { InsuranceEvent } from "../domain/events";
import { ClaimAggregate } from "../domain/claim.aggregate";
import { PolicyAggregate } from "../domain/policy.aggregate";
import { ClaimSubmitted } from "../domain/claim.events";

type Deps = {
  sessionFactory: SessionFactory<InsuranceEvent>;
  store: PgEventStore<InsuranceEvent>;
  pool: Pool;
};

export async function registerClaimRoutes(app: FastifyInstance, { sessionFactory, store, pool }: Deps): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: {
      policyId: string;
      incidentDate: string;
      description: string;
      requestedAmount: number;
    };
  }>(
    "/claims/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["policyId", "incidentDate", "description", "requestedAmount"],
          properties: {
            policyId: { type: "string", minLength: 1 },
            incidentDate: { type: "string" },
            description: { type: "string", minLength: 1 },
            requestedAmount: { type: "number", exclusiveMinimum: 0 }
          }
        }
      }
    },
    async (req, reply) => {
      const session = sessionFactory.createSession(req.tenantId);
      try {
        // Guard: the policy must exist, be active, and cover the incident date.
        const policy = await session.loadAggregateAsync<PolicyAggregate>(req.body.policyId);
        if (policy.status !== "active") {
          return reply.code(409).send({ error: `Cannot claim against ${policy.status} policy` });
        }
        if (req.body.requestedAmount > policy.coverageAmount) {
          return reply.code(400).send({ error: "Requested amount exceeds policy coverage" });
        }
        if (!policy.policyholderId) {
          return reply.code(500).send({ error: "Policy has no policyholder" });
        }

        session.startStream(req.params.id, ClaimSubmitted({
          claimId: req.params.id,
          policyId: req.body.policyId,
          policyholderId: policy.policyholderId,
          incidentDate: req.body.incidentDate,
          description: req.body.description,
          requestedAmount: req.body.requestedAmount,
          submittedAt: new Date().toISOString()
        }));
        await session.saveChangesAsync();
        return reply.code(201).send({ ok: true, claimId: req.params.id });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { adjusterId: string };
  }>(
    "/claims/:id/assign",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const claim = await session.loadAggregateAsync<ClaimAggregate>(req.params.id);
        claim.assignAdjuster(req.body.adjusterId);
        await session.saveChangesAsync();
        return reply.send({ ok: true, status: claim.status });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { approvedAmount: number; approvedBy: string };
  }>(
    "/claims/:id/approve",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const claim = await session.loadAggregateAsync<ClaimAggregate>(req.params.id);
        claim.approve(req.body.approvedAmount, req.body.approvedBy);
        await session.saveChangesAsync();
        return reply.send({ ok: true, status: claim.status, approvedAmount: claim.approvedAmount });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { reason: string; deniedBy: string };
  }>(
    "/claims/:id/deny",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const claim = await session.loadAggregateAsync<ClaimAggregate>(req.params.id);
        claim.deny(req.body.reason, req.body.deniedBy);
        await session.saveChangesAsync();
        return reply.send({ ok: true, status: claim.status });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/claims/:id",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const claim = await session.loadAggregateAsync<ClaimAggregate>(req.params.id);
        return reply.send({
          id: claim.id,
          policyId: claim.policyId,
          policyholderId: claim.policyholderId,
          status: claim.status,
          requestedAmount: claim.requestedAmount,
          approvedAmount: claim.approvedAmount
        });
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    }
  );

  // Tamper-evidence: verify this claim's hash chain (tenant-scoped).
  // 200 = intact; 409 = a break was detected (firstBrokenAt / reason).
  app.get<{ Params: { id: string } }>(
    "/claims/:id/verify",
    async (req, reply) => {
      try {
        const result = await new PgUnitOfWork(pool, req.tenantId).withTransaction((tx) =>
          store.verifyStream(tx, { aggregateName: ClaimAggregate.aggregateName, aggregateId: req.params.id })
        );
        return reply.code(result.ok ? 200 : 409).send(result);
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );
}
