# Moving BhoomiScan from Neon PostgreSQL to Catalyst Data Store: assessment

Status: **2026-10-18: option C chosen, then paused.** Live tests on the BhoomiScan Development project found blockers (section 6). No application data has been written to Catalyst; Neon is unchanged. Done so far: schema mapping (`src/database/catalyst/schema.js`, `docs/CATALYST_TABLES.md`), read-only Neon export (`scripts/catalyst/export-neon.js`), Catalyst REST client and OAuth Self Client (`src/database/catalyst/client.js`, `scripts/catalyst/oauth-setup.js`).

## 1. What the app uses today

| | |
|---|---|
| Database | PostgreSQL on Neon, through Prisma (`src/database/prisma.js`) |
| Tables | 14 tables, 16 enums, 9 migrations |
| Database calls | 168 Prisma call sites across 20 files |
| Transactions | 6 multi-step transactions (payments, subscriptions, land verification) |
| PostgreSQL-only features | `FOR UPDATE SKIP LOCKED` job claiming (4 places), `SELECT … FOR UPDATE` (1), `pg_advisory_xact_lock` (1), `UPDATE … RETURNING` (2), upserts (3), case-insensitive search (9), `groupBy` / `SUM` aggregates (admin dashboard) |
| Data volume (Neon, 18 Oct) | ~550 rows: users 14, plans 3, subscriptions 5, payments 11, webhook events 10, lands 7, snapshots 9, changes 0, smart-contract records 9, alerts 1, notifications 3, device tokens 0, API logs 477; `uploaded_documents` not created yet |
| Largest stored value | Surepass raw response 4,427 characters (average 2,755) |

### Tables and the code that uses them

| Table | Purpose | Used by |
|---|---|---|
| users | accounts, roles, Firebase UID, admin password | authenticate middleware, auth, users, admin |
| subscription_plans | Monthly / Weekly plans | subscriptions |
| subscriptions | paid periods (start / end, status) | subscriptions, payments, admin dashboard |
| payments | Razorpay orders and results | payments, admin |
| payment_webhook_events | webhook de-duplication | payments |
| land_verifications | tracked parcels, monitoring schedule, job lease | land verification, recurring job, smart contract, admin |
| land_record_snapshots | every fetched record (raw + normalized JSON) | land verification, admin |
| land_record_changes | differences between snapshots | land verification |
| smart_contract_records | blockchain anchoring and retries | smart contract |
| uploaded_documents | document hashes, versions, Stratus keys | documents |
| alerts | change / failure / payment alerts | alerts, payments, admin |
| api_request_logs | outbound API audit (Surepass, Razorpay, MSG91) | utils/apiAudit |
| device_tokens, notifications | push notifications outbox | notifications |

Dependency order (parents first): users, subscription_plans → subscriptions → payments; users → land_verifications → land_record_snapshots → land_record_changes, smart_contract_records, alerts, notifications; users → device_tokens, uploaded_documents, api_request_logs; payment_webhook_events stands alone.

## 2. What Catalyst Data Store provides (official docs)

