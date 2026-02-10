import { DurableObject } from 'cloudflare:workers';

interface AdmitRequest {
   cost?: number;
   nowMs?: number;
   keyID?: string;
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

interface RateLimitPolicy {
   dailyLimit: number;
   weeklyLimit: number;
   monthlyLimit: number;
}

export interface ApiKeyRateLimitDecision {
   allowed: boolean;
   limitDaily: number;
   limitWeekly: number;
   limitMonthly: number;
   remainingDaily: number;
   remainingWeekly: number;
   remainingMonthly: number;
   retryAfterSeconds: number;
}

interface UsageCounters {
   dayCount: number;
   weekCount: number;
   monthCount: number;
   dayWindowStartMs: number;
   weekWindowStartMs: number;
   monthWindowStartMs: number;
   limitDaily: number;
   limitWeekly: number;
   limitMonthly: number;
   remainingDaily: number;
   remainingWeekly: number;
   remainingMonthly: number;
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

      const policy = this.getPolicy();
      const projectState = this.getFreshProjectState(nowMs);

      const nextProjectDaily = projectState.dayCount + cost;
      const nextProjectWeekly = projectState.weekCount + cost;
      const nextProjectMonthly = projectState.monthCount + cost;

      const dayExceeded = nextProjectDaily > policy.dailyLimit;
      const weekExceeded = nextProjectWeekly > policy.weeklyLimit;
      const monthExceeded = nextProjectMonthly > policy.monthlyLimit;

      if (dayExceeded || weekExceeded || monthExceeded) {
         return {
            allowed: false,
            limitDaily: policy.dailyLimit,
            limitWeekly: policy.weeklyLimit,
            limitMonthly: policy.monthlyLimit,
            remainingDaily: Math.max(0, policy.dailyLimit - projectState.dayCount),
            remainingWeekly: Math.max(0, policy.weeklyLimit - projectState.weekCount),
            remainingMonthly: Math.max(0, policy.monthlyLimit - projectState.monthCount),
            retryAfterSeconds: this.calculateRetryAfterSeconds({
               nowMs,
               dayWindowStartMs: projectState.dayWindowStartMs,
               weekWindowStartMs: projectState.weekWindowStartMs,
               monthWindowStartMs: projectState.monthWindowStartMs,
               dayExceeded,
               weekExceeded,
               monthExceeded,
            }),
         };
      }

      const nextProjectState: CounterState = {
         ...projectState,
         dayCount: nextProjectDaily,
         weekCount: nextProjectWeekly,
         monthCount: nextProjectMonthly,
      };
      this.persistProjectState(nextProjectState);

      const keyID = sanitizeKeyID(payload?.keyID);
      if (keyID) {
         const keyState = this.getFreshKeyState(keyID, nowMs);
         this.persistKeyState(keyID, {
            ...keyState,
            dayCount: keyState.dayCount + cost,
            weekCount: keyState.weekCount + cost,
            monthCount: keyState.monthCount + cost,
         });
      }

      return {
         allowed: true,
         limitDaily: policy.dailyLimit,
         limitWeekly: policy.weeklyLimit,
         limitMonthly: policy.monthlyLimit,
         remainingDaily: Math.max(0, policy.dailyLimit - nextProjectState.dayCount),
         remainingWeekly: Math.max(0, policy.weeklyLimit - nextProjectState.weekCount),
         remainingMonthly: Math.max(0, policy.monthlyLimit - nextProjectState.monthCount),
         retryAfterSeconds: 0,
      };
   }

   usage(payload?: UsageRequest): ApiKeyUsageSnapshot {
      const nowMs = Number.isFinite(payload?.nowMs) ? Number(payload?.nowMs) : Date.now();
      const policy = this.getPolicy();
      const projectState = this.getFreshProjectState(nowMs);

      const snapshot: ApiKeyUsageSnapshot = {
         project: this.toUsageCounters(projectState, policy),
      };

      const keyID = sanitizeKeyID(payload?.keyID);
      if (keyID) {
         const keyState = this.getFreshKeyState(keyID, nowMs);
         snapshot.key = {
            keyID,
            counters: this.toUsageCounters(keyState, policy),
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

   private getPolicy(): RateLimitPolicy {
      return {
         dailyLimit: this.parsePositiveInt(this.env.FREE_API_KEY_DAILY_REQUESTS, DEFAULT_DAILY_LIMIT),
         weeklyLimit: this.parsePositiveInt(this.env.FREE_API_KEY_WEEKLY_REQUESTS, DEFAULT_WEEKLY_LIMIT),
         monthlyLimit: this.parsePositiveInt(this.env.FREE_API_KEY_MONTHLY_REQUESTS, DEFAULT_MONTHLY_LIMIT),
      };
   }

   private toUsageCounters(state: CounterState, policy: RateLimitPolicy): UsageCounters {
      return {
         dayCount: state.dayCount,
         weekCount: state.weekCount,
         monthCount: state.monthCount,
         dayWindowStartMs: state.dayWindowStartMs,
         weekWindowStartMs: state.weekWindowStartMs,
         monthWindowStartMs: state.monthWindowStartMs,
         limitDaily: policy.dailyLimit,
         limitWeekly: policy.weeklyLimit,
         limitMonthly: policy.monthlyLimit,
         remainingDaily: Math.max(0, policy.dailyLimit - state.dayCount),
         remainingWeekly: Math.max(0, policy.weeklyLimit - state.weekCount),
         remainingMonthly: Math.max(0, policy.monthlyLimit - state.monthCount),
      };
   }

   private calculateRetryAfterSeconds(params: {
      nowMs: number;
      dayWindowStartMs: number;
      weekWindowStartMs: number;
      monthWindowStartMs: number;
      dayExceeded: boolean;
      weekExceeded: boolean;
      monthExceeded: boolean;
   }): number {
      const retries: number[] = [];

      if (params.dayExceeded) {
         retries.push(Math.max(1, Math.ceil((params.dayWindowStartMs + DAY_MS - params.nowMs) / 1000)));
      }

      if (params.weekExceeded) {
         retries.push(Math.max(1, Math.ceil((params.weekWindowStartMs + WEEK_MS - params.nowMs) / 1000)));
      }

      if (params.monthExceeded) {
         retries.push(Math.max(1, Math.ceil((params.monthWindowStartMs + MONTH_MS - params.nowMs) / 1000)));
      }

      return retries.length > 0 ? Math.max(...retries) : 1;
   }

   private parsePositiveInt(value: string | number | undefined, fallback: number): number {
      if (value === undefined) {
         return fallback;
      }

      const parsed = Number.parseInt(String(value), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
         return fallback;
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
}

function sanitizeKeyID(raw: string | undefined): string | undefined {
   const trimmed = raw?.trim();
   if (!trimmed) {
      return undefined;
   }

   return trimmed.slice(0, 128);
}
