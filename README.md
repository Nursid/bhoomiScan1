# BhoomiScan API

A backend-only Node.js service for land-record verification. It provides:

* mobile OTP login (JWT)
* Razorpay subscriptions (monthly and quarterly)
* Surepass-backed land records for Punjab, Maharashtra and Bihar (each with its own hierarchy and fields)
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

Login works the same way as in the reference backend. The app runs the MSG91 widget's `sendOtp()`. The backend then verifies the OTP with MSG91 (`MSG91_WIDGET_ID`, `MSG91_TOKEN_AUTH`) and issues a JWT.

```bash
curl -X POST localhost:4000/api/auth/mobile-verify -H 'content-type: application/json' \
  -d '{"mobile":"917081002501","otp":"302348","reqId":"36697a704157303534313839"}'
curl localhost:4000/api/auth/me -H "Authorization: Bearer <token>"
```

### Full flow

1. Log in: `POST /api/auth/mobile-verify {mobile, otp, reqId}` returns a `token`.
2. Pick a plan: `GET /plans`.
3. Create a subscription: `POST /subscriptions/create {planCode}`.
4. Create a payment: `POST /payments/create {subscriptionId}` returns the details for Razorpay Checkout.
5. After checkout, call `POST /payments/verify {razorpay_order_id, razorpay_payment_id, razorpay_signature}`. The Razorpay webhook (`POST /payments/webhook`) also confirms the payment independently.
6. Browse locations. `GET /land-verification/states` describes each state's fields. Then call `GET /land-verification/<state>/districts` and the state's own lists:
   * punjab: `/tehsils`, `/villages`, `/years`, `/khasras`
   * maharashtra: `/talukas`, `/villages`, `/survey-numbers` (with a user-entered `survey_part_number`)
   * bihar: `/anchals`, `/lights`, `/mouzas` (then a user-entered `plot_number`)
7. Verify: `POST /land-verification/<state>/verify` with that state's own fields (see [docs/API_CURL.md](docs/API_CURL.md)). The first call returns `VERIFIED`. Later calls return `UNCHANGED`, or `CHANGED` with a change list and an alert.

A test form that builds itself from `GET /states` is served at `/land`. It asks for your login token; the Surepass token never leaves the server.
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

1. Add a client under `src/integrations/<provider>/`, built on `utils/httpClient`. For another Surepass state, extend `SurepassStateLandProvider` (`surepass-land.base.js`) and declare only the endpoint names and payload fields, as `surepass-maharashtra-land.provider.js` and `surepass-bihar-land.provider.js` do.
2. Add `src/modules/land-verification/providers/<state>-<provider>.adapter.js`, implementing the adapter contract. The contract is documented in `punjab-surepass.adapter.js`. Declare the state's `metadataLevels`, `filterSchemas`, `locatorSchema` and `fields` in its own terms; do not reuse another state's field names.
3. Register the adapter in `providers/registry.js`.

The routes (`/land-verification/<state>/...`), the storage, the diffing, the alerts, the anchoring and the scheduling then work for the new state without any changes.
