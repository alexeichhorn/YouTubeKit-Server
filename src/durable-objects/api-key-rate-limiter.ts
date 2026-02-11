import { DurableObject } from 'cloudflare:workers';

interface RateLimitPolicy {
   dailyLimit?: number;
   weeklyLimit?: number;
   monthlyLimit?: number;
}

interface NullableRateLimitPolicy {
   dailyLimit?: number | null;
   weeklyLimit?: number | null;
   monthlyLimit?: number | null;
}

interface SyncKeyConfigRequest {
   keyID: string;
   secretHash: string;
   status: 'active' | 'revoked';
   keyPolicy?: NullableRateLimitPolicy;
}

export interface SyncProjectConfigRequest {
   version: number;
   projectPolicy?: NullableRateLimitPolicy;
   keys: SyncKeyConfigRequest[];
}

export interface SyncProjectConfigResponse {
   ok: true;
   applied: boolean;
   version: number;
   currentVersion?: number;
}

interface AdmitRequest {
   cost?: number;
   nowMs?: number;
   keyID: string;
   keySecret: string;
}

interface UsageRequest {
   nowMs?: number;
   keyID?: string;
}

interface CounterState {
   dayWindowStartMs: number;
   dayCount: number;
   weekWindowStartMs: number;
   weekCount: number;
   monthWindowStartMs: number;
   monthCount: number;
}

type DeniedReason = 'invalid_key' | 'rate_limited';

export interface ApiKeyRateLimitDecision {
   allowed: boolean;
   deniedReason?: DeniedReason;
   limitDaily: number | null;
   limitWeekly: number | null;
   limitMonthly: number | null;
   remainingDaily: number | null;
   remainingWeekly: number | null;
   remainingMonthly: number | null;
   retryAfterSeconds: number;
   keyID?: string;
   keyLimitDaily: number | null;
   keyLimitWeekly: number | null;
   keyLimitMonthly: number | null;
   keyRemainingDaily: number | null;
   keyRemainingWeekly: number | null;
   keyRemainingMonthly: number | null;
}

interface UsageCounters {
   dayCount: number;
   weekCount: number;
   monthCount: number;
   dayWindowStartMs: number;
   weekWindowStartMs: number;
   monthWindowStartMs: number;
   limitDaily: number | null;
   limitWeekly: number | null;
   limitMonthly: number | null;
   remainingDaily: number | null;
   remainingWeekly: number | null;
   remainingMonthly: number | null;
}

export interface ApiKeyUsageSnapshot {
   project: UsageCounters;
   key?: {
      keyID: string;
      counters: UsageCounters;
   };
}

interface ProjectConfigRow {
   version: number;
   daily_limit: number | null;
   weekly_limit: number | null;
   monthly_limit: number | null;
}

interface KeyConfigRow {
   key_id: string;
   secret_hash: string;
   status: 'active' | 'revoked';
   daily_limit: number | null;
   weekly_limit: number | null;
   monthly_limit: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const DEFAULT_DAILY_LIMIT = 10000;
const DEFAULT_WEEKLY_LIMIT = 40000;
const DEFAULT_MONTHLY_LIMIT = 160000;

export class ApiKeyRateLimiter extends DurableObject<Env> {
   private readonly sql = this.ctx.storage.sql;

   constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.ctx.blockConcurrencyWhile(async () => {
         this.initializeSchema();
      });
   }

