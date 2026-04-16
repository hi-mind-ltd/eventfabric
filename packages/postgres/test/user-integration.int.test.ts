import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { Repository, InlineProjector, AggregateRoot, type HandlerMap, type EventEnvelope, defineEvent } from "@eventfabric/core";
import { PgUnitOfWork } from "../src/unitofwork/pg-unit-of-work";
import { PgEventStore } from "../src/pg-event-store";
import { PgSnapshotStore } from "../src/snapshots/pg-snapshot-store";
import { createAsyncProjectionRunner } from "../src/projections/pg-async-projection-runner";
import type { PgTx } from "../src/unitofwork/pg-transaction";

// User Events - Define event metadata once
const UserRegisteredEvent = defineEvent("UserRegistered", 1);
const UserActivatedEvent = defineEvent("UserActivated", 1);

// Event types for type checking
type UserRegistered = {
  type: "UserRegistered";
  version: 1;
  userId: string;
  email: string;
  displayName: string;
};

type UserActivated = {
  type: "UserActivated";
  version: 1;
  userId: string;
  activatedAt: string;
};

type UserEvent = UserRegistered | UserActivated;

// User State
type UserState = {
  email?: string;
  displayName?: string;
  activated?: boolean;
  activatedAt?: string;
};

// User Aggregate
class UserAggregate extends AggregateRoot<UserState, UserEvent> {
  protected handlers = {
    UserRegistered: (s: UserState, e: Extract<UserEvent, { type: "UserRegistered" }>) => {
      s.email = e.email;
      s.displayName = e.displayName;
    },
    UserActivated: (s: UserState, e: Extract<UserEvent, { type: "UserActivated" }>) => {
      s.activated = true;
      s.activatedAt = e.activatedAt;
    }
  } satisfies HandlerMap<UserEvent, UserState>;

  constructor(id: string, snapshot?: UserState) {
    super(id, snapshot ?? {});
  }

  register(email: string, displayName: string) {
    // createEvent automatically populates type and version from the event definition
    // TypeScript will error if the version in defineEvent doesn't match the type definition
    const event = UserRegisteredEvent.create<UserRegistered>({ 
      userId: this.id, 
      email, 
      displayName 
    });
    this.raise(event);
  }

