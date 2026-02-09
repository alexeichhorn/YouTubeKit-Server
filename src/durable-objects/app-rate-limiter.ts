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
   bucketSizeMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_DAILY_LIMIT = 5000;
const DEFAULT_WEEKLY_LIMIT = 20000;
const DEFAULT_BUCKET_SECONDS = 300;

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
         CREATE TABLE IF NOT EXISTS request_buckets (
            bucket_start INTEGER PRIMARY KEY,
            count INTEGER NOT NULL
         )
      `);
   }

   private admit(cost: number, nowMs: number): RateLimitDecision {
      const policy = this.getPolicy();
      const currentBucketStart = Math.floor(nowMs / policy.bucketSizeMs) * policy.bucketSizeMs;
      const dayWindowStart = nowMs - DAY_MS;
      const weekWindowStart = nowMs - WEEK_MS;

      this.cleanupOldBuckets(weekWindowStart, policy.bucketSizeMs);

      const usedDaily = this.getUsageSince(dayWindowStart);
      const usedWeekly = this.getUsageSince(weekWindowStart);
      const nextDaily = usedDaily + cost;
      const nextWeekly = usedWeekly + cost;

      if (nextDaily > policy.dailyLimit || nextWeekly > policy.weeklyLimit) {
         const retryAfterSeconds = this.calculateRetryAfterSeconds({
            nowMs,
            dayWindowStart,
            weekWindowStart,
            dayExceeded: nextDaily > policy.dailyLimit,
            weekExceeded: nextWeekly > policy.weeklyLimit,
            bucketSizeMs: policy.bucketSizeMs,
         });

         return {
            allowed: false,
            limitDaily: policy.dailyLimit,
            limitWeekly: policy.weeklyLimit,
            remainingDaily: Math.max(0, policy.dailyLimit - usedDaily),
            remainingWeekly: Math.max(0, policy.weeklyLimit - usedWeekly),
            retryAfterSeconds,
         };
      }

      this.sql.exec(
         `
            INSERT INTO request_buckets (bucket_start, count)
            VALUES (?1, ?2)
            ON CONFLICT(bucket_start) DO UPDATE SET count = count + excluded.count
         `,
         currentBucketStart,
         cost
      );

      return {
         allowed: true,
         limitDaily: policy.dailyLimit,
         limitWeekly: policy.weeklyLimit,
         remainingDaily: Math.max(0, policy.dailyLimit - nextDaily),
         remainingWeekly: Math.max(0, policy.weeklyLimit - nextWeekly),
         retryAfterSeconds: 0,
      };
   }

   private cleanupOldBuckets(weekWindowStart: number, bucketSizeMs: number) {
      // Keep one extra bucket outside the 7-day range for stable boundary behavior.
      this.sql.exec('DELETE FROM request_buckets WHERE bucket_start <= ?1', weekWindowStart - bucketSizeMs);
   }

   private getUsageSince(windowStart: number): number {
      const row = this.sql
         .exec<{ total: number | null }>('SELECT COALESCE(SUM(count), 0) AS total FROM request_buckets WHERE bucket_start > ?1', windowStart)
         .one();

      return Number(row.total ?? 0);
   }

   private calculateRetryAfterSeconds(params: {
      nowMs: number;
      dayWindowStart: number;
      weekWindowStart: number;
      dayExceeded: boolean;
      weekExceeded: boolean;
      bucketSizeMs: number;
   }): number {
      const retries: number[] = [];

      if (params.dayExceeded) {
         retries.push(this.getWindowRetryAfterSeconds(params.dayWindowStart, DAY_MS, params.nowMs, params.bucketSizeMs));
      }

      if (params.weekExceeded) {
         retries.push(this.getWindowRetryAfterSeconds(params.weekWindowStart, WEEK_MS, params.nowMs, params.bucketSizeMs));
      }

      if (retries.length === 0) {
         return Math.max(1, Math.ceil(params.bucketSizeMs / 1000));
      }

      return Math.max(...retries);
   }

   private getWindowRetryAfterSeconds(windowStart: number, windowMs: number, nowMs: number, bucketSizeMs: number): number {
      const row = this.sql
         .exec<{ bucket_start: number }>(
            'SELECT bucket_start FROM request_buckets WHERE bucket_start > ?1 ORDER BY bucket_start ASC LIMIT 1',
            windowStart
         )
         .toArray()[0];

      if (!row) {
         return Math.max(1, Math.ceil(bucketSizeMs / 1000));
      }

      const retryAt = Number(row.bucket_start) + windowMs;
      return Math.max(1, Math.ceil((retryAt - nowMs) / 1000));
   }

   private getPolicy(): RateLimitPolicy {
      const dailyLimit = this.parsePositiveInt(this.env.RATE_LIMIT_DAILY_REQUESTS, DEFAULT_DAILY_LIMIT);
      const weeklyLimit = this.parsePositiveInt(this.env.RATE_LIMIT_WEEKLY_REQUESTS, DEFAULT_WEEKLY_LIMIT);
      const bucketSeconds = this.parsePositiveInt(this.env.RATE_LIMIT_BUCKET_SECONDS, DEFAULT_BUCKET_SECONDS);

      return {
         dailyLimit,
         weeklyLimit,
         bucketSizeMs: bucketSeconds * 1000,
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
