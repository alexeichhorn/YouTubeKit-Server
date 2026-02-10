import { DurableObject } from 'cloudflare:workers';

interface RateLimitPolicy {
   dailyLimit?: number;
   weeklyLimit?: number;
   monthlyLimit?: number;
}

interface AdmitRequest {
   cost?: number;
   nowMs?: number;
   keyID?: string;
   projectPolicy?: RateLimitPolicy;
   keyPolicy?: RateLimitPolicy;
}

interface UsageRequest {
   nowMs?: number;
   keyID?: string;
   projectPolicy?: RateLimitPolicy;
   keyPolicy?: RateLimitPolicy;
}

interface CounterState {
   dayWindowStartMs: number;
   dayCount: number;
   weekWindowStartMs: number;
   weekCount: number;
   monthWindowStartMs: number;
   monthCount: number;
}

export interface ApiKeyRateLimitDecision {
   allowed: boolean;
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

   admit(payload?: AdmitRequest): ApiKeyRateLimitDecision {
      const nowMs = Number.isFinite(payload?.nowMs) ? Number(payload?.nowMs) : Date.now();
      const requestedCost = Number.isFinite(payload?.cost) ? Number(payload?.cost) : 1;
      const cost = Math.max(1, Math.floor(requestedCost));

      const projectPolicy = this.resolveProjectPolicy(payload?.projectPolicy);
      const keyPolicy = this.resolveKeyPolicy(payload?.keyPolicy);

      const projectState = this.getFreshProjectState(nowMs);
      const keyID = sanitizeKeyID(payload?.keyID);
      const keyState = keyID ? this.getFreshKeyState(keyID, nowMs) : null;

      const nextProjectDaily = projectState.dayCount + cost;
      const nextProjectWeekly = projectState.weekCount + cost;
      const nextProjectMonthly = projectState.monthCount + cost;

      const nextKeyDaily = keyState ? keyState.dayCount + cost : 0;
      const nextKeyWeekly = keyState ? keyState.weekCount + cost : 0;
      const nextKeyMonthly = keyState ? keyState.monthCount + cost : 0;

      const projectDayExceeded = exceeds(nextProjectDaily, projectPolicy.dailyLimit);
      const projectWeekExceeded = exceeds(nextProjectWeekly, projectPolicy.weeklyLimit);
      const projectMonthExceeded = exceeds(nextProjectMonthly, projectPolicy.monthlyLimit);

      const keyDayExceeded = Boolean(keyState && exceeds(nextKeyDaily, keyPolicy.dailyLimit));
      const keyWeekExceeded = Boolean(keyState && exceeds(nextKeyWeekly, keyPolicy.weeklyLimit));
      const keyMonthExceeded = Boolean(keyState && exceeds(nextKeyMonthly, keyPolicy.monthlyLimit));

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
            keyRemainingDaily: keyState ? remaining(keyPolicy.dailyLimit, keyState.dayCount) : null,
            keyRemainingWeekly: keyState ? remaining(keyPolicy.weeklyLimit, keyState.weekCount) : null,
            keyRemainingMonthly: keyState ? remaining(keyPolicy.monthlyLimit, keyState.monthCount) : null,
         };
      }

      const nextProjectState: CounterState = {
         ...projectState,
         dayCount: nextProjectDaily,
         weekCount: nextProjectWeekly,
         monthCount: nextProjectMonthly,
      };
      this.persistProjectState(nextProjectState);

      if (keyState && keyID) {
         this.persistKeyState(keyID, {
            ...keyState,
            dayCount: nextKeyDaily,
            weekCount: nextKeyWeekly,
            monthCount: nextKeyMonthly,
         });
      }

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
         keyRemainingDaily: null,
         keyRemainingWeekly: null,
         keyRemainingMonthly: null,
      };
   }

   usage(payload?: UsageRequest): ApiKeyUsageSnapshot {
      const nowMs = Number.isFinite(payload?.nowMs) ? Number(payload?.nowMs) : Date.now();
      const projectPolicy = this.resolveProjectPolicy(payload?.projectPolicy);
      const keyPolicy = this.resolveKeyPolicy(payload?.keyPolicy);

      const projectState = this.getFreshProjectState(nowMs);
      const snapshot: ApiKeyUsageSnapshot = {
         project: toUsageCounters(projectState, projectPolicy),
      };

      const keyID = sanitizeKeyID(payload?.keyID);
      if (keyID) {
         const keyState = this.getFreshKeyState(keyID, nowMs);
         snapshot.key = {
            keyID,
            counters: toUsageCounters(keyState, keyPolicy),
         };
      }

      return snapshot;
   }

   private initializeSchema(): void {
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

   private resolveProjectPolicy(override?: RateLimitPolicy): RateLimitPolicy {
      const defaults: RateLimitPolicy = {
         dailyLimit: this.parseOptionalPositiveInt(this.env.FREE_API_KEY_DAILY_REQUESTS) ?? DEFAULT_DAILY_LIMIT,
         weeklyLimit: this.parseOptionalPositiveInt(this.env.FREE_API_KEY_WEEKLY_REQUESTS) ?? DEFAULT_WEEKLY_LIMIT,
         monthlyLimit: this.parseOptionalPositiveInt(this.env.FREE_API_KEY_MONTHLY_REQUESTS) ?? DEFAULT_MONTHLY_LIMIT,
      };

      return {
         dailyLimit: override?.dailyLimit ?? defaults.dailyLimit,
         weeklyLimit: override?.weeklyLimit ?? defaults.weeklyLimit,
         monthlyLimit: override?.monthlyLimit ?? defaults.monthlyLimit,
      };
   }

   private resolveKeyPolicy(override?: RateLimitPolicy): RateLimitPolicy {
      return {
         dailyLimit: this.parseOptionalPositiveInt(override?.dailyLimit),
         weeklyLimit: this.parseOptionalPositiveInt(override?.weeklyLimit),
         monthlyLimit: this.parseOptionalPositiveInt(override?.monthlyLimit),
      };
   }

   private parseOptionalPositiveInt(value: string | number | undefined): number | undefined {
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
      keyState: CounterState | null;
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

      if (params.keyState && params.keyDayExceeded) {
         retries.push(Math.max(1, Math.ceil((params.keyState.dayWindowStartMs + DAY_MS - params.nowMs) / 1000)));
      }

      if (params.keyState && params.keyWeekExceeded) {
         retries.push(Math.max(1, Math.ceil((params.keyState.weekWindowStartMs + WEEK_MS - params.nowMs) / 1000)));
      }

      if (params.keyState && params.keyMonthExceeded) {
         retries.push(Math.max(1, Math.ceil((params.keyState.monthWindowStartMs + MONTH_MS - params.nowMs) / 1000)));
      }

      return retries.length > 0 ? Math.max(...retries) : 1;
   }
}

function sanitizeKeyID(raw: string | undefined): string | undefined {
   const trimmed = raw?.trim();
   if (!trimmed) {
      return undefined;
   }

   return trimmed.slice(0, 128);
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
