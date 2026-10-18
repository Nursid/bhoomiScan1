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

### Google login (Firebase)

Open `http://127.0.0.1:4000/login` (served by the API, so the token is stored in the same origin as `/land` and `/payment`). The page signs in with Google through Firebase, sends the Firebase ID token to `POST /api/auth/google {idToken}`, and gets the same `{ success, token, user }` response as mobile-verify. The backend verifies the ID token with Firebase Admin (`FIREBASE_PROJECT_ID`, optional `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for revocation checks) and finds the user by Firebase UID or registers a new `USER`.

Accounts are never merged by email. If another account already has the Google email, login returns `409 ACCOUNT_LINK_REQUIRED`; the user logs in with OTP and calls `POST /api/auth/google/link {idToken}` with their Bearer token. Every host that serves `/login` must be listed under Firebase console > Authentication > Settings > Authorized domains.

### Full flow

1. Log in: `POST /api/auth/mobile-verify {mobile, otp, reqId}` (or `POST /api/auth/google {idToken}`) returns a `token`.
2. Pick a plan: `GET /plans`.
3. Create a subscription: `POST /subscriptions/create {planCode}`.
4. Create a payment: `POST /payments/create {subscriptionId}` returns the details for Razorpay Checkout.
5. After checkout, call `POST /payments/verify {razorpay_order_id, razorpay_payment_id, razorpay_signature}`. The Razorpay webhook (`POST /payments/webhook`) also confirms the payment independently.
6. Browse locations. `GET /land-verification/states` describes each state's fields. Then call `GET /land-verification/<state>/districts` and the state's own lists:
   * punjab: `/tehsils`, `/villages`, `/years`, `/khasras`
   * maharashtra: `/talukas`, `/villages`, `/survey-numbers` (with a user-entered `survey_part_number`)
   * bihar: `/anchals`, `/lights`, `/mouzas` (then a user-entered `plot_number`)
   * gujarat, madhya-pradesh, uttarakhand, delhi, andaman-and-nicobar, goa, chhattisgarh, telangana, sikkim, tripura: see the table in [docs/API_CURL.md](docs/API_CURL.md)
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
| `npm run test:integration` | Requires explicit process-environment `TEST_DATABASE_URL` for disposable PostgreSQL database `bhoomiscan_test` (Neon supported). No fallback. Automatically applies migrations; tests truncate fixture tables. |
| `npm run prisma:migrate` / `prisma:deploy` / `db:seed` | Database |

### Safe Neon integration testing

Keep the existing application `DATABASE_URL` unchanged. A local PostgreSQL server is not required. First check for an existing isolated, disposable Neon test branch/database. Only if none is suitable, prepare a separate empty test project after approval; do not copy application data. The test database must be named `bhoomiscan_test` and use test-only credentials. Choose its direct (non-pooled) connection URL in Neon Console, preserve TLS settings, and use the `public` schema. The test role needs permission to apply migrations and truncate its test tables; it must not have access to application/production data.

Export `TEST_DATABASE_URL` only into the shell that launches Jest or the CI secret environment. The placeholder format is `postgresql://<test-role>:<encoded-password>@<test-endpoint>/bhoomiscan_test?sslmode=require&schema=public`. Do not paste credentials into command history, documentation, or Git. Merely adding the variable to `.env` does not configure integration setup: it intentionally does not load that file for URL selection. `.env.example` contains names/placeholders only for testing.

The shared guard in `tests/setup/test-database-url.js` runs before both migration setup and worker configuration. It rejects missing, malformed, non-PostgreSQL URLs and any database name other than exactly `bhoomiscan_test`. It never falls back to the application `DATABASE_URL`. Only the migration child and test workers receive the validated URL as their own `DATABASE_URL`; the application's environment file is unchanged.

**The name check cannot prove Neon project isolation.** Before approving execution, manually confirm the endpoint belongs to the disposable test project and the credentials cannot access application data. A database named `bhoomiscan_test` on an inappropriate endpoint must not be used.

After explicit approval for test-database access and destructive testing, run from the existing repository:

```powershell
npm run test:integration -- --selectProjects integration
```

This command applies all pending migrations automatically (`prisma migrate deploy`) and the integration fixtures issue `TRUNCATE ... RESTART IDENTITY CASCADE`, including dependent tables. All test data is disposable. No separate migration, reset, or seed command against the application `DATABASE_URL` is needed. Avoid `npm test` until the isolated test database is approved, since it includes integration tests. For safe checks without database access, use `npm run test:unit -- --selectProjects unit --runInBand`.

`tests/integration/uploaded-documents.test.js` prepares 17 database-backed cases for PDF/PNG upload and download, ownership, hashes, object references, duplicates, version history/concurrent successors, invalid files, legacy file references, storage/insert failures, lost insert responses, transaction recovery/reverts, and read-only verification. It uses the real application routes and Prisma with mocked Stratus and blockchain providers; it does not test live storage permissions or blockchain behavior. This suite has been prepared and syntax-checked only, not executed against Neon. Existing Neon branches may be used if independently confirmed isolated and disposable; a new project is not mandatory. Neither an unpooled application URL nor a branch label establishes isolation.

The 2026-10-17 safe local run passed 288 unit tests across 15 suites. This includes PDF and PNG round-trips through real routes and the real Stratus client with HTTP and Prisma mocked. It verifies application logic and reference/byte handling, not actual SQL commits, constraints, live bucket permissions, or blockchain receipts. Cross-series duplicate versions are rejected. After a definite unique/foreign-key insert rejection, only the attempted object is cleaned up; uncertain insert outcomes retain the object to avoid deleting a potentially committed file. Retained unreferenced objects may require reconciliation once database access is approved.

## Adding a state or provider

1. Add a client under `src/integrations/<provider>/`, built on `utils/httpClient`. For another Surepass state, extend `SurepassStateLandProvider` (`surepass-land.base.js`) and declare only the endpoint names and payload fields, as `surepass-maharashtra-land.provider.js` and `surepass-bihar-land.provider.js` do.
2. Add `src/modules/land-verification/providers/<state>-<provider>.adapter.js`, implementing the adapter contract. The contract is documented in `punjab-surepass.adapter.js`. Declare the state's `metadataLevels`, `filterSchemas`, `locatorSchema` and `fields` in its own terms; do not reuse another state's field names.
3. Register the adapter in `providers/registry.js`.

The routes (`/land-verification/<state>/...`), the storage, the diffing, the alerts, the anchoring and the scheduling then work for the new state without any changes.
