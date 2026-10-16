# Push notifications and land comparison: mobile integration

After **every** land verification (the user's own "Verify" tap or the weekly/monthly background check), the backend sends a push notification. Tapping it opens a screen that shows the **old record**, the **new record** and the **differences**.

All calls need `Authorization: Bearer <login token>`.

## 1. Register the device

Use Firebase Cloud Messaging (`firebase_messaging` / FCM SDK, project `bhoomiscan-a8d49`).

| When | Call |
|---|---|
| After login, and whenever FCM gives a new token (`onTokenRefresh`) | `POST /api/v1/devices` `{ "token": "<fcm token>", "platform": "android" \| "ios" \| "web" }` |
| On logout (before deleting the login token) | `DELETE /api/v1/devices` `{ "token": "<fcm token>" }` |

Calling register again with the same token is safe. If another account logs in on the same phone, the token moves to that account automatically.

Android: create a notification channel with id **`land_updates`** (the backend sends to that channel).

## 2. The push you receive

Visible part (`notification`), shown by the OS:

| Result | `title` | `body` example |
|---|---|---|
| No change | `Everything is good ✅` | `Abu Said: no changes since 12 Oct 2026.` |
| Changes | `Your land record has changed` | `Abu Said: 2 change(s) found. Tap to see old vs new.` |
| Important changes | `⚠️ Important change in your land record` | `Abu Said: 3 change(s) found (1 important). Tap to see old vs new.` |
| First verification | `Land record verified` | `Abu Said: record saved. We'll notify you if anything changes.` |

Data part (`data`, **all values are strings**), used to navigate:

```json
{
  "screen": "LAND_COMPARISON",
  "type": "LAND_CHANGED",               // LAND_VERIFIED | LAND_UNCHANGED | LAND_CHANGED
  "verificationId": "9b2f…",
  "snapshotId": "41c7…",
  "status": "CHANGED",                  // INITIAL | UNCHANGED | CHANGED
  "changes": "3",
  "critical": "3",
  "notificationId": "e0a1…"
}
```

On tap: open the comparison screen with `verificationId` and `snapshotId`.

## 3. Comparison screen data

`GET /api/v1/land-verification/{verificationId}/comparison?snapshotId={snapshotId}`

Leave out `snapshotId` to get the latest verification.

```json
{
  "success": true,
  "data": {
    "verificationId": "9b2f…",
    "land": { "displayName": "Khasra 14//6/2---1, abu said, ajnala, amritsar (2020 - 2021)", "state": "PUNJAB", "locator": { "district": "amritsar", "…": "…" } },
    "snapshotId": "41c7…",
    "status": "CHANGED",
    "hasChanges": true,
    "headline": { "title": "⚠️ Important change in your land record", "body": "Khasra 14//6/2---1, abu said, ajnala, amritsar (2020 - 2021): 3 change(s) found (3 important). Tap to see old vs new." },
    "verifiedAt": "2026-10-16T09:12:00.000Z",
    "previousVerifiedAt": "2026-10-09T09:12:00.000Z",
    "summary": { "total": 3, "added": 2, "removed": 1, "updated": 0, "critical": 3 },

    "old": { "snapshotId": "77aa…", "verifiedAt": "2026-10-09T09:12:00.000Z", "record": { "owner_details": [ { "owner_name": "manjit kaur", "…": "…" } ], "…": "…" } },
    "new": { "snapshotId": "41c7…", "verifiedAt": "2026-10-16T09:12:00.000Z", "record": { "owner_details": [ { "owner_name": "simran kaur", "…": "…" } ], "remarks": "mutation 1234 sanctioned", "…": "…" } },

    "changes": [
      { "field": "remarks", "section": "Remarks", "label": "Remarks", "type": "ADD",
        "oldValue": null, "newValue": "mutation 1234 sanctioned", "isCritical": true, "path": [{ "key": "remarks" }] },
      { "field": "owner_details[]", "section": "Owner details", "label": "Owner details", "type": "REMOVE",
        "oldValue": { "owner_name": "manjit kaur", "father_name": "harbans singh", "share": "1/2" }, "newValue": null, "isCritical": true, "path": [{ "key": "owner_details" }] },
      { "field": "owner_details[]", "section": "Owner details", "label": "Owner details", "type": "ADD",
        "oldValue": null, "newValue": { "owner_name": "simran kaur", "father_name": "harbans singh", "share": "1/2" }, "isCritical": true, "path": [{ "key": "owner_details" }] }
    ]
  }
}
```

### Suggested layout

1. **Header:** `headline.title` and `headline.body`, plus "Checked on `verifiedAt`".
2. **If `hasChanges` is false:** a green "Everything is good" state, then the current record (`new.record`). For `status = INITIAL`, `old` is `null`, so show only the saved record.
3. **If `hasChanges` is true:**
   - **Part 1, Differences:** one row per item in `changes` (they're already sorted with important ones first), grouped by `section`.
     - `UPDATE`: label, then old value ~~struck through~~ → new value
     - `ADD`: "Added", then `newValue`, in green
     - `REMOVE`: "Removed", then `oldValue`, in red
     - `isCritical`: an "Important" badge
     - `oldValue` / `newValue` can be text, a number or an object (for example a whole owner). Show an object's fields as a small card.
   - **Part 2, Full records:** a "Before" / "After" toggle or two tabs showing `old.record` and `new.record`.

Record keys are snake_case and differ by state. The same readable-label rule the server uses for `label` works for them too: underscores become spaces and the first letter is capitalised.

## 4. Inbox and missed pushes

Pushes can be missed (permission denied, phone off). Every notification is also kept here:

`GET /api/v1/notifications?page=1&limit=20` → `notifications[]` with `title`, `body`, `data`, `landVerificationId`, `snapshotId`, `createdAt`.

## 5. Error codes

| Call | Code | Meaning |
|---|---|---|
| comparison | `404 LAND_VERIFICATION_NOT_FOUND` / `SNAPSHOT_NOT_FOUND` | Not this user's land, or wrong id |
| devices | `422 VALIDATION_FAILED` | Token missing/too short, or platform not android/ios/web |
| any | `401` | Login expired, so log in again and re-register the device |