   async admit(payload: AdmitRequest): Promise<ApiKeyRateLimitDecision> {
      const nowMs = Number.isFinite(payload.nowMs) ? Number(payload.nowMs) : Date.now();
      const requestedCost = Number.isFinite(payload.cost) ? Number(payload.cost) : 1;
      const cost = Math.max(1, Math.floor(requestedCost));

      const keyID = sanitizeKeyID(payload.keyID);
      if (!keyID) {
         throw new Error('Missing keyID');
      }

      const keySecret = sanitizeKeySecret(payload.keySecret);
      if (!keySecret) {
         throw new Error('Missing keySecret');
      }

      const projectConfig = this.getProjectConfig();
      if (!projectConfig) {
         return invalidKeyDecision(keyID);
      }

      const keyConfig = this.getKeyConfig(keyID);
      if (!keyConfig || keyConfig.status !== 'active') {
         return invalidKeyDecision(keyID);
      }

      const providedSecretHash = await sha256Hex(keySecret);
      if (providedSecretHash !== keyConfig.secret_hash) {
         return invalidKeyDecision(keyID);
      }

      const projectPolicy = this.resolveProjectPolicy(projectConfig);
      const keyPolicy = this.resolveKeyPolicy(keyConfig);

      const projectState = this.getFreshProjectState(nowMs);
      const keyState = this.getFreshKeyState(keyID, nowMs);

      const nextProjectDaily = projectState.dayCount + cost;
      const nextProjectWeekly = projectState.weekCount + cost;
      const nextProjectMonthly = projectState.monthCount + cost;

      const nextKeyDaily = keyState.dayCount + cost;
      const nextKeyWeekly = keyState.weekCount + cost;
      const nextKeyMonthly = keyState.monthCount + cost;

      const projectDayExceeded = exceeds(nextProjectDaily, projectPolicy.dailyLimit);
      const projectWeekExceeded = exceeds(nextProjectWeekly, projectPolicy.weeklyLimit);
      const projectMonthExceeded = exceeds(nextProjectMonthly, projectPolicy.monthlyLimit);

      const keyDayExceeded = exceeds(nextKeyDaily, keyPolicy.dailyLimit);
      const keyWeekExceeded = exceeds(nextKeyWeekly, keyPolicy.weeklyLimit);
      const keyMonthExceeded = exceeds(nextKeyMonthly, keyPolicy.monthlyLimit);

      if (
         projectDayExceeded ||
         projectWeekExceeded ||
         projectMonthExceeded ||
         keyDayExceeded ||
         keyWeekExceeded ||
         keyMonthExceeded
      ) {
         const retryAfterSeconds = this.calculateRetryAfterSeconds({
            nowMs,
            projectState,
            keyState,
            projectDayExceeded,
            projectWeekExceeded,
            projectMonthExceeded,
            keyDayExceeded,
            keyWeekExceeded,
            keyMonthExceeded,
         });

         return {
            allowed: false,
            deniedReason: 'rate_limited',
            limitDaily: nullable(projectPolicy.dailyLimit),
            limitWeekly: nullable(projectPolicy.weeklyLimit),
            limitMonthly: nullable(projectPolicy.monthlyLimit),
            remainingDaily: remaining(projectPolicy.dailyLimit, projectState.dayCount),
            remainingWeekly: remaining(projectPolicy.weeklyLimit, projectState.weekCount),
            remainingMonthly: remaining(projectPolicy.monthlyLimit, projectState.monthCount),
            retryAfterSeconds,
            keyID,
            keyLimitDaily: nullable(keyPolicy.dailyLimit),
            keyLimitWeekly: nullable(keyPolicy.weeklyLimit),
            keyLimitMonthly: nullable(keyPolicy.monthlyLimit),
            keyRemainingDaily: remaining(keyPolicy.dailyLimit, keyState.dayCount),
            keyRemainingWeekly: remaining(keyPolicy.weeklyLimit, keyState.weekCount),
            keyRemainingMonthly: remaining(keyPolicy.monthlyLimit, keyState.monthCount),
         };
      }

      const nextProjectState: CounterState = {
         ...projectState,
         dayCount: nextProjectDaily,
         weekCount: nextProjectWeekly,
         monthCount: nextProjectMonthly,
      };
      this.persistProjectState(nextProjectState);

      this.persistKeyState(keyID, {
         ...keyState,
         dayCount: nextKeyDaily,
         weekCount: nextKeyWeekly,
         monthCount: nextKeyMonthly,
      });

      return {
         allowed: true,
         limitDaily: nullable(projectPolicy.dailyLimit),
         limitWeekly: nullable(projectPolicy.weeklyLimit),
         limitMonthly: nullable(projectPolicy.monthlyLimit),
         remainingDaily: remaining(projectPolicy.dailyLimit, nextProjectState.dayCount),
         remainingWeekly: remaining(projectPolicy.weeklyLimit, nextProjectState.weekCount),
         remainingMonthly: remaining(projectPolicy.monthlyLimit, nextProjectState.monthCount),
         retryAfterSeconds: 0,
         keyID,
         keyLimitDaily: nullable(keyPolicy.dailyLimit),
         keyLimitWeekly: nullable(keyPolicy.weeklyLimit),
         keyLimitMonthly: nullable(keyPolicy.monthlyLimit),
         keyRemainingDaily: remaining(keyPolicy.dailyLimit, nextKeyDaily),
         keyRemainingWeekly: remaining(keyPolicy.weeklyLimit, nextKeyWeekly),
         keyRemainingMonthly: remaining(keyPolicy.monthlyLimit, nextKeyMonthly),
      };
   }

