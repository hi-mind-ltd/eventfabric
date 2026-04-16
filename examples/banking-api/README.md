# Banking API Example

A comprehensive banking application example demonstrating event sourcing patterns with multiple aggregates, async projections, and email notifications.

## Features Demonstrated

- **Multiple Aggregates**: Account, Transaction, and Customer aggregates
- **Event Sourcing**: All state changes are captured as events
- **Snapshots**: Automatic snapshotting for performance optimization
- **Async Projections**: Email notifications sent asynchronously via outbox pattern
- **Eventual Consistency**: Multi-step workflows processed asynchronously via event chain
- **Topic Filtering**: Events routed to projections based on topics
- **Repository Pattern**: Clean aggregate persistence abstraction
- **Unit of Work**: Transaction management across multiple aggregates
- **Dead Letter Queue**: Failed message handling
- **Outbox Pattern**: Reliable event delivery

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Set up PostgreSQL database and set `DATABASE_URL`:
```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/banking_db"
```

3. Run migrations (if needed):
```bash
# The @eventfabric/postgres package will create tables automatically on first use
```

4. Build and run:
```bash
pnpm build
pnpm start
```

Or for development:
```bash
pnpm dev
```

## API Endpoints

### Customers

- `POST /customers/:id/register` - Register a new customer
- `PUT /customers/:id/email` - Update customer email
- `GET /customers/:id` - Get customer details

### Accounts

- `POST /accounts/:id/open` - Open a new account
- `POST /accounts/:id/open-with-stream` - Open a new account using Marten-style Session API (demonstrates typed events)
- `POST /accounts/:id/deposit` - Deposit money
- `POST /accounts/:id/withdraw` - Withdraw money
- `GET /accounts/:id` - Get account details
- `POST /accounts/:id/close` - Close an account

### Transactions

- `POST /transactions/:id/initiate` - Initiate a transaction
- `POST /transactions/:id/complete` - Complete a transaction
- `POST /transactions/:id/fail` - Mark transaction as failed
- `GET /transactions/:id` - Get transaction details

### Transfers

- `POST /transfers` - Transfer money between accounts (atomic operation - immediate consistency)
- `POST /transfers/eventual` - Transfer money between accounts (eventual consistency pattern)

### Operations

- `GET /ops/dlq` - View dead letter queue
- `POST /ops/dlq/requeue/global/:pos` - Requeue a failed message
- `GET /ops/outbox` - View outbox statistics

## Example Usage

### 1. Register a Customer
```bash
curl -X POST http://localhost:3001/customers/cust-1/register \
  -H "Content-Type: application/json" \
  -d '{"email": "john@example.com", "name": "John Doe", "phone": "+1234567890"}'
```

### 2. Open an Account
```bash
curl -X POST http://localhost:3001/accounts/acc-1/open \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust-1", "initialBalance": 1000, "currency": "USD"}'
```

### 2a. Open an Account with Session API (Marten-style)
```bash
curl -X POST http://localhost:3001/accounts/acc-1/open-with-stream \
  -H "Content-Type: application/json" \
  -d '{"customerId": "cust-1", "initialBalance": 1000, "currency": "USD"}'
```

This endpoint demonstrates the Marten-style Session API where:
- Events are typed (e.g., `AccountOpenedV1`, `AccountDepositedV1`)
- The aggregate class is automatically inferred from event types
- No need to pass transaction or aggregate class explicitly
- TypeScript provides full type safety

### 3. Deposit Money
```bash
curl -X POST http://localhost:3001/accounts/acc-1/deposit \
  -H "Content-Type: application/json" \
  -d '{"amount": 500}'
```

### 4. Transfer Money (Atomic)
```bash
curl -X POST http://localhost:3001/transfers \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "txn-1",
    "fromAccountId": "acc-1",
    "toAccountId": "acc-2",
    "amount": 200,
    "description": "Payment for services"
  }'
```

### 5. Transfer Money (Eventual Consistency)
```bash
curl -X POST http://localhost:3001/transfers/eventual \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "txn-2",
    "fromAccountId": "acc-1",
    "toAccountId": "acc-2",
    "amount": 150,
    "description": "Async payment"
  }'
```

This endpoint demonstrates eventual consistency:
1. **TransactionStarted** event is raised and saved to outbox
2. **WithdrawalProjection** processes TransactionStarted → performs withdrawal → raises **WithdrawalCompleted**
3. **DepositProjection** processes WithdrawalCompleted → performs deposit → raises **DepositCompleted**
4. **CompletionProjection** processes DepositCompleted → completes transaction → raises **TransactionCompleted**

Each step happens asynchronously via the outbox pattern, ensuring reliable processing even if services are temporarily unavailable.

## Email Notifications

The application includes an async projection that sends email notifications for:
- Transaction completions (to both sender and receiver)
- Transaction failures
- Account deposits
- Account withdrawals
- Account openings

Emails are processed asynchronously via the outbox pattern, ensuring reliable delivery even if the email service is temporarily unavailable.

## Architecture

```
┌─────────────┐
│   Express   │
│     API     │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│  Repository │────▶│  Event Store │
└─────────────┘     └──────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │    Outbox     │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Async Projection│
                    │    Runner      │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Email Projection│
                    └───────────────┘
```

## Key Concepts Demonstrated

1. **Aggregate Design**: Each aggregate (Account, Transaction, Customer) manages its own consistency boundary
2. **Event Sourcing**: All changes are events, enabling full audit trail and time travel
3. **CQRS**: Commands (write) and queries (read) are separated
4. **Outbox Pattern**: Ensures reliable delivery of events to async projections
5. **Topic-Based Routing**: Events are routed to projections based on topics
6. **Idempotency**: Projections are designed to be safely retryable
7. **Snapshots**: Performance optimization by storing aggregate state snapshots
