import express from "express";
import { Pool } from "pg";
import { PgEventStore, PgSnapshotStore, PgDlqService, PgOutboxStatsService, SessionFactory } from "@eventfabric/postgres";
import { UserAggregate, type UserState } from "./domain/user.aggregate";
import type { UserEvent, UserRegisteredV2, UserEmailChangedV1 } from "./domain/user.events";
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
], snapshotStore);

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
    
    // Marten-style API: Start a new stream with typed events
    const userRegistered: UserRegisteredV2 = {
      type: "UserRegistered",
      version: 2,
      userId: id,
      email,
      displayName
    };
    
    // Start a new stream and commit
    session.startStream(id, userRegistered);
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
