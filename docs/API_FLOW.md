# BhoomiScan API: complete flow with curl

Every endpoint in the order an app uses them: login → device → plan & payment → land verification → results, notifications and alerts. Each one has a curl example and what it means.

Field-level detail for push notifications and the comparison screen: [MOBILE_PUSH_NOTIFICATIONS.md](MOBILE_PUSH_NOTIFICATIONS.md). Full schema: `docs/openapi.yaml` (Swagger UI at `$BASE/api/docs`).

---

## 0. Setup

```bash
export BASE="https://bhoomiscan-api-50046525593.development.catalystappsail.in"
# after login (section 2):
export TOKEN="<token>"
export AUTH="Authorization: Bearer $TOKEN"
```

**Responses**
- `/api/v1/*` success: `{ "success": true, "data": { ... } }`. Paged lists add `"meta": { "page", "limit", "total", "totalPages" }`.
- `/api/auth/*` success: not wrapped, e.g. `{ "success": true, "token": "...", "user": { ... } }`.
- Every error: `{ "success": false, "message": "...", "error": { "code": "UPPER_SNAKE", "message": "...", "details": ... }, "requestId": "..." }`.

**Auth:** everything except health, `/api/auth/mobile-verify`, `/api/auth/google` and `/api/v1/plans` needs `Authorization: Bearer <token>`. The token lasts 7 days; after that the API answers `401 TOKEN_EXPIRED` and the user logs in again.

---

## 1. Health

```bash
curl -s $BASE/health          # process is up
curl -s $BASE/health/ready    # process + database are up (503 if the database is down)
```

---

## 2. Login

There are two ways to log in. Both return the same `{ success, token, user }`, and the `token` is used for every other call.

### 2.1 Mobile OTP

The app runs the MSG91 widget's `sendOtp()`, gets a `reqId`, and the user types the OTP. The backend checks the OTP with MSG91, then finds or creates the user.

```bash
curl -s -X POST $BASE/api/auth/mobile-verify \
  -H "Content-Type: application/json" \
  -d '{ "mobile": "917081002501", "otp": "302348", "reqId": "36697a704157303534313839" }'
```
```json
{ "success": true, "token": "eyJhbGciOi...", "user": { "id": "ee5b…", "mobile": "+917081002501", "name": "Jatin", "email": "jatin@example.com", "loginMethod": "mobile_otp", "isProfileCompleted": true, "lastLoginAt": "2026-10-16T06:00:00.000Z" }, "profile": { "complete": true, "missing": [] } }
```
`name` and `email` are the saved profile values (`null` until set with 2.6), so a new device can restore the profile right after login. `isProfileCompleted` equals `profile.complete`.

| Error | Meaning |
|---|---|
| `400 INVALID_MOBILE` / `INVALID_OTP_FORMAT` / `REQ_ID_REQUIRED` | bad input |
| `401 INVALID_OTP` | wrong or expired OTP |
| `403 ACCOUNT_BLOCKED` | account is blocked |
| `429 RATE_LIMITED` | too many attempts; wait `Retry-After` seconds |

### 2.2 Google (Firebase)

The app signs in with Google through the Firebase SDK and sends the **Firebase ID token** (`user.getIdToken()`). The backend verifies it with Firebase, then finds the user by Google account or creates one.

```bash
curl -s -X POST $BASE/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{ "idToken": "<Firebase ID token>" }'
```
```json
{ "success": true, "token": "eyJhbGciOi...", "user": { "id": "6f1c…", "mobile": null, "email": "you@gmail.com", "name": "Your Name", "loginMethod": "google", "isProfileCompleted": false, "lastLoginAt": "…" }, "profile": { "complete": false, "missing": ["mobile"] } }
```
| Error | Meaning |
|---|---|
| `400 ID_TOKEN_REQUIRED` | `idToken` missing or malformed |
| `401 ID_TOKEN_EXPIRED` | get a fresh one with `getIdToken(true)` and retry once |
| `401 INVALID_ID_TOKEN` / `ID_TOKEN_REVOKED` | sign out of Firebase and sign in again |
| `401 UNSUPPORTED_SIGN_IN_PROVIDER` | the token isn't from Google sign-in |
| `403 EMAIL_NOT_VERIFIED` / `FIREBASE_USER_DISABLED` / `ACCOUNT_BLOCKED` | not allowed |
| `409 ACCOUNT_LINK_REQUIRED` | this email already belongs to a mobile account; log in with OTP, then use 2.3 |

