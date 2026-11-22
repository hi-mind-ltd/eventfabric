// Example only — not part of packages
import express from "express";
import type { ProjectionDaemon, AnyEvent, Transaction } from "@eventfabric/core";

/**
 * Ops endpoints for events the projection daemon gave up on (including the
 * FundsTransfer saga's): list them, and replay one after fixing the cause.
 */
export function createProjectionDlqRouter<E extends AnyEvent, TTx extends Transaction>(
  daemon: ProjectionDaemon<E, TTx>
): express.Router {
  const r = express.Router();

  // GET /ops/projections/dead-letters?projection=saga:FundsTransfer&tenant=default&limit=50
  r.get("/dead-letters", async (req, res) => {
    const items = await daemon.listDeadLetters({
      projectionName: req.query.projection as string | undefined,
      tenantId: req.query.tenant as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json({ items: items.map((i) => ({ ...i, globalPosition: i.globalPosition.toString() })) });
  });

  // POST /ops/projections/dead-letters/:id/replay
  // Re-runs the event through its projection (out of order). For a saga,
  // the event is applied against the instance's current state.
  r.post("/dead-letters/:id/replay", async (req, res) => {
    try {
      const result = await daemon.replayDeadLetter(Number(req.params.id));
      if (!result.replayed) return res.status(404).json({ error: result.reason });
      res.json({ ok: true });
    } catch (err: any) {
      // The handler failed again; the dead letter is kept.
      res.status(409).json({ error: err?.message ?? String(err) });
    }
  });

  return r;
}