| Feature | Catalyst Data Store | Source |
|---|---|---|
| Primary key | auto `ROWID` (BigInt); no custom / UUID primary keys | [Columns](https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns) |
| Text | Var Char ≤ 255 chars; Text ≤ **10,000** chars; **no JSON type** | [Columns](https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns), [forum](https://forums.catalyst.zoho.com/portal/en/kb/articles/limit-of-text-data-type-in-catalyst-data-store) |
| DateTime | `YYYY-MM-DD HH:MM:SS`; milliseconds and time zone not documented | [Columns](https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns) |
| Unique | single-column `IsUnique` only (no multi-column unique documented) | [Columns](https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns) |
| Foreign key | to another table's `ROWID`, on delete Null / Cascade | [Columns](https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns) |
| Query size | **max 300 rows and max 20 columns per SELECT**; max 4 joins (INNER / LEFT) | [ZCQL](https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/llms-full.md) |
| Transactions | **not documented** (no BEGIN / COMMIT / ROLLBACK) | [ZCQL](https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/llms-full.md) |
| Row locking | **not documented** (no `FOR UPDATE`, no `SKIP LOCKED`, no advisory locks) | same |
| Upsert | **not documented** | same |
| Aggregates | COUNT / SUM / AVG with GROUP BY / HAVING: supported | same |
| Development limits | **5,000 rows per table, 25,000 rows per project**; 403 when exceeded | [forum](https://forums.catalyst.zoho.com/portal/en/kb/articles/api-limit-reached-error-403) |
| API quotas | per-project limits; 403 "API limit reached" | [forum](https://forums.catalyst.zoho.com/portal/en/kb/articles/api-limit-reached-error-403) |

## 3. What would break, and what replacing it would cost

| Today (PostgreSQL) | Where | Without transactions / locks | Risk |
|---|---|---|---|
| Payment success and subscription activation in **one transaction** | payments.service `applyPaymentSuccess` | money recorded but subscription not activated (or the reverse) if a step fails mid-way; needs a reconciliation job | **High (money)** |
| Per-user advisory lock | subscriptions.service | two payments landing together can create **overlapping paid periods** (the bug fixed earlier); needs a home-made lock table on a unique column, with expiry | **High (money)** |
| Snapshot + changes + blockchain record + alert + notification in one transaction | land-verification.service `verify` | half-written verifications (snapshot without its changes or alert); push sent for data that wasn't fully saved | High |
| `FOR UPDATE SKIP LOCKED` job claiming | recurring checks, blockchain retries, push outbox, document retries | the same parcel checked twice (2× Surepass cost), double pushes, double blockchain submissions | Medium–High |
| Webhook de-duplication via unique `(provider, event_id)` | payments | possible with a single unique column (`provider:event_id`) | Low |
| Compound uniques: `(user, state, parcel)`, `(user, data_hash)`, `(user, series, version)` | lands, documents | must combine into one unique text column | Low–Medium |
| UUID ids used in URLs and API responses | everywhere | keep the UUID in a unique Var Char column; references become UUID strings, so no database-enforced integrity | Medium |
| JSON columns (raw / normalized records, webhook payloads, alert data) | snapshots, payments, alerts | stored as text; a Surepass response over **10,000 chars fails**, so it needs File Store / Stratus overflow | Medium |
| Tables with more than 20 columns (land_verifications 28, uploaded_documents ~25) | land, documents | every full-row read needs 2 queries or SDK row fetches | Medium (latency) |
| Millisecond timestamps | renewal stacking, ordering, tests | second precision; ordering ties | Low–Medium |
| Development row caps | api_request_logs (477 already, grows on every API call) | hits 5,000 in development; logs must move or be pruned | Medium |
| Test suite (533 tests) | `tests/` | all integration tests use a disposable PostgreSQL; on Catalyst they'd hit API quotas and row caps, and there's no fast reset | High (quality) |

**Size of the rewrite:** all 168 call sites, 6 transactions and 9 raw SQL / locking sites, re-implemented on the Catalyst SDK with home-made locking, idempotency and reconciliation. Then rebuild the integration test strategy. This is a multi-week project, and the result would protect payments **less** than the current code does.

## 4. Options

| Option | Effort | Payment / data safety | Neon needed |
|---|---|---|---|
| **A. Stay on PostgreSQL** (keep Neon, or move to a closer region, e.g. Singapore, since AppSail is in India and Neon is in us-east-2) | small | unchanged | yes (or another managed PostgreSQL) |
| **B. Hybrid:** PostgreSQL for core data; Catalyst for non-critical data (API logs, push outbox) and File Store / Stratus for documents and large raw responses | moderate | unchanged for payments | yes |
| **C. Full move to Catalyst Data Store** (this brief) | multi-week | **reduced**: transactions and locks replaced by application-level workarounds | no |

Recommendation: **A** (or B if part of the goal is using more Catalyst services). C works technically, but it trades proven database guarantees around payments and subscriptions for home-made ones, and the data volume (~550 rows) gives no performance reason to move.

## 5. What C would need before starting (if chosen)
- Confirmation from Zoho Support of: transactions or atomic multi-row writes, conditional updates (compare-and-set), production row and API quotas for the plan you're on, and SDK use from AppSail (server-side auth).
- A Catalyst **development** environment for migration tests (subject to the 5,000-row cap).
- Agreement that the move happens in stages (lower-risk tables first, payments last), with Neon kept for rollback.

## 6. Live test results on the BhoomiScan project (Development, 18 Oct 2026)

Run against a throwaway table `zz_probe` (one unique Var Char column) through the REST API with the OAuth Self Client.

| Test | Result |
|---|---|
| Create tables and columns through the API | ✅ works (the column body must be an array), although the docs say console only |
| Several empty values in a unique column | ✅ allowed |
| A duplicate inserted after the first | ✅ rejected with `409 DUPLICATE_VALUE` |
| A batch insert containing one duplicate | ✅ whole batch rejected (all-or-nothing within one table) |
| ZCQL `UPDATE … WHERE` returns the changed rows | ✅ yes (empty list when nothing matched) |
| **10 simultaneous conditional UPDATEs of one row** | ❌ **1, 5 and 9 requests were each told they won**, so it is not atomic |
| **10 simultaneous inserts of the same unique value** | ❌ **1, 3, 10, 7 and 3 rows stored**, so unique is **not enforced under concurrency** |
| ROWID in JavaScript | ⚠️ larger than 2^53: `…69000` came back as `…69001`; must be treated as a string |
| OAuth access tokens | ⚠️ about 10 per refresh token per 10 minutes, then "Access Denied"; must be cached and shared |
| Short burst of traffic | ⚠️ some requests failed with network errors or timeouts |

**What this means:** Catalyst Data Store has no transactions, no atomic compare-and-set and no race-safe unique constraint, so it has **no building block for duplicate prevention or locking**. On Data Store alone, these protections all become best-effort:

- one user per mobile number
- one subscription period per payment
- each Razorpay webhook processed once
- each background job claimed by one worker

The brief requires concurrency-safe duplicate prevention for payments and webhooks, and that can't be met on Data Store alone.
