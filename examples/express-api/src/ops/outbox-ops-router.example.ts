// Example only — not part of packages
import express, { type Router } from "express";
import type { PgOutboxStatsService } from "@eventfabric/postgres";

export function createOutboxOpsRouter(stats: PgOutboxStatsService): Router {
  const r = express.Router();
  r.get("/", async (_req, res) => {
    res.json(await stats.getBacklogStats());
  });
  return r;
}
