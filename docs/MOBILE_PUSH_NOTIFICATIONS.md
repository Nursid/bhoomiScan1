# Push notifications and land comparison API

**Base URL:** `https://bhoomiscan-api-50046525593.development.catalystappsail.in`

**Auth:** every endpoint needs `Authorization: Bearer <login token>` (from `/api/auth/mobile-verify` or `/api/auth/google`).

**When pushes are sent:** after every land verification, both manual (`POST /api/v1/land-verification/<state>/verify`) and scheduled (weekly/monthly monitoring). They go through Firebase Cloud Messaging, project `bhoomiscan-a8d49`.

---

## POST /api/v1/devices

Registers or refreshes the device's FCM token. Call it after login and whenever the FCM token changes. Calling it again with the same token is safe; a token registered by another account moves to the current account.

**Request**
```json
{ "token": "<FCM registration token>", "platform": "android" }
```
| Field | Type | Rules |
|---|---|---|
| `token` | string | 20–4096 characters, no spaces |
| `platform` | string | `android`, `ios` or `web` (any case) |

**Response `201`**
```json
{ "success": true, "data": { "device": { "id": "c1f0…", "platform": "ANDROID", "lastSeenAt": "2026-10-16T09:00:00.000Z" } } }
```

## DELETE /api/v1/devices

Unregisters the device. Call it on logout, before the login token is discarded.

**Request**
```json
{ "token": "<FCM registration token>" }
```

**Response `200`**
```json
{ "success": true, "data": { "removed": 1 } }
```
`removed` is `0` if the token wasn't registered to this user.

---

## Push message

### `notification` (shown by the OS)

| Result | `title` | `body` example |
|---|---|---|
| First verification | `Land record verified` | `Khasra 14//6/2---1, abu said, …: record saved. We'll notify you if anything changes.` |
| No change | `Everything is good ✅` | `Khasra 14//6/2---1, abu said, …: no changes since 12 Oct 2026.` |
| Changes | `Your land record has changed` | `…: 2 change(s) found. Tap to see old vs new.` |
| Important changes | `⚠️ Important change in your land record` | `…: 3 change(s) found (3 important). Tap to see old vs new.` |

Android: sent with `priority: high` on notification channel **`land_updates`**. iOS: `sound: default`.

### `data` (all values are strings)

```json
{
  "screen": "LAND_COMPARISON",
  "type": "LAND_CHANGED",
  "verificationId": "9b2f…",
  "snapshotId": "41c7…",
  "status": "CHANGED",
  "changes": "3",
  "critical": "3",
  "notificationId": "e0a1…"
}
```

| Key | Values |
|---|---|
| `screen` | always `LAND_COMPARISON` |
| `type` | `LAND_VERIFIED` (first time), `LAND_UNCHANGED`, `LAND_CHANGED` |
| `verificationId` | land verification id: path param of the comparison API |
| `snapshotId` | this verification result: `snapshotId` query param of the comparison API |
| `status` | `INITIAL`, `UNCHANGED`, `CHANGED` |
| `changes` / `critical` | number of differences / how many are important |
| `notificationId` | id in the inbox (`GET /api/v1/notifications`) |

---

## GET /api/v1/land-verification/{verificationId}/comparison

The old record, the new record and the differences for one verification.

| Param | In | Required | |
|---|---|---|---|
| `verificationId` | path | yes | from push `data.verificationId` |
| `snapshotId` | query | no | from push `data.snapshotId`; omit for the latest verification |

**Response `200`**
```json
{
  "success": true,
  "data": {
    "verificationId": "9b2f…",
    "land": {
      "displayName": "Khasra 14//6/2---1, abu said, ajnala, amritsar (2020 - 2021)",
      "state": "PUNJAB",
      "locator": { "district": "amritsar", "tehsil": "ajnala", "village": "abu said", "year": "2020 - 2021", "khasra_number": "14//6/2---1" }
    },
    "snapshotId": "41c7…",
    "sequence": 3,
    "status": "CHANGED",
    "hasChanges": true,
    "headline": {
      "title": "⚠️ Important change in your land record",
      "body": "Khasra 14//6/2---1, abu said, ajnala, amritsar (2020 - 2021): 3 change(s) found (3 important). Tap to see old vs new."
    },
    "verifiedAt": "2026-10-16T09:12:00.000Z",
    "previousVerifiedAt": "2026-10-09T09:12:00.000Z",
    "summary": { "total": 3, "added": 2, "removed": 1, "updated": 0, "critical": 3 },

    "old": {
      "snapshotId": "77aa…",
      "verifiedAt": "2026-10-09T09:12:00.000Z",
      "record": {
        "owner_details": [
          { "owner_name": "gurpreet singh", "father_name": "harbans singh", "share": "1/2" },
          { "owner_name": "manjit kaur", "father_name": "harbans singh", "share": "1/2" }
        ],
        "area": "0-12-5",
        "…": "…"
      }
    },
    "new": {
      "snapshotId": "41c7…",
      "verifiedAt": "2026-10-16T09:12:00.000Z",
      "record": {
        "owner_details": [
          { "owner_name": "gurpreet singh", "father_name": "harbans singh", "share": "1/2" },
          { "owner_name": "simran kaur", "father_name": "harbans singh", "share": "1/2" }
        ],
        "area": "0-12-5",
        "remarks": "mutation 1234 sanctioned",
        "…": "…"
      }
    },

    "changes": [
      {
        "field": "remarks", "section": "Remarks", "label": "Remarks", "path": [{ "key": "remarks" }],
        "type": "ADD", "oldValue": null, "newValue": "mutation 1234 sanctioned", "isCritical": true
      },
      {
        "field": "owner_details[]", "section": "Owner details", "label": "Owner details", "path": [{ "key": "owner_details" }],
        "type": "REMOVE", "oldValue": { "owner_name": "manjit kaur", "father_name": "harbans singh", "share": "1/2" }, "newValue": null, "isCritical": true
      },
      {
        "field": "owner_details[]", "section": "Owner details", "label": "Owner details", "path": [{ "key": "owner_details" }],
        "type": "ADD", "oldValue": null, "newValue": { "owner_name": "simran kaur", "father_name": "harbans singh", "share": "1/2" }, "isCritical": true
      }
    ]
  }
}
```