   usage(payload?: UsageRequest): ApiKeyUsageSnapshot {
      const nowMs = Number.isFinite(payload?.nowMs) ? Number(payload?.nowMs) : Date.now();
      const projectPolicy = this.resolveProjectPolicy(this.getProjectConfig());

      const projectState = this.getFreshProjectState(nowMs);
      const snapshot: ApiKeyUsageSnapshot = {
         project: toUsageCounters(projectState, projectPolicy),
      };

      const keyID = sanitizeKeyID(payload?.keyID);
      if (keyID) {
         const keyState = this.getFreshKeyState(keyID, nowMs);
         const keyPolicy = this.resolveKeyPolicy(this.getKeyConfig(keyID));

         snapshot.key = {
            keyID,
            counters: toUsageCounters(keyState, keyPolicy),
         };
      }

      return snapshot;
   }

   syncProjectConfig(payload: SyncProjectConfigRequest): SyncProjectConfigResponse {
      const version = parseRequiredVersion(payload.version);
      const currentVersion = this.getCurrentVersion();
      if (version <= currentVersion) {
         return {
            ok: true,
            applied: false,
            version,
            currentVersion,
         };
      }

      const nowMs = Date.now();
      const projectPolicy = normalizePolicy(payload.projectPolicy);

      this.sql.exec(
         `
            INSERT INTO project_config (
               id,
               version,
               daily_limit,
               weekly_limit,
               monthly_limit,
               updated_at_ms
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET
               version = excluded.version,
               daily_limit = excluded.daily_limit,
               weekly_limit = excluded.weekly_limit,
               monthly_limit = excluded.monthly_limit,
               updated_at_ms = excluded.updated_at_ms
         `,
         version,
         projectPolicy.dailyLimit,
         projectPolicy.weeklyLimit,
         projectPolicy.monthlyLimit,
         nowMs,
      );

      const incomingKeys = Array.isArray(payload.keys) ? payload.keys : [];
      const syncedKeyIDs: string[] = [];

      for (const key of incomingKeys) {
         const keyID = sanitizeKeyID(key?.keyID);
         if (!keyID) {
            throw new Error('Invalid keyID in keys payload');
         }

         const secretHash = sanitizeSecretHash(key?.secretHash);
         if (!secretHash) {
            throw new Error('Invalid secretHash in keys payload');
         }

         const status = normalizeKeyStatus(key?.status);
         if (!status) {
            throw new Error('Invalid status in keys payload');
         }

         const keyPolicy = normalizePolicy(key?.keyPolicy);

         this.sql.exec(
            `
               INSERT INTO key_config (
                  key_id,
                  secret_hash,
                  status,
                  daily_limit,
                  weekly_limit,
                  monthly_limit,
                  updated_at_ms
               )
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT(key_id) DO UPDATE SET
                  secret_hash = excluded.secret_hash,
                  status = excluded.status,
                  daily_limit = excluded.daily_limit,
                  weekly_limit = excluded.weekly_limit,
                  monthly_limit = excluded.monthly_limit,
                  updated_at_ms = excluded.updated_at_ms
            `,
            keyID,
            secretHash,
            status,
            keyPolicy.dailyLimit,
            keyPolicy.weeklyLimit,
            keyPolicy.monthlyLimit,
            nowMs,
         );

         syncedKeyIDs.push(keyID);
      }

      this.deleteRemovedKeys(syncedKeyIDs);

      return {
         ok: true,
         applied: true,
         version,
      };
   }

