# Express API Example

A simple Express.js example demonstrating event sourcing patterns with the `@eventfabric/postgres` package.

## Features Demonstrated

- **Event Sourcing**: All state changes are captured as events
- **Repository Pattern**: Clean aggregate persistence abstraction
- **Snapshots**: Automatic snapshotting for performance optimization
- **Marten-style Session API**: Fluent API with typed events and automatic aggregate inference
- **Dead Letter Queue**: Failed message handling
- **Outbox Pattern**: Reliable event delivery

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Set up PostgreSQL database and set `DATABASE_URL`:
```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/example_db"
```

3. Build and run:
```bash
pnpm build
pnpm start
```

Or for development:
```bash
pnpm dev
```

## API Endpoints

### Users (Repository Pattern)

- `POST /users/:id/register` - Register a new user using Repository pattern
- `POST /users/:id/email` - Update user email using Repository pattern

### Users (Session API - Marten-style)

- `POST /users/:id/register-with-stream` - Register a new user using Session API with typed events
- `POST /users/:id/change-email-with-stream` - Update user email using Session API with typed events

### Operations

- `GET /ops/dlq` - View dead letter queue
- `POST /ops/dlq/requeue/global/:pos` - Requeue a failed message
- `GET /ops/outbox` - View outbox statistics

## Example Usage

### 1. Register a User (Repository Pattern)
```bash
curl -X POST http://localhost:3000/users/user-1/register \
  -H "Content-Type: application/json" \
  -d '{"email": "john@example.com", "displayName": "John Doe"}'
```

### 2. Register a User (Session API)
```bash
curl -X POST http://localhost:3000/users/user-1/register-with-stream \
  -H "Content-Type: application/json" \
  -d '{"email": "john@example.com", "displayName": "John Doe"}'
```

This endpoint demonstrates the Marten-style Session API where:
- Events are typed (e.g., `UserRegisteredV2`)
- The aggregate class is automatically inferred from event types
- No need to pass transaction or aggregate class explicitly
- TypeScript provides full type safety

### 3. Change Email (Repository Pattern)
```bash
curl -X POST http://localhost:3000/users/user-1/email \
  -H "Content-Type: application/json" \
  -d '{"email": "newemail@example.com"}'
```

### 4. Change Email (Session API)
```bash
curl -X POST http://localhost:3000/users/user-1/change-email-with-stream \
  -H "Content-Type: application/json" \
  -d '{"email": "newemail@example.com"}'
```

This endpoint demonstrates appending events to an existing stream using the Session API.

## Key Concepts Demonstrated

1. **Repository Pattern**: Traditional approach using `Repository.load()` and `Repository.save()`
2. **Session API**: Marten-style fluent API with typed events and automatic inference
3. **Event Sourcing**: All changes are events, enabling full audit trail
4. **Snapshots**: Performance optimization by storing aggregate state snapshots
5. **Outbox Pattern**: Ensures reliable delivery of events to async projections

## Comparison: Repository vs Session API

### Repository Pattern
```typescript
const user = await userRepo.load(id);
user.register(email, displayName);
await userRepo.save(user);
```

### Session API (Marten-style)
```typescript
const userRegistered: UserRegisteredV2 = {
  type: "UserRegistered",
  version: 2,
  userId: id,
  email,
  displayName
};
await session.startStream(id, userRegistered);
```

The Session API provides:
- **Type Safety**: Events are strongly typed
- **Automatic Inference**: Aggregate class inferred from event types
- **Transaction Management**: Handled automatically
- **Fluent API**: More concise and readable code