### Fields

| Field | Description |
|---|---|
| `status` | `INITIAL` (first verification, `old` is `null`), `UNCHANGED`, `CHANGED` |
| `hasChanges` | `true` when `changes` is non-empty |
| `headline` | same `title` and `body` as the push |
| `summary` | counts: `total`, `added`, `removed`, `updated`, `critical` |
| `old` | previous verification (`null` when `status` is `INITIAL`); `record` is the full normalized record |
| `new` | this verification; `record` is the full normalized record |
| `old.record` / `new.record` | keys are snake_case and differ by state |
| `changes[]` | the differences, important (`isCritical`) first, then by `field` |
| `changes[].type` | `UPDATE` (value changed), `ADD` (new value or item), `REMOVE` (value or item gone) |
| `changes[].oldValue` / `newValue` | text, number or object (for example a whole owner); `null` on the side that doesn't exist (`ADD` has no `oldValue`, `REMOVE` has no `newValue`) |
| `changes[].field` | machine path, for example `owners[name=Ram].share`, `rows[2].area`, `owner_details[]` |
| `changes[].label` | readable path, for example `Owners (Ram) › Share`, `Rows #3 › Area` |
| `changes[].section` | readable top-level group, for example `Owners` |
| `changes[].path` | parsed path parts: `{ key }`, `{ index }` (0-based) or `{ match }` |
| `changes[].isCritical` | important field for that state (owner, cultivator, remarks, …) |

**No-change example** (`status: "UNCHANGED"`): `hasChanges: false`, `changes: []`, `summary.total: 0`, `headline.title: "Everything is good ✅"`; `old.record` and `new.record` are equal.

**Errors**

| Status | `error.code` | When |
|---|---|---|
| 404 | `LAND_VERIFICATION_NOT_FOUND` | not this user's land, or unknown id |
| 404 | `SNAPSHOT_NOT_FOUND` | `snapshotId` doesn't belong to this land |
| 422 | `VALIDATION_FAILED` | `verificationId` or `snapshotId` is not a UUID |

---

## GET /api/v1/notifications

Inbox of every notification, newest first, including ones whose push wasn't delivered.

| Query | Default | |
|---|---|---|
| `page` | 1 | |
| `limit` | 20 | max 100 |

**Response `200`**
```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "id": "e0a1…",
        "type": "LAND_UNCHANGED",
        "title": "Everything is good ✅",
        "body": "Khasra 14//6/2---1, abu said, …: no changes since 9 Oct 2026.",
        "data": { "screen": "LAND_COMPARISON", "verificationId": "9b2f…", "snapshotId": "41c7…", "status": "UNCHANGED", "changes": 0, "critical": 0 },
        "landVerificationId": "9b2f…",
        "snapshotId": "41c7…",
        "delivery": "SENT",
        "createdAt": "2026-10-16T09:12:00.000Z",
        "sentAt": "2026-10-16T09:12:01.000Z"
      }
    ]
  },
  "meta": { "page": 1, "limit": 20, "total": 14, "totalPages": 1 }
}
```

Here `data.changes` and `data.critical` are numbers. They become strings only in the push.

`delivery` is one of:
- `SENT`: delivered to FCM
- `PENDING`: being retried
- `FAILED`: retries exhausted
- `SKIPPED`: no registered device, or push not configured on the server

---

## Common errors

| Status | When |
|---|---|
| 401 | missing or expired login token |
| 422 `VALIDATION_FAILED` | invalid body or params; `error.details` lists the fields |

Error shape: `{ "success": false, "message": "...", "error": { "code": "...", "message": "...", "details": [...] }, "requestId": "..." }`