   private initializeSchema(): void {
      this.sql.exec(`
         CREATE TABLE IF NOT EXISTS project_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL,
            daily_limit INTEGER,
            weekly_limit INTEGER,
            monthly_limit INTEGER,
            updated_at_ms INTEGER NOT NULL
         )
      `);

      this.sql.exec(`
         CREATE TABLE IF NOT EXISTS key_config (
            key_id TEXT PRIMARY KEY,
            secret_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            daily_limit INTEGER,
            weekly_limit INTEGER,
            monthly_limit INTEGER,
            updated_at_ms INTEGER NOT NULL
         )
      `);

      this.sql.exec(`
         CREATE TABLE IF NOT EXISTS project_limiter_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            day_window_start_ms INTEGER NOT NULL,
            day_count INTEGER NOT NULL,
            week_window_start_ms INTEGER NOT NULL,
            week_count INTEGER NOT NULL,
            month_window_start_ms INTEGER NOT NULL,
            month_count INTEGER NOT NULL
         )
      `);

      this.sql.exec(`
         CREATE TABLE IF NOT EXISTS key_limiter_state (
            key_id TEXT PRIMARY KEY,
            day_window_start_ms INTEGER NOT NULL,
            day_count INTEGER NOT NULL,
            week_window_start_ms INTEGER NOT NULL,
            week_count INTEGER NOT NULL,
            month_window_start_ms INTEGER NOT NULL,
            month_count INTEGER NOT NULL
         )
      `);
   }

   private getCurrentVersion(): number {
      const row = this.sql.exec('SELECT version FROM project_config WHERE id = 1').toArray()[0] as
         | { version?: unknown }
         | undefined;

      const parsed = row ? Number(row.version) : 0;
      return Number.isFinite(parsed) ? parsed : 0;
   }

   private getProjectConfig(): ProjectConfigRow | null {
      const row = this.sql.exec('SELECT version, daily_limit, weekly_limit, monthly_limit FROM project_config WHERE id = 1')
         .toArray()[0] as
         | {
              version?: unknown;
              daily_limit?: unknown;
              weekly_limit?: unknown;
              monthly_limit?: unknown;
           }
         | undefined;

      if (!row) {
         return null;
      }

      return {
         version: Number(row.version),
         daily_limit: nullableInt(row.daily_limit),
         weekly_limit: nullableInt(row.weekly_limit),
         monthly_limit: nullableInt(row.monthly_limit),
      };
   }

   private getKeyConfig(keyID: string): KeyConfigRow | null {
      const row = this.sql
         .exec(
            'SELECT key_id, secret_hash, status, daily_limit, weekly_limit, monthly_limit FROM key_config WHERE key_id = ?1',
            keyID,
         )
         .toArray()[0] as
         | {
              key_id?: unknown;
              secret_hash?: unknown;
              status?: unknown;
              daily_limit?: unknown;
              weekly_limit?: unknown;
              monthly_limit?: unknown;
           }
         | undefined;

      if (!row) {
         return null;
      }

      const status = normalizeKeyStatus(row.status);
      const keyIDValue = typeof row.key_id === 'string' ? row.key_id : '';
      const secretHashValue = sanitizeSecretHash(typeof row.secret_hash === 'string' ? row.secret_hash : undefined);
      if (!status || !keyIDValue || !secretHashValue) {
         return null;
      }

      return {
         key_id: keyIDValue,
         secret_hash: secretHashValue,
         status,
         daily_limit: nullableInt(row.daily_limit),
         weekly_limit: nullableInt(row.weekly_limit),
         monthly_limit: nullableInt(row.monthly_limit),
      };
   }

   private deleteRemovedKeys(allowedKeyIDs: string[]): void {
      if (allowedKeyIDs.length === 0) {
         this.sql.exec('DELETE FROM key_config');
         this.sql.exec('DELETE FROM key_limiter_state');
         return;
      }

      const placeholders = allowedKeyIDs.map((_, index) => `?${index + 1}`).join(', ');
      this.sql.exec(`DELETE FROM key_config WHERE key_id NOT IN (${placeholders})`, ...allowedKeyIDs);
      this.sql.exec(`DELETE FROM key_limiter_state WHERE key_id NOT IN (${placeholders})`, ...allowedKeyIDs);
   }

