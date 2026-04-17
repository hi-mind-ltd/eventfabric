import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  PgEventStore,
  PgSnapshotStore,
  PgDlqService,
  PgOutboxStatsService,
  SessionFactory,
  migrate
} from "@eventfabric/postgres";
import { UserAggregate, type UserState } from "../src/domain/user.aggregate";
import { UserRegistered, UserEmailChanged } from "../src/domain/user.events";
import type { UserEvent } from "../src/domain/user.events";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
let store: PgEventStore<UserEvent>;
let sessionFactory: SessionFactory<UserEvent>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);

  store = new PgEventStore<UserEvent>();
  sessionFactory = new SessionFactory<UserEvent>(pool, store);

  const snapshotStore = new PgSnapshotStore<UserState>();
  sessionFactory.registerAggregate(UserAggregate, [
    "UserRegistered",
    "UserEmailChanged"
  ], "user", { snapshotStore });
}, 120000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.snapshots`);
  await pool.query(`DELETE FROM eventfabric.outbox_dead_letters`);
  await pool.query(`DELETE FROM eventfabric.outbox`);
  await pool.query(`DELETE FROM eventfabric.projection_checkpoints`);
  await pool.query(`DELETE FROM eventfabric.stream_versions`);
  await pool.query(`DELETE FROM eventfabric.events`);
}, 60000);

// ============================================================================
// Helper
// ============================================================================

async function createUser(id: string, email: string, displayName: string) {
  const session = sessionFactory.createSession();
  session.startStream(id, UserRegistered({ userId: id, email, displayName }));
  await session.saveChangesAsync();
}

// ============================================================================
// POST /users/:id/register
// ============================================================================

describe("POST /users/:id/register", () => {
  it("creates a new user via startStream", async () => {
    const session = sessionFactory.createSession();
    session.startStream("user-1", UserRegistered({
      userId: "user-1",
      email: "alice@example.co.uk",
      displayName: "Alice"
    }));
    await session.saveChangesAsync();

    // Verify the user can be loaded
    const session2 = sessionFactory.createSession();
    const user = await session2.loadAggregateAsync<UserAggregate>("user-1");
    expect(user.id).toBe("user-1");
    expect(user.state.email).toBe("alice@example.co.uk");
    expect(user.state.displayName).toBe("Alice");
  });

  it("persists UserRegistered event in the event store", async () => {
    await createUser("user-evt", "bob@example.co.uk", "Bob");

    const { rows } = await pool.query(
      `SELECT type, payload FROM eventfabric.events WHERE aggregate_id = 'user-evt'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("UserRegistered");
    expect(rows[0].payload.email).toBe("bob@example.co.uk");
    expect(rows[0].payload.displayName).toBe("Bob");
  });

  it("rejects duplicate registration (stream already exists)", async () => {
    await createUser("user-dup", "first@example.co.uk", "First");

    const session = sessionFactory.createSession();
    session.startStream("user-dup", UserRegistered({
      userId: "user-dup",
      email: "second@example.co.uk",
      displayName: "Second"
    }));

    await expect(session.saveChangesAsync()).rejects.toThrow();
  });
});

// ============================================================================
// POST /users/:id/change-email
// ============================================================================