### 2.3 Link Google to an existing mobile account

The user must be logged in with OTP **and** prove the Google account. Afterwards, Google login (2.2) opens this same account with the same mobile number, plan and history.

```bash
curl -s -X POST $BASE/api/auth/google/link -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "idToken": "<Firebase ID token>" }'
```
```json
{ "success": true, "user": { "id": "ee5b…", "mobile": "+917081002501", "email": "you@gmail.com", "name": "Your Name", "googleLinked": true } }
```
`409 GOOGLE_ACCOUNT_IN_USE`: the Google account belongs to another user. `409 GOOGLE_ALREADY_LINKED`: a different Google account is already linked.

### 2.4 Who am I

```bash
curl -s $BASE/api/auth/me -H "$AUTH"
```
```json
{ "success": true, "user": { "id": "ee5b…", "mobile": "+917081002501", "email": null, "role": "user", "loginMethod": "mobile_otp" }, "expiresAt": "2026-10-23T06:00:00.000Z" }
```

### 2.5 Profile

```bash
curl -s $BASE/api/v1/users/me -H "$AUTH"      # user + current active subscription (or null)

curl -s -X PATCH $BASE/api/v1/users/me -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Test User", "email": "test@example.com" }'
```
Only `name` and `email` can be changed. `GET` also returns `profile` (see 2.6).

### 2.6 Complete the profile (after login)

Every login response (2.1, 2.2) and `GET /api/v1/users/me` include:
```json
"profile": { "complete": false, "missing": ["name", "mobile"] }
```
If `complete` is `false`, show a profile screen asking for the fields in `missing`.

| Signed up with | Required | Optional |
|---|---|---|
| Mobile OTP | `name` | `email` |
| Google | `name` (usually already filled from Google) and `mobile` | `email` |

**Mobile sign-up:** name, and an email if the user wants one.
```bash
curl -s -X PUT $BASE/api/v1/users/me/profile -H "$AUTH"   -H "Content-Type: application/json"   -d '{ "name": "Ram Kumar", "email": "ram@example.com" }'
```

**Google sign-up:** the mobile number must be **verified with an OTP**. Run the MSG91 widget's `sendOtp(mobile)` exactly as for mobile login, then send the number, the OTP and the `reqId`:
```bash
curl -s -X PUT $BASE/api/v1/users/me/profile -H "$AUTH"   -H "Content-Type: application/json"   -d '{ "name": "Asha Rao", "mobile": "917081002501", "otp": "302348", "reqId": "36697a704157303534313839" }'
```
```json
{ "success": true, "data": { "user": { "id": "6f1c…", "name": "Asha Rao", "mobile": "+917081002501", "email": "asha@gmail.com" }, "profile": { "complete": true, "missing": [] } } }
```
After this the user can log in **either** with Google **or** with that mobile number's OTP; both open the same account.

| Field | Rules |
|---|---|
| `name` | 2–100 characters; letters in any language (Hindi, Punjabi, …), spaces, `.` `'` `-`; extra spaces are trimmed |
| `email` | optional; valid email; `""` or `null` removes it |
| `mobile`, `otp`, `reqId` | only for accounts without a mobile number; same format as mobile login |

| Error | Meaning |
|---|---|
| `422 VALIDATION_FAILED` | a required field is missing or invalid; `error.details[].field` says which |
| `400 INVALID_MOBILE` / `INVALID_OTP_FORMAT` / `REQ_ID_REQUIRED` | mobile, OTP or reqId badly formatted |
| `401 INVALID_OTP` / `OTP_MOBILE_MISMATCH` | wrong or expired OTP, or the OTP was sent to a different number |
| `409 MOBILE_IN_USE` | that number already has its own account; log in with it (2.1) and link Google (2.3) |
| `409 MOBILE_ALREADY_SET` | the account already has a different mobile number |
| `429 RATE_LIMITED` | too many OTP attempts |

---

## 3. Register the device for push notifications

Call this after login, and again whenever Firebase gives the app a new FCM token. Without it the user gets no pushes; the inbox (section 7) still works.

