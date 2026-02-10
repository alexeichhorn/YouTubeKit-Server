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

These limiters are intentionally separate and should not be merged.

## 3. Runtime routing seam
File: `src/index.ts`

Behavior:
- `/v1` websocket requests route to one of the two limiter DOs.
- No key -> `APP_RATE_LIMITER`.
- Key present -> `API_KEY_RATE_LIMITER` keyed by project ID from API key.

This is the primary server-side integration point for platform entitlements.

## 4. Usage access seam (server API)
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
- Current API-key counters and remaining quota read directly from `ApiKeyRateLimiter` DO state.

## 5. Shared data contract (target)
Preferred model:
- Shared D1 database bound to both Workers.
- `YouTubeKit-Platform` writes users/projects/keys/subscriptions/tier configs.
- `YouTubeKit-Server` reads entitlements and uses DOs for live enforcement + usage.

No push-sync job is required in this model.
