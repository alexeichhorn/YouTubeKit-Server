import { DurableObject } from 'cloudflare:workers';

interface AdmitRequest {
   cost?: number;
   nowMs?: number;
}

export interface RateLimitDecision {
   allowed: boolean;
   limitDaily: number;
   limitWeekly: number;
   remainingDaily: number;
   remainingWeekly: number;
   retryAfterSeconds: number;
}

interface RateLimitPolicy {
   dailyLimit: number;
   weeklyLimit: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_DAILY_LIMIT = 5000;
const DEFAULT_WEEKLY_LIMIT = 20000;

interface CounterState {
   dayWindowStartMs: number;
   dayCount: number;
   weekWindowStartMs: number;
   weekCount: number;
}

export class AppRateLimiter extends DurableObject<Env> {
   private readonly sql = this.ctx.storage.sql;

   constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.ctx.blockConcurrencyWhile(async () => {
         this.initializeSchema();
      });
   }

   async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/admit') {
         return new Response('Not found', { status: 404 });
      }

      const payload = (await request.json().catch(() => null)) as AdmitRequest | null;
      if (!payload) {
         return new Response('Invalid JSON payload', { status: 400 });
      }

      const nowMs = Number.isFinite(payload.nowMs) ? Number(payload.nowMs) : Date.now();
      const requestedCost = Number.isFinite(payload.cost) ? Number(payload.cost) : 1;
      const cost = Math.max(1, Math.floor(requestedCost));

      const decision = this.admit(cost, nowMs);
      return Response.json(decision);
   }

   private initializeSchema() {
      this.sql.exec(`
         CREATE TABLE IF NOT EXISTS limiter_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            day_window_start_ms INTEGER NOT NULL,
            day_count INTEGER NOT NULL,
            week_window_start_ms INTEGER NOT NULL,
            week_count INTEGER NOT NULL
         )
      `);
   }

   private admit(cost: number, nowMs: number): RateLimitDecision {
      const policy = this.getPolicy();
      const state = this.getOrCreateState(nowMs);
      const nextState = this.rollExpiredWindows(state, nowMs);

      const nextDaily = nextState.dayCount + cost;
      const nextWeekly = nextState.weekCount + cost;

      if (nextDaily > policy.dailyLimit || nextWeekly > policy.weeklyLimit) {
         const retryAfterSeconds = this.calculateRetryAfterSeconds({
            nowMs,
            dayWindowStartMs: nextState.dayWindowStartMs,
            weekWindowStartMs: nextState.weekWindowStartMs,
            dayExceeded: nextDaily > policy.dailyLimit,
            weekExceeded: nextWeekly > policy.weeklyLimit,
         });

         return {
            allowed: false,
            limitDaily: policy.dailyLimit,
            limitWeekly: policy.weeklyLimit,
            remainingDaily: Math.max(0, policy.dailyLimit - nextState.dayCount),
            remainingWeekly: Math.max(0, policy.weeklyLimit - nextState.weekCount),
            retryAfterSeconds,
         };
      }

      this.sql.exec(
         `
            INSERT INTO limiter_state (
               id,
               day_window_start_ms,
               day_count,
               week_window_start_ms,
               week_count
            )
            VALUES (1, ?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
               day_window_start_ms = excluded.day_window_start_ms,
               day_count = excluded.day_count,
               week_window_start_ms = excluded.week_window_start_ms,
               week_count = excluded.week_count
         `,
         nextState.dayWindowStartMs,
         nextDaily,
         nextState.weekWindowStartMs,
         nextWeekly
      );

      return {
         allowed: true,
         limitDaily: policy.dailyLimit,
         limitWeekly: policy.weeklyLimit,
         remainingDaily: Math.max(0, policy.dailyLimit - (nextState.dayCount + cost)),
         remainingWeekly: Math.max(0, policy.weeklyLimit - (nextState.weekCount + cost)),
         retryAfterSeconds: 0,
      };
   }

   private getOrCreateState(nowMs: number): CounterState {
      const row = this.sql
         .exec<{
            day_window_start_ms: number;
            day_count: number;
            week_window_start_ms: number;
            week_count: number;
         }>('SELECT day_window_start_ms, day_count, week_window_start_ms, week_count FROM limiter_state WHERE id = 1')
         .toArray()[0];

      if (!row) {
         return {
            dayWindowStartMs: nowMs,
            dayCount: 0,
            weekWindowStartMs: nowMs,
            weekCount: 0,
         };
      }

      return {
         dayWindowStartMs: Number(row.day_window_start_ms),
         dayCount: Number(row.day_count),
         weekWindowStartMs: Number(row.week_window_start_ms),
         weekCount: Number(row.week_count),
      };
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

      return nextState;
   }

   private calculateRetryAfterSeconds(params: {
      nowMs: number;
      dayWindowStartMs: number;
      weekWindowStartMs: number;
      dayExceeded: boolean;
      weekExceeded: boolean;
   }): number {
      const retries: number[] = [];

      if (params.dayExceeded) {
         const dayResetAt = params.dayWindowStartMs + DAY_MS;
         retries.push(Math.max(1, Math.ceil((dayResetAt - params.nowMs) / 1000)));
      }

      if (params.weekExceeded) {
         const weekResetAt = params.weekWindowStartMs + WEEK_MS;
         retries.push(Math.max(1, Math.ceil((weekResetAt - params.nowMs) / 1000)));
      }

      return retries.length > 0 ? Math.max(...retries) : 1;
   }

   private getPolicy(): RateLimitPolicy {
      const dailyLimit = this.parsePositiveInt(this.env.RATE_LIMIT_DAILY_REQUESTS, DEFAULT_DAILY_LIMIT);
      const weeklyLimit = this.parsePositiveInt(this.env.RATE_LIMIT_WEEKLY_REQUESTS, DEFAULT_WEEKLY_LIMIT);

      return {
         dailyLimit,
         weeklyLimit,
      };
   }

   private parsePositiveInt(value: string | undefined, fallback: number): number {
      if (!value) {
         return fallback;
      }

      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
         return fallback;
      }

      return parsed;
   }
}