```bash
curl -s -X POST $BASE/api/v1/devices -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "token": "<FCM registration token>", "platform": "android" }'     # android | ios | web
```
```json
{ "success": true, "data": { "device": { "id": "c1f0…", "platform": "ANDROID", "lastSeenAt": "…" } } }
```

On **logout**, remove it so this phone stops getting the user's pushes:
```bash
curl -s -X DELETE $BASE/api/v1/devices -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "token": "<FCM registration token>" }'
```
```json
{ "success": true, "data": { "removed": 1 } }
```

---

## 4. Plans and subscription

Land features need an **active plan**. Plans give **12 months** of access and differ by how often the land is checked automatically.

### 4.1 List plans (no login needed)

```bash
curl -s $BASE/api/v1/plans
```
| `code` | Price | Access | Auto-check frequency | Max monitored lands |
|---|---|---|---|---|
| `monthly` | ₹999 (`amount: 99900` paise) | 12 months | monthly | 5 |
| `weekly` | ₹1,499 (`amount: 149900` paise) | 12 months | weekly or monthly | 20 |

### 4.2 Current status (drives the subscription screen)

```bash
curl -s $BASE/api/v1/subscriptions/current -H "$AUTH"
```
```json
{
  "success": true,
  "data": {
    "status": "ACTIVE",
    "active":   { "id": "…", "status": "ACTIVE", "plan": { "code": "monthly", "…": "…" }, "startsAt": "2026-10-16T…", "endsAt": "2027-10-16T…", "activatedAt": "…", "isCurrent": true },
    "upcoming": [],
    "latest":   { "…": "last paid period, used when expired" },
    "pending":  null,
    "renewal":  { "allowed": false, "reason": "SUBSCRIPTION_ALREADY_ACTIVE", "paidUntil": "2027-10-16T…", "renewableFrom": "2027-09-16T…", "windowDays": 30, "planCode": "monthly" }
  }
}
```
| `status` | Meaning | What to show |
|---|---|---|
| `NONE` | never paid | plan list + Pay (4.3) |
| `PENDING` | subscription created, payment not confirmed | "Payment pending"; no access yet |
| `ACTIVE` | paid and inside the period | plan, `startsAt`, `endsAt`; Renew only when `renewal.allowed` is `true` (last 30 days) |
| `EXPIRED` | period ended | previous plan (`latest`) + Renew (4.4) |
| `CANCELLED` | refunded | previous plan + Renew |

`upcoming` lists periods that are already paid but haven't started yet (an early renewal). `renewal.planCode` is the plan that Renew uses by default.

### 4.3 Buy a plan (first time)

```bash
curl -s -X POST $BASE/api/v1/subscriptions/create -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "planCode": "monthly" }'
```
```json
{ "success": true, "data": { "subscription": { "id": "8bc8…", "status": "PENDING", "plan": { "…": "…" } }, "reused": false } }
```
This creates an unpaid `PENDING` subscription; it does **not** give access. Calling it again for the same plan returns the same subscription (`reused: true`). Next step: 5.1.

`409 SUBSCRIPTION_ALREADY_ACTIVE`: the user already has paid time beyond the renewal window. `error.details` has `paidUntil` and `renewableFrom`.

```bash
export SUBSCRIPTION_ID="<data.subscription.id>"
```

### 4.4 Renew

Renews the **last paid plan** by default. Send `planCode` to switch plans.

```bash
curl -s -X POST $BASE/api/v1/subscriptions/renew -H "$AUTH" \
  -H "Content-Type: application/json" -d '{}'

curl -s -X POST $BASE/api/v1/subscriptions/renew -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "planCode": "weekly" }'
```
Same response as 4.3; then pay with 5.1.

- **Before expiry** (only possible in the last 30 days): the new year starts when the current one ends, so no days are lost.
- **After expiry:** the new year starts at payment and access returns immediately.

| Error | Meaning |
|---|---|
| `409 SUBSCRIPTION_ALREADY_ACTIVE` | renewal isn't open yet (more than 30 days left) |
| `409 NOTHING_TO_RENEW` | never paid; use 4.3 |
| `409 PLAN_UNAVAILABLE` | the old plan is retired; send a `planCode` |

