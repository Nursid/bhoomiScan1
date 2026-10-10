# BhoomiScan API: architecture

This document covers the analysis of the reference project, the architecture of this
service, and the reasons behind the main design choices.

---

## 1. Reference project analysis (`C:\test\third-party-Design_improvment`)

That project is a React Native app (TrustLedge / Destiny Protocol) with a backend in `server/`.

| Area | What the reference does |
|---|---|
| HTTP server | Plain `http.createServer` in `server/kycServer.js` (~2,200 lines) with a `'METHOD /path'` → handler map and a small `:param` matcher. Handlers have the signature `(body, context)`, where context is `{ headers, params, rawBody }`. |
| Response format | Handlers return `{ success: true, ... }`. Errors are thrown as `Object.assign(new Error(msg), { statusCode, success:false, details })`, and the dispatcher turns them into `{ success:false, message, details }`. |
| Auth | `authTokens.js`: HS256 JWT, `JWT_SECRET` of at least 32 characters, `requireAuth(context)` and `requireRole`. Login uses the MSG91 OTP widget (`mobileVerify.js` + `msg91Client.js`). The backend never stores an OTP. Mobile numbers are normalized to E.164 (India first). |
| Database | None. Plans and subscriptions are stored in JSON files, which are rewritten atomically. |
| Payments | `razorpayClient.js` uses `fetch` with Basic auth (no SDK) and a timing-safe HMAC check on webhooks. `subscriptions.js` uses Razorpay *Subscriptions* (recurring mandates), with webhook idempotency by event id and protection against stale events. |
| Land records | One client per state (`plrsClient.js` drives the Punjab portal through Playwright scraping; others for UP, MP and more). There is no provider abstraction, and `kycServer.js` calls each one directly. |
| Hashing / chain | `landHasher.js` produces canonical JSON and a SHA-256 hash in `bytes32` form. `blockchainService.js` calls the BSC `LandVerification` contract through ethers: `registerLandData`, plus decoding of the `DuplicateVerification` error. |
| Validation | Hand-written per module (no library). |
| Logging | `console.log` / `console.warn` with `[TAG]` prefixes. Mobile numbers are masked. The reference has secrets hardcoded in `kycServer.js` (Decentro/Meon fallbacks). That pattern was not carried over. |
| Tests | Jest unit tests for each module, with `fetch` mocked. |

## 2. What this service reuses (adapted, not copied)

| Reference | Here | Change |
|---|---|---|
| `authTokens.js` | `modules/auth/token.service.js` | The subject is the DB user id (uuid), not the mobile number. The same HS256, issuer and minimum secret length are kept. |
| `mobileVerify.normalizeMobile` | `utils/mobile.js` | Ported unchanged. |
| `mobileVerify.js` + `msg91Client.js` | `modules/auth/auth.service.js` + `integrations/msg91/msg91.client.js` | Same API (`POST /api/auth/mobile-verify`, `GET /api/auth/me`), same request, messages and response shape. The only difference is that the user is found or created in the `users` table, so `user.id` is a uuid. |
| `razorpayClient.js` (fetch + Basic + HMAC) | `integrations/razorpay/razorpay.client.js` | Uses the Orders API (one-off monthly/quarterly payments) instead of recurring mandates, and adds the checkout signature check plus a server-side payment fetch. |
| Webhook idempotency (`processedEvents`) | `payment_webhook_events` table | Unique key `(provider, event_id)`. An event that was stored but never processed is processed again. |
| `landHasher.canonicalizeJson` | `utils/canonicalJson.js` | Same idea. The land-specific field mapping moved into the normalizer. |
| `blockchainService.registerOnBlockchain` | `integrations/smart-contract/bsc.provider.js` | Exposed as one implementation of `SmartContractProvider`. |
| `{ success, ... }` + `statusCode` errors | `utils/errors.js`, `middleware/errorHandler.js` | Adds stable `code`s and `requestId`, and never returns internal messages. |

The following were deliberately **not** reused: the JSON-file storage (PostgreSQL replaces it), the 2,000-line
dispatcher (replaced by Express modules), the Playwright scraping (replaced by Surepass), and the hardcoded credentials.

