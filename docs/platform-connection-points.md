# YouTubeKit Server <-> Platform Connection Points

This file documents integration seams between this repository (`YouTubeKit-Server`) and `../YouTubeKit-Platform`.

## 1. Headers consumed by `youtubekit-server`
- Required: `X-AppID-v1`
- Optional: `X-API-Key`

Current behavior:
- Missing `X-AppID-v1` returns `400`.
- If `X-API-Key` is missing, app-level public limits apply.
- If `X-API-Key` is present, keyed limits apply through project-scoped DO state.

API key format (required):
- `ytk_<project_public_id>_<key_id>_<secret>`

## 2. Durable Object split (intentional)
1. App-level limiter (public/no-key)
- Class: `AppRateLimiter`
- File: `src/durable-objects/app-rate-limiter.ts`
- Counters: day/week
- Scope key: App ID

2. API-key limiter (keyed traffic)
- Class: `ApiKeyRateLimiter`
- File: `src/durable-objects/api-key-rate-limiter.ts`
- Counters:
  - Project-level: day/week/month
  - Per-key usage counters: day/week/month
- Scope key: project public ID
- Default free-tier limits are read inside this DO from Worker env (`FREE_API_KEY_*`).
- Policy model:
  - Supports optional project policy and optional key policy inputs.
  - Enforcement checks project policy first, then key policy.
  - Paid tiers are provided by synced project/key config (internal API below).

These limiters are intentionally separate and should not be merged.

## 3. Runtime routing seam
File: `src/index.ts`

Behavior:
- `/v1` websocket requests route to one of the two limiter DOs.
- No key -> `APP_RATE_LIMITER`.
- Key present -> `API_KEY_RATE_LIMITER` keyed by project ID from API key.

This is the primary server-side integration point for platform entitlements.

## 4. Internal API contract (platform -> server)
File: `src/index.ts`

Goal:
- `YouTubeKit-Platform` pushes project entitlements into `YouTubeKit-Server`.
- `YouTubeKit-Server` keeps live quota counters in Durable Objects and does request-time enforcement locally.
- No request-time lookup to platform storage is required.

Auth:
- Header: `X-Internal-Config-Token`
- Token source: `INTERNAL_CONFIG_API_TOKEN`

Endpoint:
- `PUT /internal/project-config`

Request body (full snapshot, idempotent by version):
```json
{
  "projectID": "proj_abc123",
  "version": 42,
  "projectPolicy": {
    "dailyLimit": 100000,
    "weeklyLimit": 500000,
    "monthlyLimit": 2000000
  },
  "keys": [
    {
      "keyID": "key_01",
      "secretHash": "7c4a8d09ca3762af61e59520943dc26494f8941b...",
      "status": "active",
      "keyPolicy": {
        "dailyLimit": 25000,
        "weeklyLimit": 100000,
        "monthlyLimit": 400000
      }
    },
    {
      "keyID": "key_02",
      "secretHash": "2c26b46b68ffc68ff99b453c1d30413413422f1...",
      "status": "revoked",
      "keyPolicy": {
        "dailyLimit": null,
        "weeklyLimit": null,
        "monthlyLimit": null
      }
    }
  ]
}
```

Apply rules:
- `projectID` maps to `API_KEY_RATE_LIMITER.idFromName(projectID)`.
- Incoming payload is a full replace snapshot for that project.
- Durable Object only applies when `version > current_version`.
- If applied:
  - replace project policy fields,
  - upsert all listed keys,
  - remove keys not present in payload.

Success response:
```json
{
  "ok": true,
  "applied": true,
  "projectID": "proj_abc123",
  "version": 42
}
```

Stale response:
```json
{
  "ok": true,
  "applied": false,
  "projectID": "proj_abc123",
  "version": 42,
  "currentVersion": 43
}
```

## 5. Runtime admit contract (server -> API-key limiter DO)
Method: `admit(payload)`

Payload shape:
```ts
{
  cost?: number;        // default 1
  nowMs?: number;       // default Date.now()
  keyID: string;        // required
  keySecret: string;    // required
}
```

Admit behavior:
- Load active project config from same Durable Object.
- Reject when key does not exist, is revoked, or hash does not match (`401` from server layer).
- Enforce in this order:
  1. project limits (day/week/month),
  2. optional key limits (day/week/month).
- Increment project counters and key counters atomically when allowed.
- No minute caps.

## 6. Usage access seam (server API)
File: `src/index.ts`

Endpoint:
- `GET /internal/usage`

Auth:
- Header: `X-Internal-Usage-Token`
- Token source: `INTERNAL_USAGE_API_TOKEN`

Query modes:
- `kind=project&projectID=<project_public_id>[&keyID=<key_id>]`
- `kind=key&apiKey=<raw-api-key>`

Response:
- Current counters and remaining quota from `ApiKeyRateLimiter` Durable Object state.

## 7. API-key limiter Durable Object storage contract
File: `src/durable-objects/api-key-rate-limiter.ts`

Tables:
1. `project_config`
- `id INTEGER PRIMARY KEY CHECK (id = 1)`
- `version INTEGER NOT NULL`
- `daily_limit INTEGER NULL`
- `weekly_limit INTEGER NULL`
- `monthly_limit INTEGER NULL`
- `updated_at_ms INTEGER NOT NULL`

2. `key_config`
- `key_id TEXT PRIMARY KEY`
- `secret_hash TEXT NOT NULL`
- `status TEXT NOT NULL` (`active` or `revoked`)
- `daily_limit INTEGER NULL`
- `weekly_limit INTEGER NULL`
- `monthly_limit INTEGER NULL`
- `updated_at_ms INTEGER NOT NULL`

3. `project_limiter_state`
- existing day/week/month counters (already used for project usage)

4. `key_limiter_state`
- existing day/week/month counters per key ID (already used for per-key usage)

Secret hash rules:
- Store only hash, never plaintext secret.
- Platform computes hash before sync and sends `secretHash`.
- Current expected hash algo: SHA-256 hex digest of secret string.
- Optional future hardening: server-side pepper for hash derivation.

## 8. Implementation split
In this repository (`YouTubeKit-Server`):
- Keep admission and usage counting in Durable Objects.
- Add/maintain internal config sync endpoint.
- Enforce keyed quotas from synced config.

In `../YouTubeKit-Platform`:
- Source of truth for users, projects, subscriptions, and key lifecycle.
- Generate and hash API key secret on create/rotate.
- Push full project snapshots on project/key/subscription changes.