   private getFreshProjectState(nowMs: number): CounterState {
      const current = this.getOrCreateProjectState(nowMs);
      const rolled = this.rollExpiredWindows(current, nowMs);
      if (!this.sameState(current, rolled)) {
         this.persistProjectState(rolled);
      }
      return rolled;
   }

   private getFreshKeyState(keyID: string, nowMs: number): CounterState {
      const current = this.getOrCreateKeyState(keyID, nowMs);
      const rolled = this.rollExpiredWindows(current, nowMs);
      if (!this.sameState(current, rolled)) {
         this.persistKeyState(keyID, rolled);
      }
      return rolled;
   }

   private getOrCreateProjectState(nowMs: number): CounterState {
      const row = this.sql
         .exec<{
            day_window_start_ms: number;
            day_count: number;
            week_window_start_ms: number;
            week_count: number;
            month_window_start_ms: number;
            month_count: number;
         }>(
            'SELECT day_window_start_ms, day_count, week_window_start_ms, week_count, month_window_start_ms, month_count FROM project_limiter_state WHERE id = 1',
         )
         .toArray()[0];

      if (!row) {
         return {
            dayWindowStartMs: nowMs,
            dayCount: 0,
            weekWindowStartMs: nowMs,
            weekCount: 0,
            monthWindowStartMs: nowMs,
            monthCount: 0,
         };
      }

      return {
         dayWindowStartMs: Number(row.day_window_start_ms),
         dayCount: Number(row.day_count),
         weekWindowStartMs: Number(row.week_window_start_ms),
         weekCount: Number(row.week_count),
         monthWindowStartMs: Number(row.month_window_start_ms),
         monthCount: Number(row.month_count),
      };
   }

   private getOrCreateKeyState(keyID: string, nowMs: number): CounterState {
      const row = this.sql
         .exec<{
            day_window_start_ms: number;
            day_count: number;
            week_window_start_ms: number;
            week_count: number;
            month_window_start_ms: number;
            month_count: number;
         }>(
            'SELECT day_window_start_ms, day_count, week_window_start_ms, week_count, month_window_start_ms, month_count FROM key_limiter_state WHERE key_id = ?1',
            keyID,
         )
         .toArray()[0];

      if (!row) {
         return {
            dayWindowStartMs: nowMs,
            dayCount: 0,
            weekWindowStartMs: nowMs,
            weekCount: 0,
            monthWindowStartMs: nowMs,
            monthCount: 0,
         };
      }

      return {
         dayWindowStartMs: Number(row.day_window_start_ms),
         dayCount: Number(row.day_count),
         weekWindowStartMs: Number(row.week_window_start_ms),
         weekCount: Number(row.week_count),
         monthWindowStartMs: Number(row.month_window_start_ms),
         monthCount: Number(row.month_count),
      };
   }

   private persistProjectState(state: CounterState): void {
      this.sql.exec(
         `
            INSERT INTO project_limiter_state (
               id,
               day_window_start_ms,
               day_count,
               week_window_start_ms,
               week_count,
               month_window_start_ms,
               month_count
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
               day_window_start_ms = excluded.day_window_start_ms,
               day_count = excluded.day_count,
               week_window_start_ms = excluded.week_window_start_ms,
               week_count = excluded.week_count,
               month_window_start_ms = excluded.month_window_start_ms,
               month_count = excluded.month_count
         `,
         state.dayWindowStartMs,
         state.dayCount,
         state.weekWindowStartMs,
         state.weekCount,
         state.monthWindowStartMs,
         state.monthCount,
      );
   }

   private persistKeyState(keyID: string, state: CounterState): void {
      this.sql.exec(
         `
            INSERT INTO key_limiter_state (
               key_id,
               day_window_start_ms,
               day_count,
               week_window_start_ms,
               week_count,
               month_window_start_ms,
               month_count
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(key_id) DO UPDATE SET
               day_window_start_ms = excluded.day_window_start_ms,
               day_count = excluded.day_count,
               week_window_start_ms = excluded.week_window_start_ms,
               week_count = excluded.week_count,
               month_window_start_ms = excluded.month_window_start_ms,
               month_count = excluded.month_count
         `,
         keyID,
         state.dayWindowStartMs,
         state.dayCount,
         state.weekWindowStartMs,
         state.weekCount,
         state.monthWindowStartMs,
         state.monthCount,
      );
   }