## 3. Architecture

```
HTTP ─► routes ─► middleware (requestContext, rate limit, authenticate, requireActiveSubscription, validate)
            │
            ▼
        controller  (HTTP only: parse, call service, envelope)
            │
            ▼
        service     (business rules, transactions)          ◄── jobs/ (scheduler, worker) call services too
            │
            ▼
        provider / adapter  (state → provider mapping, e.g. Punjab → Surepass)
            │
            ▼
        integration client  (SurepassClient, Razorpay, MSG91, SmartContract)  ── utils/httpClient
            │                                                                    (timeout, retry,
            ▼                                                                     error mapping,
        external API                                                              audit log)
```

### Provider independence

`land-verification.service` only knows the **adapter contract** (`providers/punjab-surepass.adapter.js`):

```
stateCode, slug, provider, normalizerVersion
metadataLevels, filterSchemas, locatorSchema
listOptions(level, filters)      fetchRecord(locator)      normalizeRecord(raw)
diffOptions                      parcelIdentity(locator)   propertyId(locator)   displayName(locator)
```

Routes take a `:state` parameter (`/land-verification/punjab/verify`), and `providers/registry.js` resolves it to an adapter.
Metadata lists are `POST /:state/:level`. The level must exist in that adapter's `metadataLevels`; otherwise the
API answers 404 `METADATA_LEVEL_NOT_FOUND`.

### State-specific integrations (Punjab, Maharashtra, Bihar)

```
                     /land-verification/:state/...
                                  |
                         providers/registry.js
           +----------------------+----------------------+
           v                      v                      v
  punjab-surepass.adapter  maharashtra-surepass.adapter  bihar-surepass.adapter   <- state contract: hierarchy,
           |                      |                      |                          zod schemas, form fields,
           v                      v                      v                          identity, critical fields
  SurepassLandProvider   SurepassMaharashtraLand...  SurepassBiharLand...         <- endpoint paths + payloads
           +------------ extends SurepassStateLandProvider -------------+          (surepass-land.base.js)
                                  |
                           SurepassClient                                       <- token, base URL, error mapping
                                  |
                           utils/httpClient                                     <- timeout, retries, logging,
                                  |                                               request id, audit rows
                     https://kyc-api.surepass.app
```

| State | Lists (`metadataLevels`) | Locator (verify body) | Surepass |
|---|---|---|---|
| punjab | districts → tehsils → villages → years → khasras | district, tehsil, village, year, khasra_number | `/punjab/meta/{district,tehsil,village,year,khasra-number}-list`, `/punjab` |
| maharashtra | districts → talukas → villages → survey-numbers | district, taluka, village, survey_part_number, survey_number | `/maharashtra/meta/{district,taluka,village,survey-number}-list`, `/maharashtra` |
| bihar | districts → anchals → lights → mouzas | district, anchal, light, mouza, plot_number | `/bihar/meta/{district,anchal,light,mouza}-list`, `/bihar` |
| gujarat, madhya-pradesh, uttarakhand, delhi, andaman-and-nicobar, goa, chhattisgarh, telangana, sikkim, tripura | see `docs/API_CURL.md` §4 | per state | `/<slug>/meta/<list>`, `/<slug>` |

* The last ten are declarative: each `<state>-surepass.adapter.js` is a spec (levels → Surepass list
  names, field schemas, form fields) turned into a full adapter by `surepass-state-adapter.js`, using the
  shared `SurepassStateLandProvider` directly. The verify body is exactly the form fields, in order.

