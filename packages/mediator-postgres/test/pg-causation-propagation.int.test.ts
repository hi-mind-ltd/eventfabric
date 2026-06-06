import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import {
  AggregateRoot,
  defineEvent,
  type HandlerMap,
} from "@eventfabric/core";
import {
  CommandBus,
  commandContextToEventMeta,
  type Command,
  type CommandHandler,
} from "@eventfabric/mediator";
import { PgIdempotencyStore, commandsMigrations } from "../src";
import {
  PgEventStore,
  PgUnitOfWork,
  SessionFactory,
  migrate,
  type PgTx,
} from "@eventfabric/postgres";

const TodoCreatedEvent = defineEvent("TodoCreated", 1);
const TodoCompletedEvent = defineEvent("TodoCompleted", 1);

type TodoCreated = { type: "TodoCreated"; version: 1; todoId: string; title: string };
type TodoCompleted = { type: "TodoCompleted"; version: 1; todoId: string };
type TodoEvent = TodoCreated | TodoCompleted;

type TodoState = { title?: string; completed?: boolean };

class TodoAggregate extends AggregateRoot<TodoState, TodoEvent> {
  static aggregateName = "Todo";
  protected handlers = {
    TodoCreated: (s: TodoState, e: TodoCreated) => {
      s.title = e.title;
      s.completed = false;
    },
    TodoCompleted: (s: TodoState) => {
      s.completed = true;
    },
  } satisfies HandlerMap<TodoEvent, TodoState>;

  constructor(id: string, snapshot?: TodoState) {
    super(id, snapshot ?? {});
  }

  create(title: string) {
    this.raise(TodoCreatedEvent.create<TodoCreated>({ todoId: this.id, title }));
  }

  complete() {
    this.raise(TodoCompletedEvent.create<TodoCompleted>({ todoId: this.id }));
  }
}

interface CreateTodoCommand extends Command<{ todoId: string; title: string }> {
  type: "CreateTodo";
}

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let pool: Pool;
let store: PgEventStore<TodoEvent>;
let factory: SessionFactory<TodoEvent>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool, { extensions: [commandsMigrations] });
  store = new PgEventStore<TodoEvent>();
  factory = new SessionFactory<TodoEvent>(pool, store);
  factory.registerAggregate(TodoAggregate, ["TodoCreated", "TodoCompleted"], "todo");
}, 60000);

afterAll(async () => {
  if (pool) await pool.end();
  if (container) await container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM eventfabric.events`);
  await pool.query(`DELETE FROM eventfabric.stream_versions`);
  await pool.query(`DELETE FROM eventfabric.outbox`);
  await pool.query(`DELETE FROM eventfabric.command_idempotency`);
});

describe("causation propagation through CommandBus + Session", () => {
  it("stamps causationId from the command and seeds correlationId on the persisted event", async () => {
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });

    bus.register({
      commandType: "CreateTodo",
      async handle(cmd: CreateTodoCommand, ctx) {
        const session = factory.createSession();
        session.startStream(
          cmd.payload.todoId,
          TodoCreatedEvent.create<TodoCreated>({
            todoId: cmd.payload.todoId,
            title: cmd.payload.title,
          })
        );
        await session.saveChangesAsync({ meta: commandContextToEventMeta(ctx) });
        return { todoId: cmd.payload.todoId };
      },
    } as CommandHandler<CreateTodoCommand, { todoId: string }, PgTx>);

    await bus.send({
      type: "CreateTodo",
      version: 1,
      payload: { todoId: "todo-1", title: "buy milk" },
      metadata: {
        commandId: "cmd-create-1",
        idempotencyKey: "idem-create-1",
        issuedAt: new Date().toISOString(),
      },
    } as CreateTodoCommand);

    const row = await pool.query(
      `SELECT correlation_id, causation_id FROM eventfabric.events WHERE aggregate_id = 'todo-1'`
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      correlation_id: "cmd-create-1",
      causation_id: "cmd-create-1",
    });
  });

  it("preserves an inbound correlationId across the command flow", async () => {
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });

    bus.register({
      commandType: "CreateTodo",
      async handle(cmd: CreateTodoCommand, ctx) {
        const session = factory.createSession();
        session.startStream(
          cmd.payload.todoId,
          TodoCreatedEvent.create<TodoCreated>({
            todoId: cmd.payload.todoId,
            title: cmd.payload.title,
          })
        );
        await session.saveChangesAsync({ meta: commandContextToEventMeta(ctx) });
      },
    } as CommandHandler<CreateTodoCommand, void, PgTx>);

    await bus.send({
      type: "CreateTodo",
      version: 1,
      payload: { todoId: "todo-2", title: "from upstream trace" },
      metadata: {
        commandId: "cmd-2",
        idempotencyKey: "idem-2",
        correlationId: "trace-from-edge",
        issuedAt: new Date().toISOString(),
      },
    } as CreateTodoCommand);

    const row = await pool.query(
      `SELECT correlation_id, causation_id FROM eventfabric.events WHERE aggregate_id = 'todo-2'`
    );
    expect(row.rows[0]).toMatchObject({
      correlation_id: "trace-from-edge",
      causation_id: "cmd-2",
    });
  });

  it("idempotent retry returns cached result and does not write a second event", async () => {
    // Sanity check: PG idempotency + Session integration. The handler must
    // run exactly once even though the bus is invoked twice with the same key.
    const bus = new CommandBus<PgTx>({
      uow: new PgUnitOfWork(pool),
      idempotencyStore: new PgIdempotencyStore(),
    });

    const handle = vi.fn(async (cmd: CreateTodoCommand, ctx) => {
      const session = factory.createSession();
      session.startStream(
        cmd.payload.todoId,
        TodoCreatedEvent.create<TodoCreated>({
          todoId: cmd.payload.todoId,
          title: cmd.payload.title,
        })
      );
      await session.saveChangesAsync({ meta: commandContextToEventMeta(ctx) });
      return { todoId: cmd.payload.todoId };
    });
    bus.register({
      commandType: "CreateTodo",
      handle,
    } as CommandHandler<CreateTodoCommand, { todoId: string }, PgTx>);

    const cmd: CreateTodoCommand = {
      type: "CreateTodo",
      version: 1,
      payload: { todoId: "todo-3", title: "buy bread" },
      metadata: {
        commandId: "cmd-3",
        idempotencyKey: "idem-3",
        issuedAt: new Date().toISOString(),
      },
    };

    const a = await bus.send<{ todoId: string }>(cmd);
    const b = await bus.send<{ todoId: string }>(cmd);
    expect(a).toEqual({ todoId: "todo-3" });
    expect(b).toEqual({ todoId: "todo-3" });
    expect(handle).toHaveBeenCalledTimes(1);

    const events = await pool.query(
      `SELECT COUNT(*)::int AS n FROM eventfabric.events WHERE aggregate_id = 'todo-3'`
    );
    expect(events.rows[0]!.n).toBe(1);
  });
});