### 4.5 History and cancelling an unpaid one

```bash
curl -s $BASE/api/v1/subscriptions -H "$AUTH"                              # every period, newest first (renewal history)
curl -s -X POST $BASE/api/v1/subscriptions/$SUBSCRIPTION_ID/cancel -H "$AUTH"   # PENDING / FAILED only
```
A paid period can't be cancelled; it runs until `endsAt`.

---

## 5. Payment (Razorpay)

### 5.1 Create the Razorpay order

```bash
curl -s -X POST $BASE/api/v1/payments/create -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "{ \"subscriptionId\": \"$SUBSCRIPTION_ID\" }"
```
```json
{
  "success": true,
  "data": {
    "payment":  { "id": "…", "status": "CREATED", "amount": 99900, "currency": "INR", "orderId": "order_ToTRQKIOiJdwf9" },
    "checkout": { "keyId": "rzp_test_…", "orderId": "order_ToTRQKIOiJdwf9", "amount": 99900, "currency": "INR", "name": "BhoomiScan", "description": "Monthly subscription" },
    "reused": false
  }
}
```
Open Razorpay Checkout with `data.checkout`. The amount always comes from the server.
- **Calling it again within 30 minutes** returns the **same** order (`reused: true`), so a double tap can't create two payable orders.
- **Web:** pass `callback_url: "$BASE/api/v1/payments/callback"` to Checkout (see 5.3).

### 5.2 Verify the payment (activates the plan)

Send what Checkout returned. The backend checks the signature and asks Razorpay for the real status before activating anything.

```bash
curl -s -X POST $BASE/api/v1/payments/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "razorpay_order_id":   "order_ToTRQKIOiJdwf9",
    "razorpay_payment_id": "pay_ToTRy1FfFOhjEd",
    "razorpay_signature":  "<signature from checkout>"
  }'
```
```json
{ "success": true, "data": { "payment": { "status": "SUCCESS", "…": "…" }, "subscription": { "status": "ACTIVE", "startsAt": "…", "endsAt": "…" }, "alreadyProcessed": false } }
```
| Error | Meaning |
|---|---|
| `400 INVALID_PAYMENT_SIGNATURE` | the data was tampered with or isn't from Checkout |
| `400 PAYMENT_MISMATCH` | amount or order doesn't match |
| `402 PAYMENT_FAILED` | the payment failed |
| `409 PAYMENT_NOT_CAPTURED` | not complete yet; the webhook will finish it |

Calling verify twice is safe (`alreadyProcessed: true`).

### 5.3 Callback (called by Razorpay, not by the app)

`POST /api/v1/payments/callback` receives a form post from Razorpay when Checkout leaves the page (bank / 3-D Secure, blocked popup). It verifies the payment like 5.2, then redirects the browser to `/payment?status=success|pending|failed`. You only need to pass it as `callback_url` on web.

### 5.4 Webhook (called by Razorpay, not by the app)

