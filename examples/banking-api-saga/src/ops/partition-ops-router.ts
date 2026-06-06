import { Router } from "express";
import type { Pool } from "pg";
import { PgPartitionManager } from "@eventfabric/postgres";

export function createPartitionOpsRouter(pool: Pool): Router {
  const router = Router();
  const manager = new PgPartitionManager();

  // GET /ops/partitions — list all current partitions
  router.get("/", async (_req, res) => {
    try {
      const isPartitioned = await manager.isPartitioned(pool);
      if (!isPartitioned) {
        res.json({ partitioned: false, message: "Events table is not partitioned. POST /ops/partitions/enable to convert." });
        return;
      }
      const partitions = await manager.listPartitions(pool);
      const currentPos = await manager.getCurrentPosition(pool);
      res.json({ partitioned: true, currentPosition: currentPos.toString(), partitions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /ops/partitions/enable — one-time conversion to partitioned table
  router.post("/enable", async (req, res) => {
    try {
      const partitionSize = req.body.partitionSize
        ? BigInt(req.body.partitionSize)
        : 1_000_000n;

      await manager.enablePartitioning(pool, { partitionSize });
      const partitions = await manager.listPartitions(pool);

      res.json({
        ok: true,
        message: "Events table is now range-partitioned by global_position.",
        partitions
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /ops/partitions/create — add a new partition range
  router.post("/create", async (req, res) => {
    try {
      const { from, to } = req.body;
      if (!from || !to) {
        res.status(400).json({ error: "from and to are required (e.g. { from: \"2000000\", to: \"3000000\" })" });
        return;
      }
      const name = await manager.createPartition(pool, BigInt(from), BigInt(to));
      res.json({ ok: true, partition: name });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /ops/partitions/detach — detach a partition for archival
  router.post("/detach", async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) {
        res.status(400).json({ error: "name is required (e.g. { name: \"events_p0\" })" });
        return;
      }
      await manager.detachPartition(pool, name);
      res.json({ ok: true, message: `Partition ${name} detached. It still exists as a standalone table.` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