* Each state keeps its own vocabulary end to end: request schema, stored locator, parcel key, smart-contract
  property id (`PB:…`, `MH:…`, `BR:…`) and Surepass payload. No field is mapped onto another state's
  field (e.g. `survey_number` is never stored as `khasra_number`, and Bihar's `light` is used verbatim).
* Schemas are strict, so a field from another state is a 422. Child lists validate their parent fields
  before any provider call.
* `survey_part_number` and `plot_number` have no Surepass list endpoint, so they are free-text fields.
  None was invented.
* Verify responses share one application shape (`status`, `changes`, `record`, `source.state`, …). The
  untouched Surepass envelope is stored per snapshot (`rawResponse`, returned by
  `GET /:id/history/:snapshotId`). When a metadata or verify response has an unexpected shape, its
  structure (keys and types, no values) is logged as a warning.
* `GET /states` returns each state's `fields` (name, label, select/text, `dependsOn`, options endpoint).
  `land.html` (served at `/land`) renders the form from it, with no per-state UI code.
To add *Haryana → another provider*, write a new integration client plus one adapter file, and register it with one
line. No business logic, schema or route changes. Locators are stored as JSON, so each state can have its own fields.

### Verification pipeline

```
1 authenticate + requireActiveSubscription + zod locator validation
2 adapter.fetchRecord()                         (outside any DB transaction)
3 normalized = adapter.normalizeRecord(raw); hash = sha256(canonical(normalized))
4 BEGIN
    SELECT ... FOR UPDATE on the parcel row     (manual vs scheduled runs are serialized)
    previous = latest snapshot
    previousNormalized = adapter.normalizeRecord(previous.raw)    ← re-normalized with today's rules
    changes = hash equal ? [] : diffRecords(previousNormalized, normalized, diffOptions)
    INSERT snapshot (raw JSONB, normalized JSONB, hash, status INITIAL|UNCHANGED|CHANGED)
    INSERT changes; INSERT smart_contract_record (PENDING); INSERT alert if CHANGED
    UPDATE parcel (status, counters, next_verification_at)
  COMMIT
5 smart contract submit (inline once); on failure → FAILED + next_retry_at → retry job
6 respond
```

Re-normalizing the previous **raw** response (instead of trusting the `normalized_data` stored with it) means
that a change to the ignore list or the normalizer can never show up as a land-record change.

### Normalization and diff (no raw JSON string comparison)

`land-record-normalizer.js` produces the comparison form:

* Key names are unified: `ownerName`, `Owner Name` and `owner-name` all become `owner_name`.
* Strings are NFC-normalized, whitespace is collapsed, and text is lower-cased.
* `5` and `"5"` are equal, and `"1.50"` equals `"1.5"`.
* Empty placeholders (`""`, `-`, `NA`, `null`, `{}`, `[]`) are dropped, so "missing" and "empty" count as the same.
* Ignored fields are removed at any depth. These are the defaults plus `LAND_DIFF_IGNORED_FIELDS` plus adapter extras. An entry is either a key name or a dotted path.
* Arrays are sorted canonically, unless they are listed in `orderedArrays`.

`land-record-diff.service.js` compares nested objects and arrays:

* **Keyed arrays** (`arrayKeys`) are matched by identity, so `owners[name=x].share` produces an UPDATE.
* **Ordered arrays** are compared by index.
* All other arrays are treated as multisets, which produces ADD or REMOVE on `path[]`.

The engine emits `ADD`, `REMOVE` and `UPDATE`, and flags a change as `isCritical` when its path matches one of the
adapter's critical patterns (owner, share, area, khewat, mutation, ...). Any critical change makes the alert `CRITICAL`.

> The real shape of Surepass's Punjab response is not publicly documented. The normalizer is schema-agnostic,
> so it is correct for any shape. Once real payloads have been seen, set `arrayKeys` in the Punjab adapter
> (for example `owner_details: ['owner_name', 'father_name']`) to get field-level owner diffs instead of
> whole-item ADD/REMOVE.

### Smart contract resilience

```
PENDING ─► PROCESSING ─► STORED
                    ├──► ALREADY_STORED      (same hash anchored before, so the reference is reused; no second payment)
                    ├──► FAILED ─(backoff 30s·2ⁿ, max 6h)─► PROCESSING …
                    └──► PERMANENTLY_FAILED  (non-retryable, or SMART_CONTRACT_MAX_ATTEMPTS reached) + alert
SKIPPED when SMART_CONTRACT_PROVIDER=disabled
```

The land verification is committed **before** submission is attempted, so a smart-contract outage never loses
or fails a verification. Records are claimed with a conditional update plus a lease (`locked_until`), and a lease
left behind by a crashed worker expires and is picked up again. Owners can retry manually with
`POST /smart-contract/records/:id/retry`. Providers:

* `http`: an external REST API, with `Idempotency-Key = snapshot id`.
* `bsc`: the reference project's `LandVerification` contract via ethers.

### Payments

* `POST /subscriptions/create` creates a PENDING subscription. While it is unpaid, calling again for the same plan returns the same subscription.
* `POST /payments/create` creates a Razorpay order for **the stored amount**.
* `POST /payments/verify` does three things:
  1. Checks the checkout signature (`HMAC(order|payment, key_secret)`).
  2. Runs `GET /v1/payments/:id` at Razorpay and checks that order id, amount and currency match and the status is `captured` (an `authorized` payment is captured first).
  3. Calls `applyPaymentSuccess`.
* `POST /payments/webhook` uses the same path: signature over the **raw bytes**, an event-id dedupe table, and permanent mismatches acknowledged so Razorpay stops retrying.
* `applyPaymentSuccess` is idempotent. It does a conditional `updateMany` and activates the subscription in the same transaction, so the client's verify call and the webhook can race safely.
* Renewing early stacks the new period after the current one (`startsAt = current.endsAt`).
* Access is checked against the time window (`ACTIVE` and `startsAt <= now < endsAt`), so an expiry job that runs late can never extend access.

### Recurring verification (one generic model)

* `land_verifications.monitoring_enabled`, `verification_frequency` (`WEEKLY | MONTHLY | QUARTERLY`) and `next_verification_at` hold the schedule.
* `verification-schedule.js` is the only place that knows the period lengths.
* The job claims due parcels whose owner has a current subscription (`FOR UPDATE SKIP LOCKED` plus a lease) and re-runs the same `verify()` pipeline with `trigger = SCHEDULED`.
* On success, the next run is scheduled one period later. On failure, the job backs off 1h, 2h, 4h, ... up to 24h, and raises an alert after 3 consecutive failures, or straight away if a previously verified record disappears.
* The plan limits which frequencies can be used (`allowed_frequencies`) and how many parcels can be monitored (`max_monitored_lands`).

### Background jobs

`jobs/scheduler.js` runs three jobs on intervals in-process, or in a separate `npm run worker`:

* subscription expiry
* smart-contract retry
* recurring verification

Every job claims its rows in PostgreSQL, so it is safe to run on several instances. The queue is PostgreSQL-backed
on purpose: it is durable, there is nothing extra to operate, and the jobs are plain async functions that can be
moved to BullMQ later without changing the services. Redis is optional and is used only for the metadata cache.

---

## 4. Database schema (PostgreSQL, Prisma: `prisma/schema.prisma`)

| Table | Purpose | Notes |
|---|---|---|
| `users` | Mobile identity | `mobile` is unique and stored in E.164 form. Has `role` and `status` (blocked users are rejected on every request). |
| `subscription_plans` | Monthly and quarterly plans | Amount is stored in paise. Also holds `duration_months`, `allowed_frequencies[]` and `max_monitored_lands`. |
| `subscriptions` | Subscription history | `PENDING / ACTIVE / EXPIRED / CANCELLED / FAILED`. Stores the price at the time of purchase and the `starts_at` / `ends_at` window. |
| `payments` | Razorpay orders and payments | `CREATED / SUCCESS / FAILED / REFUNDED`. `provider_order_id` and `provider_payment_id` are unique. Only sanitized `provider_data` is kept. |
| `payment_webhook_events` | Webhook idempotency and audit | Unique `(provider, event_id)`. |
| `land_verifications` | A tracked parcel for a user | Unique `(user_id, state_code, parcel_key)`, where `parcel_key = sha256(normalized locator)`. Holds the locator as JSONB, the status, counters, the schedule and the job lease. |
| `land_record_snapshots` | Append-only history | Raw response and normalized data as JSONB, `hash`, `sequence`, `status`, `trigger`, `previous_snapshot_id`, `provider_reference` (the Surepass `client_id`), `normalizer_version`. |
| `land_record_changes` | Diff rows between consecutive snapshots | Type, field path, old and new values (JSONB), `is_critical`. |
| `smart_contract_records` | One per snapshot | Status, data hash, property id, request and external references, tx hash, network, block, response, error, attempts, `next_retry_at`, lease. |
| `alerts` | User events | Type, severity, `UNREAD / READ`, links to parcel and snapshot. |
| `api_request_logs` | Every outbound call | Provider, operation, path (never the host or query), sanitized bodies, status, duration, attempt, reference, error. |

## 5. API endpoints (`/api/v1`)

| Method | Path | Access |
|---|---|---|
| POST | `/api/auth/mobile-verify` (not under `/api/v1`) | public, rate-limited per mobile number and per IP |
| GET | `/api/auth/me` | auth |
| GET / PATCH | `/users/me` | auth |
| GET | `/plans` | public |
| POST | `/subscriptions/create` | auth |
| GET | `/subscriptions`, `/subscriptions/current` | auth |
| POST | `/subscriptions/:id/cancel` | auth (unpaid subscriptions only) |
| POST | `/payments/create`, `/payments/verify` | auth |
| POST | `/payments/webhook` | Razorpay signature |
| GET | `/payments` | auth |
| GET | `/land-verification/states` | auth |
| GET | `/land-verification/:state/districts` | auth + subscription |
| POST | `/land-verification/:state/:level`: punjab `tehsils` · `villages` · `years` · `khasras`; maharashtra `talukas` · `villages` · `survey-numbers`; bihar `anchals` · `lights` · `mouzas` | auth + subscription |
| POST | `/land-verification/:state/verify` | auth + subscription, rate-limited per user |
| GET | `/land-verification`, `/:id`, `/:id/history`, `/:id/history/:snapshotId`, `/:id/changes` | auth (history stays readable after a subscription ends) |
| PUT | `/land-verification/:id/monitoring` | auth (+ subscription to enable) |
| GET | `/smart-contract/records?landVerificationId=`, `/smart-contract/records/:id` | auth |
| POST | `/smart-contract/records/:id/retry` | auth |
| GET | `/alerts` | auth |
| PATCH | `/alerts/:id/read` | auth |
| POST | `/alerts/read-all` | auth |
| GET | `/health`, `/health/ready`, `/api/docs` | public |

## 6. Folder structure

```
src/
  app.js, server.js
  config/index.js                 zod-validated environment
  database/prisma.js
  routes/index.js                 /api/v1 router
  middleware/                     authenticate, requireActiveSubscription, validate, rateLimiters,
                                  requestContext, errorHandler
  utils/                          errors, logger (redacting), httpClient, apiAudit, cache, canonicalJson,
                                  mobile, dates, sanitize, response, requestContext
  integrations/
    surepass/                     surepass.client.js, surepass-land.base.js (shared state provider),
                                  surepass-land.provider.js (Punjab), surepass-maharashtra-land.provider.js,
                                  surepass-bihar-land.provider.js
    razorpay/                     razorpay.client.js
    msg91/                        msg91.client.js
    smart-contract/               index.js (factory), http.provider.js, bsc.provider.js
  modules/
    auth/                         routes, controller, service, token.service
    users/                        routes
    subscriptions/                routes (plans + subscriptions), service
    payments/                     routes, controller, service
    land-verification/            routes, controller, service, land-metadata.service,
                                  land-record-normalizer, land-record-ignore, land-record-diff.service,
                                  verification-schedule, providers/{registry, adapter-helpers,
                                  punjab-surepass.adapter, maharashtra-surepass.adapter, bihar-surepass.adapter}
    smart-contract/               routes, service
    alerts/                       routes, service
  jobs/                           scheduler, worker, recurring-verification.job
prisma/                           schema.prisma, migrations/, seed.js
docs/                             ARCHITECTURE.md, openapi.yaml, postman_collection.json
tests/unit, tests/integration
```

## 7. Environment variables

See `.env.example`, which documents every variable. Integrations whose credentials are missing stay disabled and
return `503` instead of crashing. In production, startup **fails** if `JWT_SECRET` is shorter than 32 characters, or if `DATABASE_URL` is missing.

## 8. Integration flows and error mapping

| Upstream | Condition | Our response |
|---|---|---|
| Surepass | 401 / 403 | `503 SUREPASS_AUTH_FAILED` (our credentials are wrong, not the user's) |
| | 429 | `429 SUREPASS_RATE_LIMITED` + `Retry-After` |
| | 404 or a "no record" message | `404 LAND_RECORD_NOT_FOUND` |
| | 400 / 422 (including HTTP 200 with `success:false`) | `422 SUREPASS_REJECTED_REQUEST` (the provider's message is passed through in `details`) |
| | 500 / 502 / 503 | `503 SUREPASS_UNAVAILABLE` |
| | 504 / timeout | `504 SUREPASS_TIMEOUT` |
| | network failure | `502 SUREPASS_UNREACHABLE` |
| Razorpay | 401 | `503 PAYMENT_PROVIDER_MISCONFIGURED` |
| | 429 | `429 PAYMENT_PROVIDER_RATE_LIMITED` |
| | 5xx / timeout | `502` / `504` |
| MSG91 | OTP rejected | `401` "Invalid or expired OTP" |
| | bad credentials | `503` |

Retries: metadata lists and Razorpay fetches retry on network errors, 429 and 5xx (exponential backoff that respects
`Retry-After`). The billable Surepass verify call is **not retried by default** (`SUREPASS_VERIFY_RETRIES=0`) and is never
retried after a timeout, because Surepass may already have processed and charged it.

---

## 9. Security review

| Control | Implementation |
|---|---|
| Secrets | Read from the environment only. No defaults for secrets. Never returned, logged or stored (`api_request_logs` keeps only sanitized ids, status and amounts; the integration tests checked this). |
| Logging | pino redaction of `authorization`, `cookie`, `otp`, `token`, `signature`, `password`, `secret`, `apiKey` and `privateKey` at any depth. Request logs contain method, path and status only (no bodies, no query strings). Mobile numbers are masked. |
| OTP | Never generated, stored or logged by us: the MSG91 widget sends it and MSG91 verifies it. The number MSG91 reports is cross-checked against the client's number. Verification is rate-limited per mobile number and per IP. |
| JWT | HS256 with a pinned algorithm, issuer check, expiry, and a user lookup on every request (blocked or deleted users are rejected). |
| Payments | Amounts come from the DB. Checkout signatures are checked, and the payment is fetched from Razorpay before activation. Webhook signatures are checked over the raw bytes. All comparisons are timing-safe. Activation is idempotent. |
| Authorization | Every query is scoped by `userId`. Another user's id returns 404 (no existence leak). This is covered by tests. |
| Input | Zod on every body, param and query. Unknown keys are rejected (`.strict()`). Body size is limited to 200 KB. |
| Transport | helmet, a CORS allow-list (`CORS_ORIGINS`), and `trust proxy` configurable for correct client IPs. |
| Errors | 5xx responses never include internal messages or stacks. Provider bodies are logged, not returned. |
| Rate limiting | Global per IP, OTP per mobile number and per IP, and land verify per user. |

**Known limits and next steps**

* The rate-limit store is per instance. Behind several instances, use a shared store (Redis) or a gateway.
* The `http` smart-contract provider treats a 2xx response as stored. If the real API confirms asynchronously, add a confirmation poller.
* With the `bsc` provider, if `tx.wait` times out after the transaction was broadcast, the retry gets `DuplicateVerification` and the record is marked `ALREADY_STORED`, but without the tx hash. A poller that reads the hash back on chain would close that gap.
* There are no admin endpoints for plans yet. Plans are seeded with `npm run db:seed`.
* Alert delivery (push, SMS, email) is a hook (`alerts.service.notify`). Only database storage and logging are implemented.