`POST /api/v1/payments/webhook`, configured in the Razorpay dashboard with `RAZORPAY_WEBHOOK_SECRET`. Events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`. It activates the plan even if the user closed the app mid-payment, and replayed events are ignored.

```bash
# Simulating one locally (needs the webhook secret):
BODY='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_XXXXXXXXXXXXXX","order_id":"order_XXXXXXXXXXXXXX","amount":99900,"currency":"INR","status":"captured"}}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" | awk '{print $2}')
curl -s -X POST $BASE/api/v1/payments/webhook -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIG" -H "x-razorpay-event-id: evt_test_1" -d "$BODY"
```

### 5.5 Payment history

```bash
curl -s $BASE/api/v1/payments -H "$AUTH"
```

---

## 6. Land verification

### 6.1 States and their form fields

```bash
curl -s $BASE/api/v1/land-verification/states -H "$AUTH"
```
Lists every supported state with its fields in drill-down order: which fields are dropdowns (and which endpoint fills them), which are typed, and which fields each one depends on. Build the form from this.

| State | Dropdown lists (in order) | Verify body |
|---|---|---|
| punjab | districts → tehsils → villages → years → khasras | district, tehsil, village, year, khasra_number |
| maharashtra | districts → talukas → villages → survey-numbers | district, taluka, village, survey_part_number, survey_number |
| bihar | districts → anchals → lights → mouzas | district, anchal, light, mouza, plot_number |
| gujarat | districts → talukas → villages → blocks | district, taluka, village, block, owner_name |
| madhya-pradesh | districts → tehsils → villages → khasras | district, tehsil, village, khasra |
| uttarakhand | districts → tehsils → villages → years → khatas | district, tehsil, village, year, khata |
| delhi | districts → tehsils → villages → khata-numbers | district, tehsil, village, khata_no |
| andaman-and-nicobar | districts → tehsils → villages → survey-numbers | district, tehsil, village, survey_number |
| goa | districts → talukas → villages → survey-numbers → subdivision-numbers | district, taluka, village, survey_number, subdivision_number |
| chhattisgarh | districts → tehsils → villages | district, tehsil, village, khasra_number |
| telangana | districts → mandals → villages → survey-numbers → khata-numbers | district, mandal, village, survey_number, khata_number |
| sikkim | districts → subdivisions → revenue-circles → revenue-blocks | district, subdivision, revenue_circle, revenue_block, plot_number |
| tripura | districts → subdivisions → revenue-circles → tehsils → moujas | district, subdivision, revenue_circle, tehsil, mouja, khatian_number |

Typed by the user (no list): `survey_part_number` (Maharashtra), `plot_number` (Bihar, Sikkim), `owner_name` (Gujarat), `khasra_number` (Chhattisgarh), `khatian_number` (Tripura).

### 6.2 Dropdown lists (active plan required)

The first list is a GET; each later list is a POST whose body is every field chosen so far. Results are cached.

```bash
curl -s $BASE/api/v1/land-verification/punjab/districts -H "$AUTH"

curl -s -X POST $BASE/api/v1/land-verification/punjab/tehsils -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "district": "amritsar" }'

curl -s -X POST $BASE/api/v1/land-verification/punjab/villages -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "district": "amritsar", "tehsil": "ajnala" }'

curl -s -X POST $BASE/api/v1/land-verification/punjab/years -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "district": "amritsar", "tehsil": "ajnala", "village": "abu said" }'