   private rollExpiredWindows(state: CounterState, nowMs: number): CounterState {
      const nextState = { ...state };

      if (nowMs >= nextState.dayWindowStartMs + DAY_MS) {
         nextState.dayWindowStartMs = nowMs;
         nextState.dayCount = 0;
      }

      if (nowMs >= nextState.weekWindowStartMs + WEEK_MS) {
         nextState.weekWindowStartMs = nowMs;
         nextState.weekCount = 0;
      }

      if (nowMs >= nextState.monthWindowStartMs + MONTH_MS) {
         nextState.monthWindowStartMs = nowMs;
         nextState.monthCount = 0;
      }

      return nextState;
   }

   private resolveProjectPolicy(config: ProjectConfigRow | null): RateLimitPolicy {
      if (!config) {
         return {
            dailyLimit: this.parseOptionalPositiveInt(this.env.FREE_API_KEY_DAILY_REQUESTS) ?? DEFAULT_DAILY_LIMIT,
            weeklyLimit: this.parseOptionalPositiveInt(this.env.FREE_API_KEY_WEEKLY_REQUESTS) ?? DEFAULT_WEEKLY_LIMIT,
            monthlyLimit: this.parseOptionalPositiveInt(this.env.FREE_API_KEY_MONTHLY_REQUESTS) ?? DEFAULT_MONTHLY_LIMIT,
         };
      }

      return {
         dailyLimit: this.parseOptionalPositiveInt(config.daily_limit),
         weeklyLimit: this.parseOptionalPositiveInt(config.weekly_limit),
         monthlyLimit: this.parseOptionalPositiveInt(config.monthly_limit),
      };
   }

   private resolveKeyPolicy(config: KeyConfigRow | null): RateLimitPolicy {
      if (!config) {
         return {};
      }

      return {
         dailyLimit: this.parseOptionalPositiveInt(config.daily_limit),
         weeklyLimit: this.parseOptionalPositiveInt(config.weekly_limit),
         monthlyLimit: this.parseOptionalPositiveInt(config.monthly_limit),
      };
   }

   private parseOptionalPositiveInt(value: string | number | null | undefined): number | undefined {
      if (value === undefined || value === null || value === '') {
         return undefined;
      }

      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
         return undefined;
      }

      return parsed;
   }

   private sameState(a: CounterState, b: CounterState): boolean {
      return (
         a.dayWindowStartMs === b.dayWindowStartMs &&
         a.dayCount === b.dayCount &&
         a.weekWindowStartMs === b.weekWindowStartMs &&
         a.weekCount === b.weekCount &&
         a.monthWindowStartMs === b.monthWindowStartMs &&
         a.monthCount === b.monthCount
      );
   }

   private calculateRetryAfterSeconds(params: {
      nowMs: number;
      projectState: CounterState;
      keyState: CounterState;
      projectDayExceeded: boolean;
      projectWeekExceeded: boolean;
      projectMonthExceeded: boolean;
      keyDayExceeded: boolean;
      keyWeekExceeded: boolean;
      keyMonthExceeded: boolean;
   }): number {
      const retries: number[] = [];

      if (params.projectDayExceeded) {
         retries.push(Math.max(1, Math.ceil((params.projectState.dayWindowStartMs + DAY_MS - params.nowMs) / 1000)));
      }

      if (params.projectWeekExceeded) {
         retries.push(Math.max(1, Math.ceil((params.projectState.weekWindowStartMs + WEEK_MS - params.nowMs) / 1000)));
      }

      if (params.projectMonthExceeded) {
         retries.push(Math.max(1, Math.ceil((params.projectState.monthWindowStartMs + MONTH_MS - params.nowMs) / 1000)));
      }

      if (params.keyDayExceeded) {
         retries.push(Math.max(1, Math.ceil((params.keyState.dayWindowStartMs + DAY_MS - params.nowMs) / 1000)));
      }

      if (params.keyWeekExceeded) {
         retries.push(Math.max(1, Math.ceil((params.keyState.weekWindowStartMs + WEEK_MS - params.nowMs) / 1000)));
      }

      if (params.keyMonthExceeded) {
         retries.push(Math.max(1, Math.ceil((params.keyState.monthWindowStartMs + MONTH_MS - params.nowMs) / 1000)));
      }

      return retries.length > 0 ? Math.max(...retries) : 1;
   }
}