describe("POST /users/:id/change-email", () => {
  it("updates user email via aggregate command", async () => {
    await createUser("user-email", "old@example.co.uk", "Charlie");

    const session = sessionFactory.createSession();
    const user = await session.loadAggregateAsync<UserAggregate>("user-email");
    user.changeEmail("new@example.co.uk");
    await session.saveChangesAsync();

    // Verify
    const session2 = sessionFactory.createSession();
    const updated = await session2.loadAggregateAsync<UserAggregate>("user-email");
    expect(updated.state.email).toBe("new@example.co.uk");
    expect(updated.state.displayName).toBe("Charlie"); // unchanged
  });

  it("persists UserEmailChanged event", async () => {
    await createUser("user-email-evt", "original@example.co.uk", "Dana");

    const session = sessionFactory.createSession();
    const user = await session.loadAggregateAsync<UserAggregate>("user-email-evt");
    user.changeEmail("updated@example.co.uk");
    await session.saveChangesAsync();

    const { rows } = await pool.query(
      `SELECT type, payload FROM eventfabric.events WHERE aggregate_id = 'user-email-evt' ORDER BY global_position`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("UserRegistered");
    expect(rows[1].type).toBe("UserEmailChanged");
    expect(rows[1].payload.email).toBe("updated@example.co.uk");
  });

  it("supports multiple email changes in sequence", async () => {
    await createUser("user-multi", "v1@example.co.uk", "Eve");

    const session1 = sessionFactory.createSession();
    const user1 = await session1.loadAggregateAsync<UserAggregate>("user-multi");
    user1.changeEmail("v2@example.co.uk");
    await session1.saveChangesAsync();

    const session2 = sessionFactory.createSession();
    const user2 = await session2.loadAggregateAsync<UserAggregate>("user-multi");
    user2.changeEmail("v3@example.co.uk");
    await session2.saveChangesAsync();

    const session3 = sessionFactory.createSession();
    const final = await session3.loadAggregateAsync<UserAggregate>("user-multi");
    expect(final.state.email).toBe("v3@example.co.uk");
  });

  it("throws when user does not exist", async () => {
    const session = sessionFactory.createSession();
    await expect(
      session.loadAggregateAsync<UserAggregate>("non-existent")
    ).rejects.toThrow("aggregate class not found");
  });
});

// ============================================================================
// UserAggregate domain rules
// ============================================================================

describe("UserAggregate domain rules", () => {
  it("register sets email and displayName", () => {
    const user = new UserAggregate("user-test");
    user.register("test@example.co.uk", "Test User");

    expect(user.state.email).toBe("test@example.co.uk");
    expect(user.state.displayName).toBe("Test User");
  });

  it("changeEmail updates only email", () => {
    const user = new UserAggregate("user-test2");
    user.register("original@example.co.uk", "Original Name");
    user.changeEmail("changed@example.co.uk");

    expect(user.state.email).toBe("changed@example.co.uk");
    expect(user.state.displayName).toBe("Original Name");
  });

  it("register raises a UserRegistered event with version 2", () => {
    const user = new UserAggregate("user-evt-test");
    user.register("evt@example.co.uk", "Event User");

    const events = user.pullPendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "UserRegistered",
      version: 2,
      userId: "user-evt-test",
      email: "evt@example.co.uk",
      displayName: "Event User"
    });
  });

  it("changeEmail raises a UserEmailChanged event with version 1", () => {
    const user = new UserAggregate("user-evt-test2");
    user.register("before@example.co.uk", "Before");
    user.pullPendingEvents(); // clear register event

    user.changeEmail("after@example.co.uk");
    const events = user.pullPendingEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "UserEmailChanged",
      version: 1,
      userId: "user-evt-test2",
      email: "after@example.co.uk"
    });
  });
});

// ============================================================================
// Event factory functions
// ============================================================================

describe("event factory functions", () => {
  it("UserRegistered factory bakes in type and version", () => {
    const event = UserRegistered({ userId: "u1", email: "a@b.com", displayName: "A" });
    expect(event.type).toBe("UserRegistered");
    expect(event.version).toBe(2);
    expect(event.userId).toBe("u1");
    expect(event.email).toBe("a@b.com");
    expect(event.displayName).toBe("A");
  });

  it("UserEmailChanged factory bakes in type and version", () => {
    const event = UserEmailChanged({ userId: "u1", email: "new@b.com" });
    expect(event.type).toBe("UserEmailChanged");
    expect(event.version).toBe(1);
    expect(event.userId).toBe("u1");
    expect(event.email).toBe("new@b.com");
  });
});

// ============================================================================
// Ops: DLQ service
// ============================================================================

describe("ops: DLQ service", () => {
  it("lists empty DLQ", async () => {
    const dlq = new PgDlqService(pool);
    const result = await dlq.list({});
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("returns not-found when requeuing non-existent position", async () => {
    const dlq = new PgDlqService(pool);
    const result = await dlq.requeueByGlobalPosition(999999n);
    expect(result.requeued).toBe(false);
    expect(result.reason).toBe("DLQ item not found");
  });
});

// ============================================================================
// Ops: Outbox stats service
// ============================================================================

describe("ops: outbox stats service", () => {
  it("returns backlog stats on empty outbox", async () => {
    const stats = new PgOutboxStatsService(pool);
    const result = await stats.getBacklogStats();
    expect(result).toBeDefined();
  });

  it("reflects entries after events are created", async () => {
    await createUser("user-outbox", "outbox@example.co.uk", "Outbox User");

    const stats = new PgOutboxStatsService(pool);
    const result = await stats.getBacklogStats();
    expect(result).toBeDefined();
  });
});