curl -s -X POST $BASE/api/v1/land-verification/punjab/khasras -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "district": "amritsar", "tehsil": "ajnala", "village": "abu said", "year": "2020 - 2021" }'
```
```json
{ "success": true, "data": { "options": [ { "value": "Amritsar", "label": "Amritsar" } ], "count": 23, "cached": false } }
```
| Error | Meaning |
|---|---|
| `403 SUBSCRIPTION_REQUIRED` | no active plan |
| `422 VALIDATION_FAILED` | a parent field is missing (`details[].field` says which) |
| `404 STATE_NOT_SUPPORTED` / `METADATA_LEVEL_NOT_FOUND` | wrong state or list name |

### 6.3 Verify a land record (active plan required)

Fetches the official record, saves it as a new snapshot, compares it with the previous one, and **sends a push notification** (section 7).

```bash
curl -s -X POST $BASE/api/v1/land-verification/punjab/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "amritsar", "tehsil": "ajnala", "village": "abu said", "year": "2020 - 2021", "khasra_number": "14//6/2---1" }'
```
```json
{
  "success": true,
  "data": {
    "verificationId": "9b2f…",
    "status": "CHANGED",
    "snapshotStatus": "CHANGED",
    "isFirstVerification": false,
    "currentVerification": "41c7…",
    "previousVerification": "77aa…",
    "verifiedAt": "…", "previousVerifiedAt": "…",
    "changes": [ { "type": "ADD", "field": "remarks", "previousValue": null, "currentValue": "mutation 1234 sanctioned", "isCritical": true } ],
    "changeSummary": { "total": 3, "added": 2, "removed": 1, "updated": 0, "critical": 3 },
    "record": { "…": "the full current record" },
    "smartContract": { "status": "STORED", "transactionHash": "0x…" },
    "alertId": "…",
    "notificationId": "…"
  }
}
```
| `status` | Meaning | Push sent |
|---|---|---|
| `VERIFIED` | first time this land is checked; saved as the baseline | "Land record verified" |
| `UNCHANGED` | same as last time | "Everything is good ✅" |
| `CHANGED` | something changed; `changes` lists it and an alert is created | "Your land record has changed" / "⚠️ Important change…" |

`currentVerification` is the snapshot id (the `snapshotId` used in 6.5). Other errors: `422` invalid fields (rejected before calling the provider), `429` too many verifies, `404 LAND_RECORD_NOT_FOUND` when the record doesn't exist.

```bash
export VERIFICATION_ID="<data.verificationId>"
export SNAPSHOT_ID="<data.currentVerification>"
```

### 6.4 My lands, details, history

```bash
curl -s "$BASE/api/v1/land-verification?page=1&limit=20" -H "$AUTH"            # all my lands, last updated first
curl -s $BASE/api/v1/land-verification/$VERIFICATION_ID -H "$AUTH"              # one land + latest snapshot + latest changes
curl -s $BASE/api/v1/land-verification/$VERIFICATION_ID/history -H "$AUTH"      # every check (snapshot), newest first
curl -s $BASE/api/v1/land-verification/$VERIFICATION_ID/history/$SNAPSHOT_ID -H "$AUTH"   # one check incl. raw provider response
curl -s $BASE/api/v1/land-verification/$VERIFICATION_ID/changes -H "$AUTH"      # every change ever found
curl -s "$BASE/api/v1/land-verification/$VERIFICATION_ID/changes?critical=true" -H "$AUTH"  # important changes only
```

### 6.5 Comparison: old vs new vs differences (opened from a push)

```bash
curl -s $BASE/api/v1/land-verification/$VERIFICATION_ID/comparison -H "$AUTH"                         # latest check
curl -s "$BASE/api/v1/land-verification/$VERIFICATION_ID/comparison?snapshotId=$SNAPSHOT_ID" -H "$AUTH"  # a specific check
```
```json
{
  "success": true,
  "data": {
    "status": "CHANGED",
    "hasChanges": true,
    "headline": { "title": "⚠️ Important change in your land record", "body": "…: 3 change(s) found (3 important). Tap to see old vs new." },
    "summary": { "total": 3, "added": 2, "removed": 1, "updated": 0, "critical": 3 },
    "old": { "snapshotId": "77aa…", "verifiedAt": "…", "record": { "…": "previous record" } },
    "new": { "snapshotId": "41c7…", "verifiedAt": "…", "record": { "…": "current record" } },
    "changes": [
      { "field": "owner_details[]", "section": "Owner details", "label": "Owner details", "type": "REMOVE",
        "oldValue": { "owner_name": "manjit kaur", "share": "1/2" }, "newValue": null, "isCritical": true }
    ]
  }
}
```
- **Two parts:** `changes` is the list of differences (important ones first); `old.record` and `new.record` are the full records before and after.
- **`label`:** a readable name for the field, for example `Owners (Ram) › Share`.
- **No change:** `hasChanges: false`, `changes: []`, headline "Everything is good ✅".

Every field is explained in [MOBILE_PUSH_NOTIFICATIONS.md](MOBILE_PUSH_NOTIFICATIONS.md).

### 6.6 Automatic re-checks (monitoring)

Turn on to have the land re-checked automatically. Each re-check sends a push, like 6.3.

```bash
curl -s -X PUT $BASE/api/v1/land-verification/$VERIFICATION_ID/monitoring -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "enabled": true, "frequency": "WEEKLY" }'    # WEEKLY | MONTHLY | QUARTERLY