function parseRequiredVersion(value: number): number {
   const parsed = Math.floor(Number(value));
   if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('Invalid version');
   }

   return parsed;
}

function normalizePolicy(input: NullableRateLimitPolicy | undefined): {
   dailyLimit: number | null;
   weeklyLimit: number | null;
   monthlyLimit: number | null;
} {
   return {
      dailyLimit: normalizeNullableLimit(input?.dailyLimit),
      weeklyLimit: normalizeNullableLimit(input?.weeklyLimit),
      monthlyLimit: normalizeNullableLimit(input?.monthlyLimit),
   };
}

function normalizeNullableLimit(value: number | null | undefined): number | null {
   if (value === null || value === undefined) {
      return null;
   }

   const parsed = Number.parseInt(String(value), 10);
   if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('Invalid rate limit value');
   }

   return parsed;
}

function normalizeKeyStatus(value: unknown): 'active' | 'revoked' | null {
   if (value === 'active' || value === 'revoked') {
      return value;
   }

   return null;
}

function sanitizeKeyID(raw: string | undefined): string | undefined {
   const trimmed = raw?.trim();
   if (!trimmed) {
      return undefined;
   }

   return trimmed.slice(0, 128);
}

function sanitizeKeySecret(raw: string | undefined): string | undefined {
   const trimmed = raw?.trim();
   if (!trimmed) {
      return undefined;
   }

   return trimmed.slice(0, 256);
}

function sanitizeSecretHash(raw: string | undefined): string | undefined {
   const trimmed = raw?.trim().toLowerCase();
   if (!trimmed) {
      return undefined;
   }

   if (!/^[a-f0-9]{64}$/.test(trimmed)) {
      return undefined;
   }

   return trimmed;
}

function nullableInt(value: unknown): number | null {
   if (value === null || value === undefined) {
      return null;
   }

   const parsed = Number.parseInt(String(value), 10);
   return Number.isFinite(parsed) ? parsed : null;
}

function invalidKeyDecision(keyID: string): ApiKeyRateLimitDecision {
   return {
      allowed: false,
      deniedReason: 'invalid_key',
      limitDaily: null,
      limitWeekly: null,
      limitMonthly: null,
      remainingDaily: null,
      remainingWeekly: null,
      remainingMonthly: null,
      retryAfterSeconds: 0,
      keyID,
      keyLimitDaily: null,
      keyLimitWeekly: null,
      keyLimitMonthly: null,
      keyRemainingDaily: null,
      keyRemainingWeekly: null,
      keyRemainingMonthly: null,
   };
}

function exceeds(count: number, limit: number | undefined): boolean {
   return limit !== undefined && count > limit;
}

function remaining(limit: number | undefined, count: number): number | null {
   if (limit === undefined) {
      return null;
   }

   return Math.max(0, limit - count);
}

function nullable(value: number | undefined): number | null {
   return value === undefined ? null : value;
}

function toUsageCounters(state: CounterState, policy: RateLimitPolicy): UsageCounters {
   return {
      dayCount: state.dayCount,
      weekCount: state.weekCount,
      monthCount: state.monthCount,
      dayWindowStartMs: state.dayWindowStartMs,
      weekWindowStartMs: state.weekWindowStartMs,
      monthWindowStartMs: state.monthWindowStartMs,
      limitDaily: nullable(policy.dailyLimit),
      limitWeekly: nullable(policy.weeklyLimit),
      limitMonthly: nullable(policy.monthlyLimit),
      remainingDaily: remaining(policy.dailyLimit, state.dayCount),
      remainingWeekly: remaining(policy.weeklyLimit, state.weekCount),
      remainingMonthly: remaining(policy.monthlyLimit, state.monthCount),
   };
}

async function sha256Hex(value: string): Promise<string> {
   const data = new TextEncoder().encode(value);
   const digest = await crypto.subtle.digest('SHA-256', data);
   const bytes = new Uint8Array(digest);
   return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
}