  activate() {
    // createEvent automatically populates type and version
    const event = UserActivatedEvent.create<UserActivated>({ 
      userId: this.id, 
      activatedAt: new Date().toISOString() 
    });
    this.raise(event);
  }
}

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS eventfabric;
    CREATE TABLE IF NOT EXISTS eventfabric.stream_versions (
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      current_version INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (aggregate_name, aggregate_id)
    );
    CREATE TABLE IF NOT EXISTS eventfabric.events (
      global_position BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL UNIQUE,
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INT NOT NULL,
      type TEXT NOT NULL,
      version INT NOT NULL,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dismissed_at TIMESTAMPTZ NULL,
      dismissed_reason TEXT NULL,
      dismissed_by TEXT NULL,
      correlation_id TEXT NULL,
      causation_id TEXT NULL,
      UNIQUE (aggregate_name, aggregate_id, aggregate_version)
    );
    CREATE INDEX IF NOT EXISTS events_global_idx ON eventfabric.events (global_position);

    CREATE TABLE IF NOT EXISTS eventfabric.projection_checkpoints (
      projection_name TEXT PRIMARY KEY,
      last_global_position BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS eventfabric.outbox (
      id BIGSERIAL PRIMARY KEY,
      global_position BIGINT NOT NULL UNIQUE,
      topic TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at TIMESTAMPTZ NULL,
      locked_by TEXT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      dead_lettered_at TIMESTAMPTZ NULL,
      dead_letter_reason TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS eventfabric.outbox_dead_letters (
      id BIGSERIAL PRIMARY KEY,
      outbox_id BIGINT NOT NULL,
      global_position BIGINT NOT NULL,
      topic TEXT NULL,
      attempts INT NOT NULL,
      last_error TEXT NULL,
      dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS eventfabric.snapshots (
      aggregate_name TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_version INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      snapshot_schema_version INT NOT NULL,
      state JSONB NOT NULL,
      PRIMARY KEY (aggregate_name, aggregate_id)
    );

    -- Search table for inline projection
    CREATE TABLE IF NOT EXISTS user_search (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      activated BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS user_search_email_idx ON user_search (email);
    CREATE INDEX IF NOT EXISTS user_search_display_name_idx ON user_search (display_name);
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate();
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

describe("User Integration Test", () => {
  beforeEach(async () => {
    // Clean up before each test
    await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
    await pool.query(`DELETE FROM eventfabric.outbox`);
    await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
    await pool.query(`DELETE FROM eventfabric.stream_versions`);
    await pool.query(`DELETE FROM eventfabric.events`);
    await pool.query(`DELETE FROM eventfabric.snapshots`);
    await pool.query(`DELETE FROM user_search`);
  }, 60000);

  it("registers and activates user in same transaction, creates snapshot, updates search table, and processes async email", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<UserEvent>();
    const snapshotStore = new PgSnapshotStore<UserState>("eventfabric.snapshots", 1);

    // Inline projection: Update search table
    const inlineProjector = new InlineProjector<UserEvent, PgTx>([
      {
        name: "user-search-projection",
        async handle(tx: PgTx, env) {
          if (env.payload.type === "UserRegistered") {
            await tx.client.query(
              `INSERT INTO user_search (user_id, email, display_name, activated, updated_at)
               VALUES ($1, $2, $3, false, now())
               ON CONFLICT (user_id) DO UPDATE SET
                 email = EXCLUDED.email,
                 display_name = EXCLUDED.display_name,
                 updated_at = now()`,
              [env.aggregateId, env.payload.email, env.payload.displayName]
            );
          } else if (env.payload.type === "UserActivated") {
            await tx.client.query(
              `UPDATE user_search SET activated = true, updated_at = now() WHERE user_id = $1`,
              [env.aggregateId]
            );
          }
        }
      }
    ]);

    // Create repository with inline projection, snapshot store, and async processor
    const userRepo = new Repository<UserAggregate, UserState, UserEvent, PgTx>(
      "User",
      uow,
      eventStore,
      (id, snap) => new UserAggregate(id, snap),
      {
        inlineProjector,
        snapshotStore,
        snapshotPolicy: { everyNEvents: 2 }, // Create snapshot after 2 events
        snapshotSchemaVersion: 1,
        asyncProcessor: { enabled: true, topic: "user" }
      }
    );

    // Register and activate user in the same transaction
    const user = await userRepo.load("user-1");
    user.register("john@example.com", "John Doe");
    user.activate(); // Both events will be saved in the same transaction

    // Save with forceSnapshot and enqueueOutbox to ensure snapshot is created and events are queued
    await userRepo.save(user, { forceSnapshot: true, enqueueOutbox: true, outboxTopic: "user" });

    // Verify events were created
    const events = await pool.query(
      `SELECT * FROM eventfabric.events WHERE aggregate_name = 'User' AND aggregate_id = 'user-1' ORDER BY aggregate_version`
    );
    expect(events.rowCount).toBe(2);
    expect(events.rows[0].type).toBe("UserRegistered");
    expect(events.rows[1].type).toBe("UserActivated");

    // Verify snapshot was created
    const snapshot = await pool.query(
      `SELECT * FROM eventfabric.snapshots WHERE aggregate_name = 'User' AND aggregate_id = 'user-1'`
    );
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.rows[0].aggregate_version).toBe(2);
    const snapshotState = snapshot.rows[0].state as UserState;
    expect(snapshotState.email).toBe("john@example.com");
    expect(snapshotState.displayName).toBe("John Doe");
    expect(snapshotState.activated).toBe(true);

    // Verify inline projection updated search table
    const searchRow = await pool.query(`SELECT * FROM user_search WHERE user_id = 'user-1'`);
    expect(searchRow.rowCount).toBe(1);
    expect(searchRow.rows[0].email).toBe("john@example.com");
    expect(searchRow.rows[0].display_name).toBe("John Doe");
    expect(searchRow.rows[0].activated).toBe(true);

    // Verify outbox was populated for async projection
    const outbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    expect(outbox.rowCount).toBe(2); // Both events should be in outbox

    // Set up async projection for email sending (abstracted)
    const sentEmails: Array<{ userId: string; email: string; eventType: string }> = [];
    const emailProjection = {
      name: "email-notification",
      topicFilter: { mode: "include" as const, topics: ["user"] },
      async handle(tx: PgTx, env: EventEnvelope<UserEvent>) {
        // Abstracted email sending - just record what would be sent
        if (env.payload.type === "UserRegistered") {
          sentEmails.push({
            userId: env.aggregateId,
            email: env.payload.email,
            eventType: "welcome"
          });
        } else if (env.payload.type === "UserActivated") {
          // Load the registered event to get email
          const registeredEvent = await eventStore.loadStream(tx, {
            aggregateName: "User",
            aggregateId: env.aggregateId,
            fromVersion: 1
          });
          const userRegistered = registeredEvent.find(e => e.payload.type === "UserRegistered");
          const email = userRegistered && userRegistered.payload.type === "UserRegistered" 
            ? userRegistered.payload.email 
            : "unknown@example.com";
          
          sentEmails.push({
            userId: env.aggregateId,
            email,
            eventType: "activation"
          });
        }
      }
    };

    // Process async projections
    const runner = createAsyncProjectionRunner<UserEvent>(pool, eventStore, [emailProjection], {
      workerId: "test-worker",
      batchSize: 10,
      transactionMode: "perRow",
      idleSleepMs: 50
    });

    const ac = new AbortController();
    const runnerPromise = runner.start(ac.signal).catch(() => {});

    // Wait for async processing
    let outboxCount = 2;
    const startTime = Date.now();
    while (outboxCount > 0 && Date.now() - startTime < 10000) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const remaining = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
      outboxCount = remaining.rows[0]?.count ?? 0;
      if (outboxCount === 0) break;
    }

    ac.abort();
    await runnerPromise;
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify emails were "sent" (recorded)
    expect(sentEmails.length).toBeGreaterThanOrEqual(2); // Should have welcome and activation emails
    const welcomeEmail = sentEmails.find(e => e.eventType === "welcome");
    const activationEmail = sentEmails.find(e => e.eventType === "activation");
    expect(welcomeEmail).toBeDefined();
    expect(welcomeEmail?.userId).toBe("user-1");
    expect(welcomeEmail?.email).toBe("john@example.com");
    expect(activationEmail).toBeDefined();
    expect(activationEmail?.userId).toBe("user-1");

    // Verify outbox was processed
    const finalOutbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    expect(finalOutbox.rowCount).toBe(0);
  }, 15000);

  it("loads user from snapshot and replays remaining events", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<UserEvent>();
    const snapshotStore = new PgSnapshotStore<UserState>("eventfabric.snapshots", 1);

    const inlineProjector = new InlineProjector<UserEvent, PgTx>([]);
    const userRepo = new Repository<UserAggregate, UserState, UserEvent, PgTx>(
      "User",
      uow,
      eventStore,
      (id, snap) => new UserAggregate(id, snap),
      {
        inlineProjector,
        snapshotStore,
        snapshotPolicy: { everyNEvents: 1 }
      }
    );

    // Create user with 2 events (triggers snapshot)
    const user1 = await userRepo.load("user-2");
    user1.register("jane@example.com", "Jane Smith");
    user1.activate();
    await userRepo.save(user1);

    // Verify snapshot exists
    const snapshot = await pool.query(
      `SELECT * FROM eventfabric.snapshots WHERE aggregate_name = 'User' AND aggregate_id = 'user-2'`
    );
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.rows[0].aggregate_version).toBe(2);

    // Add more events after snapshot
    const user2 = await userRepo.load("user-2");
    user2.register("jane.updated@example.com", "Jane Updated");
    await userRepo.save(user2);

    // Load should use snapshot and replay events after version 2
    const user3 = await userRepo.load("user-2");
    expect(user3.version).toBe(3);
    expect(user3.state.email).toBe("jane.updated@example.com");
    expect(user3.state.displayName).toBe("Jane Updated");
    expect(user3.state.activated).toBe(true); // From snapshot
  }, 10000);

  it("handles multiple events in single transaction with inline projection", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<UserEvent>();
    const snapshotStore = new PgSnapshotStore<UserState>("eventfabric.snapshots", 1);

    let projectionCalls: string[] = [];
    const inlineProjector = new InlineProjector<UserEvent, PgTx>([
      {
        name: "test-projection",
        async handle(tx: PgTx, env) {
          projectionCalls.push(`${env.payload.type}-${env.aggregateId}`);
        }
      }
    ]);

    const userRepo = new Repository<UserAggregate, UserState, UserEvent, PgTx>(
      "User",
      uow,
      eventStore,
      (id, snap) => new UserAggregate(id, snap),
      {
        inlineProjector,
        snapshotStore
      }
    );

    // Register and activate in same transaction
    const user = await userRepo.load("user-3");
    user.register("test@example.com", "Test User");
    user.activate();
    await userRepo.save(user);

    // Verify both events were processed by inline projection
    expect(projectionCalls).toContain("UserRegistered-user-3");
    expect(projectionCalls).toContain("UserActivated-user-3");
    expect(projectionCalls.length).toBe(2);
  }, 10000);

  it("retries failed email sending 3 times then moves to DLQ and removes from outbox", async () => {
    const uow = new PgUnitOfWork(pool);
    const eventStore = new PgEventStore<UserEvent>();
    const snapshotStore = new PgSnapshotStore<UserState>("eventfabric.snapshots", 1);

    const inlineProjector = new InlineProjector<UserEvent, PgTx>([]);
    const userRepo = new Repository<UserAggregate, UserState, UserEvent, PgTx>(
      "User",
      uow,
      eventStore,
      (id, snap) => new UserAggregate(id, snap),
      {
        inlineProjector,
        snapshotStore,
        asyncProcessor: { enabled: true, topic: "user" }
      }
    );

    // Register user - this will enqueue to outbox
    const user = await userRepo.load("user-dlq-test");
    user.register("dlq-test@example.com", "DLQ Test User");
    await userRepo.save(user);

    // Verify outbox has the message
    const initialOutbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    expect(initialOutbox.rowCount).toBe(1);
    const initialGlobalPosition = initialOutbox.rows[0].global_position;

    // Track email sending attempts
    let emailAttempts = 0;
    const emailErrors: string[] = [];

    // Email projection that fails for the first 3 attempts, then succeeds
    // But we'll set maxAttempts to 3, so it should DLQ before succeeding
    const emailProjection = {
      name: "email-notification-failing",
      topicFilter: { mode: "include" as const, topics: ["user"] },
      async handle(tx: PgTx, env: EventEnvelope<UserEvent>) {
        emailAttempts++;
        const errorMsg = `Email sending failed (attempt ${emailAttempts})`;
        emailErrors.push(errorMsg);
        throw new Error(errorMsg);
      }
    };

    // Process async projections with maxAttempts=3
    // Retry logic: claimBatch increments attempts when claiming, then processOne checks if attempts > maxAttempts
    // - First claim: attempts 0 -> 1, check: 1 > 3? No, process, fails, released
    // - Second claim: attempts 1 -> 2, check: 2 > 3? No, process, fails, released  
    // - Third claim: attempts 2 -> 3, check: 3 > 3? No, process, fails, released
    // - Fourth claim: attempts 3 -> 4, check: 4 > 3? Yes, DLQ without processing
    // So the message is attempted exactly 3 times (when attempts are 1, 2, 3) before being DLQ'd
    const runner = createAsyncProjectionRunner<UserEvent>(pool, eventStore, [emailProjection], {
      workerId: "dlq-test-worker",
      batchSize: 1,
      transactionMode: "perRow",
      maxAttempts: 3,
      idleSleepMs: 50
    });

    const ac = new AbortController();
    const runnerPromise = runner.start(ac.signal).catch(() => {});

    // Wait for the message to be processed through retries and moved to DLQ
    let outboxCount = 1;
    let dlqCount = 0;
    const startTime = Date.now();
    while ((outboxCount > 0 || dlqCount === 0) && Date.now() - startTime < 30000) {
      await new Promise(resolve => setTimeout(resolve, 300));
      
      const outbox = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox`);
      outboxCount = outbox.rows[0]?.count ?? 0;
      
      const dlq = await pool.query(`SELECT COUNT(*)::int AS count FROM eventfabric.outbox_dead_letters`);
      dlqCount = dlq.rows[0]?.count ?? 0;
      
      if (outboxCount === 0 && dlqCount === 1) break;
    }

    ac.abort();
    await runnerPromise;
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for final cleanup

    // Verify the message was retried 3 times before being DLQ'd
    // With maxAttempts=3, the message will be attempted when attempts are 1, 2, 3
    // Then on the 4th claim (attempts 4), it exceeds maxAttempts and is DLQ'd
    expect(emailAttempts).toBe(3); // Should be exactly 3 attempts before DLQ
    expect(emailErrors.length).toBe(3);

    // Verify the message is removed from outbox (cleaned from projection)
    const finalOutbox = await pool.query(`SELECT * FROM eventfabric.outbox`);
    expect(finalOutbox.rowCount).toBe(0);

    // Verify the message is in DLQ
    const dlqItems = await pool.query(
      `SELECT * FROM eventfabric.outbox_dead_letters WHERE global_position = $1`,
      [initialGlobalPosition]
    );
    expect(dlqItems.rowCount).toBe(1);
    
    const dlqItem = dlqItems.rows[0];
    expect(dlqItem.global_position).toBe(initialGlobalPosition);
    expect(dlqItem.topic).toBe("user");
    expect(Number(dlqItem.attempts)).toBeGreaterThanOrEqual(3);
    expect(dlqItem.last_error).toBeTruthy();
    expect(dlqItem.last_error).toContain("Email sending failed");
    expect(dlqItem.dead_lettered_at).toBeTruthy();

    // Verify the DLQ item has the correct reason
    expect(dlqItem.last_error).toMatch(/Exceeded maxAttempts=3|Email sending failed/);
  }, 35000);
});