curl -s -X PUT $BASE/api/v1/land-verification/$VERIFICATION_ID/monitoring -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "enabled": false }'
```
| Error | Meaning |
|---|---|
| `403 SUBSCRIPTION_REQUIRED` | turning on needs an active plan (turning off never does) |
| `403 FREQUENCY_NOT_IN_PLAN` | the plan doesn't include that frequency (e.g. `WEEKLY` on `monthly`); `error.details.allowedFrequencies` lists what is allowed |
| `403 MONITORING_LIMIT_REACHED` | already monitoring the plan's maximum number of lands |

When the plan expires, re-checks pause; they resume automatically after renewal.

---

## 7. Notifications (inbox)

Every push is also stored here, so missed pushes aren't lost.

```bash
curl -s "$BASE/api/v1/notifications?page=1&limit=20" -H "$AUTH"
```
```json
{
  "success": true,
  "data": { "notifications": [ {
    "id": "e0a1…", "type": "LAND_UNCHANGED", "title": "Everything is good ✅", "body": "…: no changes since 9 Oct 2026.",
    "data": { "screen": "LAND_COMPARISON", "verificationId": "9b2f…", "snapshotId": "41c7…", "status": "UNCHANGED", "changes": 0, "critical": 0 },
    "landVerificationId": "9b2f…", "snapshotId": "41c7…", "delivery": "SENT", "createdAt": "…", "sentAt": "…"
  } ] },
  "meta": { "page": 1, "limit": 20, "total": 14, "totalPages": 1 }
}
```
- **`type`:** `LAND_VERIFIED`, `LAND_UNCHANGED` or `LAND_CHANGED`.
- **`delivery`:** `SENT`, `PENDING` (retrying), `FAILED`, or `SKIPPED` (no registered device, or push not configured on the server).
- **Opening one:** tapping an item opens 6.5 with its `landVerificationId` and `snapshotId`.

---

## 8. Alerts

Alerts are kept only for things that need attention: a land record changed, scheduled checks failing (3 times in a row, or the record disappeared), or blockchain anchoring failed.

```bash
curl -s $BASE/api/v1/alerts -H "$AUTH"                         # newest first, with unread count
curl -s "$BASE/api/v1/alerts?status=UNREAD" -H "$AUTH"         # filters: status=UNREAD|READ, landVerificationId, page, limit
```
```json
{ "success": true, "data": { "alerts": [ { "id": "…", "type": "LAND_RECORD_CHANGED", "severity": "CRITICAL", "title": "Land record changed", "message": "3 change(s) detected in …", "status": "UNREAD", "landVerificationId": "…", "snapshotId": "…", "createdAt": "…" } ], "unread": 1 }, "meta": { "…": "…" } }
```
```bash
export ALERT_ID="<data.alerts[0].id>"
curl -s -X PATCH $BASE/api/v1/alerts/$ALERT_ID/read -H "$AUTH"     # mark one read
curl -s -X POST $BASE/api/v1/alerts/read-all -H "$AUTH"           # mark all read -> { "updated": n }
```
| `type` | `severity` |
|---|---|
| `LAND_RECORD_CHANGED` | `CRITICAL` if an important field changed, else `WARNING` |
| `VERIFICATION_FAILED` | `WARNING`, or `CRITICAL` if the record disappeared |
| `SMART_CONTRACT_FAILED` | `WARNING` |

---

## 9. Blockchain proof (smart contract)

Every snapshot's hash is anchored on-chain as proof of what the record said at that time.

```bash
curl -s "$BASE/api/v1/smart-contract/records?landVerificationId=$VERIFICATION_ID" -H "$AUTH"   # one per snapshot
curl -s $BASE/api/v1/smart-contract/records/<recordId> -H "$AUTH"
curl -s -X POST $BASE/api/v1/smart-contract/records/<recordId>/retry -H "$AUTH"               # failed records only
```
Record `status`:
- `STORED` / `ALREADY_STORED`: anchored (same data anchored before)
- `PENDING` / `PROCESSING` / `FAILED`: in progress or retried automatically
- `PERMANENTLY_FAILED`: gave up; an alert was created
- `SKIPPED`: anchoring is turned off on the server

---

## 10. Common errors

| Status | Code | Meaning |
|---|---|---|
| 401 | `TOKEN_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | log in again |
| 403 | `ACCOUNT_BLOCKED` | account blocked |
| 403 | `SUBSCRIPTION_REQUIRED` | needs an active plan (section 4) |
| 404 | `*_NOT_FOUND` / `ROUTE_NOT_FOUND` | wrong id, not yours, or wrong URL |
| 409 | `CONFLICT` and the specific codes above | duplicate or not allowed in the current state |
| 422 | `VALIDATION_FAILED` | invalid input; `error.details[]` has `{ location, field, message }` |
| 429 | `RATE_LIMITED` | too many requests; wait `Retry-After` seconds |
| 500 | `INTERNAL_ERROR` | server error; quote `requestId` when reporting |
| 503 | `*_NOT_CONFIGURED` / `DATABASE_UNAVAILABLE` | a server setting or the database is unavailable |
