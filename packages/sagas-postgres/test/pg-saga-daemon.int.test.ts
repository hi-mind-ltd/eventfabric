import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  InMemorySagaCommandQueue,
  InMemorySagaTimerStore,
  sagaAsProjection,
  type Saga,
  type SagaReaction,
} from "@eventfabric/sagas";
import { PgSagaStateStore, sagasMigrations } from "../src";
import { PgEventStore, PgUnitOfWork, createProjectionDaemon, migrate, type PgTx } from "@eventfabric/postgres";

// Sagas fed by the ProjectionDaemon: events arrive in global_position order,
// never past the high water mark, so the saga's lastEventPos guard is sound.

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;

type Step = { type: "Step"; version: 1; flowId: string; label: string };
type FlowState = { labels: string[] };

let failOn: string | null = null;
const flowSaga: Saga<FlowState, Step> = {
  name: "Flow",
  version: 1,
  correlate: (env) => env.payload.flowId,
  startsNewInstance: () => true,
  initialState: () => ({ labels: [] }),
  reactToEvent(state, env): SagaReaction<FlowState> {
    if (env.payload.label === failOn) throw new Error(`cannot react to ${env.payload.label}`);
    return { newState: { labels: [...state.labels, env.payload.label] } };
  },
};

const store = new PgEventStore<Step>();
const stateStore = new PgSagaStateStore<FlowState>();
const sagaStores = () => ({
  stateStore,
  commandQueue: new InMemorySagaCommandQueue(),
  timerStore: new InMemorySagaTimerStore(),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  await migrate(pool, { extensions: [sagasMigrations] });
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  failOn = null;
  for (const t of [
    "eventfabric.saga_instances",
    "eventfabric.projection_dead_letters",
    "eventfabric.projection_checkpoints",
    "eventfabric.stream_versions",
    "eventfabric.events",
  ]) {
    await pool.query(`DELETE FROM ${t}`);
  }
}, 60000);

let streamSeq = 0;
/** Each step goes to its own stream, as in a real flow touching several aggregates. */
async function appendStep(flowId: string, label: string): Promise<void> {
  await new PgUnitOfWork(pool).withTransaction((tx) =>
    store.append(tx, {
      aggregateName: "Account",
      aggregateId: `acc-${streamSeq++}`,
      expectedAggregateVersion: 0,
      events: [{ type: "Step", version: 1, flowId, label }],
    })
  );
}

async function appendStepHeldOpen(flowId: string, label: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await store.append({ client, tenantId: "default" } as PgTx, {
    aggregateName: "Account",
    aggregateId: `acc-${streamSeq++}`,
    expectedAggregateVersion: 0,
    events: [{ type: "Step", version: 1, flowId, label }],
  });
  return async () => {
    await client.query("COMMIT");
    client.release();
  };
}

async function labels(flowId: string): Promise<string[] | undefined> {
  const inst = await new PgUnitOfWork(pool).withTransaction((tx) =>
    stateStore.load(tx, { sagaName: "Flow", instanceId: flowId, tenantId: "default" })
  );
  return inst?.state.labels;
}

describe("sagaAsProjection on the ProjectionDaemon", () => {
  it("applies an event that commits after a later one, in position order", async () => {
    const commitFirst = await appendStepHeldOpen("f-1", "withdrawn");
    await appendStep("f-1", "deposited");

    const daemon = createProjectionDaemon(pool, store, [sagaAsProjection(flowSaga, sagaStores())]);
    await daemon.runOnce();
    // The high water mark holds below the in-flight event, so the saga sees nothing yet.
    expect(await labels("f-1")).toBeUndefined();

    await commitFirst();
    for (let i = 0; i < 20 && (await labels("f-1"))?.length !== 2; i++) await daemon.runOnce();

    // On the outbox runner the "deposited" event would win, advance
    // lastEventPos, and "withdrawn" would then be dropped as "already applied".
    expect(await labels("f-1")).toEqual(["withdrawn", "deposited"]);
  });

  it("dead-letters a failing saga event, keeps going, and replays it out of order", async () => {
    await appendStep("f-1", "a");
    await appendStep("f-1", "poison");
    await appendStep("f-1", "c");
    failOn = "poison";

    const daemon = createProjectionDaemon(pool, store, [sagaAsProjection(flowSaga, sagaStores())], {
      maxAttempts: 2,
      backoff: { minMs: 1, maxMs: 1, factor: 1, jitter: 0 },
    });
    for (let i = 0; i < 20 && (await labels("f-1"))?.length !== 2; i++) {
      await daemon.runOnce();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await labels("f-1")).toEqual(["a", "c"]);

    const [dead] = await daemon.listDeadLetters({ projectionName: "saga:Flow" });
    expect(dead).toBeDefined();

    // Fixed: the replay bypasses the lastEventPos guard (the instance is
    // past this event because it failed, not because it was applied).
    failOn = null;
    expect(await daemon.replayDeadLetter(dead!.id)).toEqual({ replayed: true });
    expect(await labels("f-1")).toEqual(["a", "c", "poison"]);

    // lastEventPos did not move backwards.
    const inst = await new PgUnitOfWork(pool).withTransaction((tx) =>
      stateStore.load(tx, { sagaName: "Flow", instanceId: "f-1", tenantId: "default" })
    );
    const maxPos = (await pool.query(`SELECT MAX(global_position)::text AS m FROM eventfabric.events`)).rows[0].m;
    expect(inst!.lastEventPos).toBe(BigInt(maxPos));
  });

  it("several daemon instances apply each saga event exactly once", async () => {
    const flows = ["f-1", "f-2", "f-3"];
    for (let i = 0; i < 10; i++) for (const f of flows) await appendStep(f, `s${i}`);

    const daemons = [0, 1, 2].map(() =>
      createProjectionDaemon(pool, store, [sagaAsProjection(flowSaga, sagaStores())], { batchSize: 4 })
    );
    const done = async () => (await Promise.all(flows.map(labels))).every((l) => l?.length === 10);
    for (let i = 0; i < 50 && !(await done()); i++) {
      await Promise.all(daemons.map((d) => d.runOnce()));
    }

    for (const f of flows) {
      expect(await labels(f)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`));
    }
  });
});
