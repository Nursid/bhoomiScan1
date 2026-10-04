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

```bash
curl -s http://localhost:4000/api/v1/land-verification/states -H "$AUTH"

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
