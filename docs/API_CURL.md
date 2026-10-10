# BhoomiScan API: curl flow

Every response is wrapped in `{ "success": true, "data": ... }`. Errors come back as `{ "success": false, "error": { "code", "message" } }`.

---

## 0. Health

```bash
curl -s http://localhost:4000/health
curl -s http://localhost:4000/health/ready
```

## 1. Login (MSG91 OTP widget)

The app runs the MSG91 widget's `sendOtp()` and gets a `reqId`. The user then types the OTP.

**1.1 Verify OTP and get a token**

```bash
curl --location --request POST 'http://localhost:4000/api/auth/mobile-verify' \
  --header 'Content-Type: application/json' \
  --data-raw '{"mobile":"917081002501","otp":"302348","reqId":"36697a704157303534313839"}'
```

The response is `{ "success": true, "token": "...", "user": { "id", "mobile", "loginMethod", "lastLoginAt" } }`.

```bash
export TOKEN="<token>"
export AUTH="Authorization: Bearer $TOKEN"
```

**1.2 Who am I**

```bash
curl -s http://localhost:4000/api/auth/me -H "$AUTH"
```

**1.3 Profile with active subscription**

```bash
curl -s http://localhost:4000/api/v1/users/me -H "$AUTH"
```

**1.4 Update profile**

```bash
curl -s -X PATCH http://localhost:4000/api/v1/users/me -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Test User", "email": "test@example.com" }'
```

## 2. Plans & subscription

**2.1 List plans**

```bash
curl -s http://localhost:4000/api/v1/plans
```

**2.2 Create subscription** (`monthly` or `quarterly`)

```bash
curl -s -X POST http://localhost:4000/api/v1/subscriptions/create -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "planCode": "monthly" }'
```

```bash
export SUBSCRIPTION_ID="<data.subscription.id>"
```

**2.3 Current / history / cancel unpaid**

```bash
curl -s http://localhost:4000/api/v1/subscriptions/current -H "$AUTH"
curl -s http://localhost:4000/api/v1/subscriptions -H "$AUTH"
curl -s -X POST http://localhost:4000/api/v1/subscriptions/$SUBSCRIPTION_ID/cancel -H "$AUTH"
```

## 3. Payment (Razorpay)

**3.1 Create order**

```bash
curl -s -X POST http://localhost:4000/api/v1/payments/create -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "{ \"subscriptionId\": \"$SUBSCRIPTION_ID\" }"
```

```bash
export ORDER_ID="<data.checkout.orderId>"
```

Open Razorpay Checkout with `data.checkout`. It returns `razorpay_payment_id` and `razorpay_signature`.

**3.2 Verify payment** (activates the subscription)

```bash
curl -s -X POST http://localhost:4000/api/v1/payments/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d "{
    \"razorpay_order_id\": \"$ORDER_ID\",
    \"razorpay_payment_id\": \"pay_XXXXXXXXXXXXXX\",
    \"razorpay_signature\": \"<signature from checkout>\"
  }"
```

**3.3 Payment history**

```bash
curl -s http://localhost:4000/api/v1/payments -H "$AUTH"
```

**3.4 Webhook** (Razorpay sends this request, not the app; the signature must be valid)

```bash
BODY='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_XXXXXXXXXXXXXX","order_id":"'$ORDER_ID'","amount":59100,"currency":"INR","status":"captured"}}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" | awk '{print $2}')

curl -s -X POST http://localhost:4000/api/v1/payments/webhook \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIG" \
  -H "x-razorpay-event-id: evt_test_1" \
  -d "$BODY"
```

## 4. Land metadata (requires an active subscription)

Each state has its own hierarchy and field names. `GET /states` returns every
state's form fields in drill-down order. A child list is only accepted when all
of its parent fields are present; otherwise the API answers `422 VALIDATION_FAILED`
without calling Surepass.

| State | Hierarchy (metadata lists) | Verify body |
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

`survey_part_number` (Maharashtra), `plot_number` (Bihar, Sikkim), `owner_name`
(Gujarat), `khasra_number` (Chhattisgarh) and `khatian_number` (Tripura) are
typed by the user, because there is no (documented) Surepass list for them.
Every other field is a dropdown fed by the list before it. Each list's body is
exactly the fields before it in the verify body, e.g.

```bash
curl -s http://localhost:4000/api/v1/land-verification/goa/districts -H "$AUTH"

curl -s -X POST http://localhost:4000/api/v1/land-verification/goa/subdivision-numbers -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "kushavati", "taluka": "canacona", "village": "agonda", "survey_number": "28" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/tripura/moujas -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "উত্তর ত্রিপুরা/north tripura", "subdivision": "পানিসাগর/panisagar", "revenue_circle": "পানিসাগর/panisagar", "tehsil": "পানিসাগর/panisagar" }'
```

```bash
curl -s http://localhost:4000/api/v1/land-verification/states -H "$AUTH"
```

### Punjab

```bash

curl -s http://localhost:4000/api/v1/land-verification/punjab/districts -H "$AUTH"

curl -s -X POST http://localhost:4000/api/v1/land-verification/punjab/tehsils -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "amritsar" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/punjab/villages -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "amritsar", "tehsil": "ajnala" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/punjab/years -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "amritsar", "tehsil": "ajnala", "village": "abu said" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/punjab/khasras -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "amritsar", "tehsil": "ajnala", "village": "abu said", "year": "2020 - 2021" }'
```

