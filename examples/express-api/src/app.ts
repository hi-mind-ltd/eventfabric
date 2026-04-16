import express from "express";
import { Pool } from "pg";
import { PgEventStore, PgSnapshotStore, PgDlqService, PgOutboxStatsService, SessionFactory } from "@eventfabric/postgres";
import { UserAggregate, type UserState } from "./domain/user.aggregate";
import type { UserEvent } from "./domain/user.events";
import { UserRegistered } from "./domain/user.events";
import { createDlqRouter } from "./ops/dlq-router.example";
import { createOutboxOpsRouter } from "./ops/outbox-ops-router.example";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgEventStore<UserEvent>();
const snapshotStore = new PgSnapshotStore<UserState>("eventfabric.snapshots", 1);

// Session factory - configured once, creates sessions per request
const sessionFactory = new SessionFactory<UserEvent>(pool, store);

// Register aggregate with its event types and snapshot store (done once)
sessionFactory.registerAggregate(UserAggregate, [
  "UserRegistered",
  "UserEmailChanged"
], "user", { snapshotStore });

const dlq = new PgDlqService(pool);
const outboxStats = new PgOutboxStatsService(pool);

const app = express();
app.use(express.json());

// Register a user using startStream (Marten-style)
app.post("/users/:id/register", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { email, displayName } = req.body;
    
    // Start a new stream and commit
    session.startStream(id, UserRegistered({ userId: id, email, displayName }));
    await session.saveChangesAsync();
    
    res.json({ ok: true, userId: id, email, displayName });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Change email using tracked aggregate + saveChangesAsync
app.post("/users/:id/change-email", async (req, res) => {
  const session = sessionFactory.createSession();
  try {
    const id = req.params.id;
    const { email } = req.body;
    
    const user = await session.loadAggregateAsync<UserAggregate>(id);
    user.changeEmail(email);
    await session.saveChangesAsync();   

    res.json({ ok: true, userId: id, email });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.use("/ops/dlq", createDlqRouter(dlq));
app.use("/ops/outbox", createOutboxOpsRouter(outboxStats));

app.listen(3000, () => console.log("Example API listening on :3000"));
