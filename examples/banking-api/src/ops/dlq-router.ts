// Example only — not part of packages
import express from "express";
import type { PgDlqService } from "@eventfabric/postgres";

export function createDlqRouter(dlq: PgDlqService): express.Router {
  const r = express.Router();

  r.get("/", async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const topic = (req.query.topic as string | undefined) ?? null;

    const result = await dlq.list({ limit, offset, topic });
    res.json({
      total: result.total,
      items: result.items.map(i => ({ ...i, globalPosition: i.globalPosition.toString() }))
    });
  });

  r.post("/requeue/global/:pos", async (req, res) => {
    const pos = BigInt(req.params.pos);
    const result = await dlq.requeueByGlobalPosition(pos);
    if (!result.requeued) return res.status(404).json({ error: result.reason ?? "Not found" });
    res.json({ ok: true });
  });

  return r;
}