### Maharashtra

```bash
curl -s http://localhost:4000/api/v1/land-verification/maharashtra/districts -H "$AUTH"

curl -s -X POST http://localhost:4000/api/v1/land-verification/maharashtra/talukas -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "पुणे" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/maharashtra/villages -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "पुणे", "taluka": "आंबेगाव" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/maharashtra/survey-numbers -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "पुणे", "taluka": "आंबेगाव", "village": "अडिवरे", "survey_part_number": "1" }'
```

### Bihar

```bash
curl -s http://localhost:4000/api/v1/land-verification/bihar/districts -H "$AUTH"

curl -s -X POST http://localhost:4000/api/v1/land-verification/bihar/anchals -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "araria" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/bihar/lights -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "araria", "anchal": "araria" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/bihar/mouzas -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "araria", "anchal": "araria", "light": "अररिया बस्ती" }'
```

## 5. Verify land

The first call returns `VERIFIED`. Later calls return `UNCHANGED`, or `CHANGED` along with the list of changes.

```bash
curl -s -X POST http://localhost:4000/api/v1/land-verification/punjab/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "district": "amritsar",
    "tehsil": "ajnala",
    "village": "abu said",
    "year": "2020 - 2021",
    "khasra_number": "14//6/2---1"
  }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/maharashtra/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "district": "पुणे",
    "taluka": "आंबेगाव",
    "village": "अडिवरे",
    "survey_part_number": "1",
    "survey_number": "1"
  }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/bihar/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "district": "araria",
    "anchal": "araria",
    "light": "अररिया बस्ती",
    "mouza": "अररिया बस्ती - 214/1",
    "plot_number": "1"
  }'

# The other states take their own verify body (see the table in section 4), e.g.
curl -s -X POST http://localhost:4000/api/v1/land-verification/gujarat/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "sabarkantha", "taluka": "prantij", "village": "kamalpur", "block": "14", "owner_name": "SHANUBHAI" }'

curl -s -X POST http://localhost:4000/api/v1/land-verification/telangana/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "adilabad", "mandal": "adilabad (rural)", "village": "ankapoor", "survey_number": "2/1", "khata_number": "1" }'
```

Invalid requests are rejected before Surepass is called, for example:

```bash
# Maharashtra without taluka -> 422, field "taluka"
curl -s -X POST http://localhost:4000/api/v1/land-verification/maharashtra/villages -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "district": "पुणे" }'

# Punjab field on a Bihar request -> 422 (unknown key)
curl -s -X POST http://localhost:4000/api/v1/land-verification/bihar/verify -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "district": "araria", "anchal": "araria", "light": "अररिया बस्ती", "mouza": "अररिया बस्ती - 214/1", "plot_number": "1", "khasra_number": "1" }'

# A list that does not exist for the state -> 404 METADATA_LEVEL_NOT_FOUND
curl -s -X POST http://localhost:4000/api/v1/land-verification/bihar/tehsils -H "$AUTH" \
  -H "Content-Type: application/json" -d '{ "district": "araria" }'
```

```bash
export VERIFICATION_ID="<data.verificationId>"
export SNAPSHOT_ID="<data.currentVerification>"
export SC_RECORD_ID="<data.smartContract.recordId>"
```

## 6. Records, history, changes

```bash
curl -s "http://localhost:4000/api/v1/land-verification?page=1&limit=20" -H "$AUTH"
curl -s http://localhost:4000/api/v1/land-verification/$VERIFICATION_ID -H "$AUTH"
curl -s http://localhost:4000/api/v1/land-verification/$VERIFICATION_ID/history -H "$AUTH"
curl -s http://localhost:4000/api/v1/land-verification/$VERIFICATION_ID/history/$SNAPSHOT_ID -H "$AUTH"
curl -s http://localhost:4000/api/v1/land-verification/$VERIFICATION_ID/changes -H "$AUTH"
curl -s "http://localhost:4000/api/v1/land-verification/$VERIFICATION_ID/changes?critical=true" -H "$AUTH"
```

## 7. Recurring verification

`frequency` is one of `WEEKLY`, `MONTHLY` or `QUARTERLY`.

```bash
curl -s -X PUT http://localhost:4000/api/v1/land-verification/$VERIFICATION_ID/monitoring -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "frequency": "WEEKLY" }'

curl -s -X PUT http://localhost:4000/api/v1/land-verification/$VERIFICATION_ID/monitoring -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

## 8. Smart contract

```bash
curl -s "http://localhost:4000/api/v1/smart-contract/records?landVerificationId=$VERIFICATION_ID" -H "$AUTH"
curl -s http://localhost:4000/api/v1/smart-contract/records/$SC_RECORD_ID -H "$AUTH"
curl -s -X POST http://localhost:4000/api/v1/smart-contract/records/$SC_RECORD_ID/retry -H "$AUTH"
```

## 9. Alerts

```bash
curl -s http://localhost:4000/api/v1/alerts -H "$AUTH"
curl -s "http://localhost:4000/api/v1/alerts?status=UNREAD" -H "$AUTH"
```

```bash
export ALERT_ID="<data.alerts[0].id>"
```

```bash
curl -s -X PATCH http://localhost:4000/api/v1/alerts/$ALERT_ID/read -H "$AUTH"
curl -s -X POST http://localhost:4000/api/v1/alerts/read-all -H "$AUTH"
```
