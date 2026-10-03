# BhoomiScan API

A backend-only Node.js service for land-record verification. It provides:

* mobile OTP login (JWT)
* Razorpay subscriptions (monthly and quarterly)
* Surepass-backed land records for Punjab
* historical snapshots with normalized change detection
* alerts
* smart-contract anchoring with retries
* weekly, monthly or quarterly recurring verification

Design and reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · API: [docs/openapi.yaml](docs/openapi.yaml) (Swagger UI at `/api/docs`) · Postman: [docs/postman_collection.json](docs/postman_collection.json)

## Stack

* Node 20+ with Express 5
* PostgreSQL with Prisma
* zod for validation
* pino for logging
* helmet, cors and express-rate-limit for HTTP hardening
* Redis (optional) for the metadata cache
* Jest and supertest for tests

## Quick start

```bash
cp .env.example .env              # fill in secrets; JWT_SECRET must be 32+ chars
docker compose up -d postgres     # PostgreSQL on localhost:5436
npm install
npx prisma migrate deploy         # or: npm run prisma:migrate (dev)
npm run db:seed                   # monthly / quarterly plans
npm run dev                       # http://localhost:4000
```

To log in during development, use `OTP_PROVIDER=mock`. The service then accepts `OTP_MOCK_CODE` and does not send an SMS. It refuses to start with this setting in production.

```bash
curl -X POST localhost:4000/api/v1/auth/send-otp   -H 'content-type: application/json' -d '{"mobile":"7081002501"}'
curl -X POST localhost:4000/api/v1/auth/verify-otp -H 'content-type: application/json' -d '{"mobile":"7081002501","otp":"123456"}'
```

### Full flow

1. Log in: `POST /auth/verify-otp` returns a `token`.
2. Pick a plan: `GET /plans`.
3. Create a subscription: `POST /subscriptions/create {planCode}`.
4. Create a payment: `POST /payments/create {subscriptionId}` returns the details for Razorpay Checkout.
5. After checkout, call `POST /payments/verify {razorpay_order_id, razorpay_payment_id, razorpay_signature}`. The Razorpay webhook (`POST /payments/webhook`) also confirms the payment independently.
6. Browse locations: `GET /land-verification/punjab/districts`, then `POST /tehsils`, `/villages`, `/years` and `/khasras`.
7. Verify: `POST /land-verification/punjab/verify`. The first call returns `VERIFIED`. Later calls return `UNCHANGED`, or `CHANGED` with a change list and an alert.
8. Optional: turn on recurring checks with `PUT /land-verification/:id/monitoring {enabled:true, frequency:"WEEKLY"}`.

## Scripts

| Command | |
|---|---|
| `npm run dev` / `npm start` | API (and jobs when `JOBS_ENABLED=true`) |
| `npm run worker` | Jobs only (run the API with `JOBS_ENABLED=false` when you scale out) |
| `npm test` | Unit + integration tests |
| `npm run test:unit` | No database needed |
| `npm run test:integration` | Needs PostgreSQL. Default `postgresql://bhoomiscan:bhoomiscan@localhost:5436/bhoomiscan_test`, override with `TEST_DATABASE_URL`. Migrations are applied automatically. |
| `npm run prisma:migrate` / `prisma:deploy` / `db:seed` | Database |

Create the test database once with `docker exec bhoomiscan-postgres psql -U bhoomiscan -c "CREATE DATABASE bhoomiscan_test;"`.

## Adding a state or provider

1. Add a client under `src/integrations/<provider>/`, built on `utils/httpClient`.
2. Add `src/modules/land-verification/providers/<state>-<provider>.adapter.js`, implementing the adapter contract. The contract is documented in `punjab-surepass.adapter.js`.
3. Register the adapter in `providers/registry.js`.

The routes (`/land-verification/<state>/...`), the storage, the diffing, the alerts, the anchoring and the scheduling then work for the new state without any changes.
