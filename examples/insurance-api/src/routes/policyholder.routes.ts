import type { FastifyInstance } from "fastify";
import type { SessionFactory } from "@eventfabric/postgres";
import { withConcurrencyRetry } from "@eventfabric/core";
import type { InsuranceEvent } from "../domain/events";
import { PolicyholderAggregate } from "../domain/policyholder.aggregate";
import { PolicyholderRegistered } from "../domain/policyholder.events";

type Deps = {
  sessionFactory: SessionFactory<InsuranceEvent>;
};

export async function registerPolicyholderRoutes(app: FastifyInstance, { sessionFactory }: Deps): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: { email: string; fullName: string; dateOfBirth: string };
  }>(
    "/policyholders/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "fullName", "dateOfBirth"],
          properties: {
            email: { type: "string", format: "email" },
            fullName: { type: "string", minLength: 1 },
            dateOfBirth: { type: "string" }
          }
        }
      }
    },
    async (req, reply) => {
      const session = sessionFactory.createSession(req.tenantId);
      try {
        session.startStream(req.params.id, PolicyholderRegistered({
          policyholderId: req.params.id,
          email: req.body.email,
          fullName: req.body.fullName,
          dateOfBirth: req.body.dateOfBirth
        }));
        await session.saveChangesAsync();
        return reply.code(201).send({ ok: true, policyholderId: req.params.id });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { kycReference: string };
  }>(
    "/policyholders/:id/verify",
    async (req, reply) => {
      try {
        // withConcurrencyRetry handles the case where two admins verify the same
        // policyholder concurrently — the second attempt reloads the latest
        // aggregate state so the domain rules see fresh data.
        await withConcurrencyRetry(
          async () => {
            const session = sessionFactory.createSession(req.tenantId);
            const holder = await session.loadAggregateAsync<PolicyholderAggregate>(req.params.id);
            holder.verify(req.body.kycReference);
            await session.saveChangesAsync();
          },
          { maxAttempts: 3, backoff: { minMs: 10, maxMs: 100, factor: 2, jitter: 0.2 } }
        );
        return reply.send({ ok: true });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.patch<{
    Params: { id: string };
    Body: { email?: string; phone?: string };
  }>(
    "/policyholders/:id/contact",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const holder = await session.loadAggregateAsync<PolicyholderAggregate>(req.params.id);
        holder.updateContact({ email: req.body.email, phone: req.body.phone });
        await session.saveChangesAsync();
        return reply.send({ ok: true });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { reason: string };
  }>(
    "/policyholders/:id/suspend",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const holder = await session.loadAggregateAsync<PolicyholderAggregate>(req.params.id);
        holder.suspend(req.body.reason);
        await session.saveChangesAsync();
        return reply.send({ ok: true });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/policyholders/:id",
    async (req, reply) => {
      try {
        const session = sessionFactory.createSession(req.tenantId);
        const holder = await session.loadAggregateAsync<PolicyholderAggregate>(req.params.id);
        return reply.send({
          id: holder.id,
          email: holder.email,
          fullName: holder.fullName,
          verified: holder.isVerified,
          suspended: holder.isSuspended
        });
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    }
  );
}

