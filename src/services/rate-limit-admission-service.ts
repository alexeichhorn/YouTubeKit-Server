export type RateTier = 'public_no_key' | 'free_api_key';

export interface ParsedApiKey {
   projectPublicID: string;
   keyID: string;
   keySecret: string;
}

export interface EffectiveDecision {
   tier: RateTier;
   allowed: boolean;
   deniedReason?: 'invalid_key' | 'rate_limited';
   limitDaily: number | null;
   limitWeekly: number | null;
   limitMonthly: number | null;
   remainingDaily: number | null;
   remainingWeekly: number | null;
   remainingMonthly: number | null;
   retryAfterSeconds: number;
}

export interface RateLimitCheckResult {
   invalidApiKeyFormat: boolean;
   parsedKey: ParsedApiKey | null;
   decision: EffectiveDecision | null;
}

export class RateLimitAdmissionService {
   constructor(private readonly env: Env) {}

   async evaluate(appID: string, rawApiKey: string | null): Promise<RateLimitCheckResult> {
      const normalizedApiKey = normalizeApiKey(rawApiKey);
      const parsedKey = normalizedApiKey ? parseApiKey(normalizedApiKey) : null;

      if (normalizedApiKey && !parsedKey) {
         return {
            invalidApiKeyFormat: true,
            parsedKey: null,
            decision: null,
         };
      }

      const decision = parsedKey ? await this.checkApiKeyRateLimit(parsedKey) : await this.checkAppRateLimit(appID);

      return {
         invalidApiKeyFormat: false,
         parsedKey,
         decision,
      };
   }

   buildRateLimitResponse(decision: EffectiveDecision): Response {
      const headers: Record<string, string> = {
         'Retry-After': decision.retryAfterSeconds.toString(),
         'X-RateLimit-Tier': decision.tier,
      };

      if (decision.limitDaily != null && decision.remainingDaily != null) {
         headers['X-RateLimit-Limit-Day'] = decision.limitDaily.toString();
         headers['X-RateLimit-Remaining-Day'] = decision.remainingDaily.toString();
      }

      if (decision.limitWeekly != null && decision.remainingWeekly != null) {
         headers['X-RateLimit-Limit-Week'] = decision.limitWeekly.toString();
         headers['X-RateLimit-Remaining-Week'] = decision.remainingWeekly.toString();
      }

      if (decision.limitMonthly != null && decision.remainingMonthly != null) {
         headers['X-RateLimit-Limit-Month'] = decision.limitMonthly.toString();
         headers['X-RateLimit-Remaining-Month'] = decision.remainingMonthly.toString();
      }

      return new Response('Too many requests', {
         status: 429,
         headers,
      });
   }

   private async checkAppRateLimit(appID: string): Promise<EffectiveDecision> {
      const objectID = this.env.APP_RATE_LIMITER.idFromName(appID);
      const limiter = this.env.APP_RATE_LIMITER.get(objectID);
      const decision = await limiter.admit({ cost: 1, nowMs: Date.now() });

      return {
         tier: 'public_no_key',
         allowed: decision.allowed,
         limitDaily: decision.limitDaily,
         limitWeekly: decision.limitWeekly,
         limitMonthly: null,
         remainingDaily: decision.remainingDaily,
         remainingWeekly: decision.remainingWeekly,
         remainingMonthly: null,
         retryAfterSeconds: decision.retryAfterSeconds,
      };
   }

   private async checkApiKeyRateLimit(parsedKey: ParsedApiKey): Promise<EffectiveDecision> {
      const objectID = this.env.API_KEY_RATE_LIMITER.idFromName(parsedKey.projectPublicID);
      const limiter = this.env.API_KEY_RATE_LIMITER.get(objectID);

      const decision = await limiter.admit({
         cost: 1,
         nowMs: Date.now(),
         keyID: parsedKey.keyID,
         keySecret: parsedKey.keySecret,
      });

      return {
         tier: 'free_api_key',
         ...decision,
      };
   }
}

export function parseApiKey(raw: string): ParsedApiKey | null {
   const match = /^ytk_([^_]{1,64})_([^_]{1,64})_(.{16,})$/.exec(raw);
   if (!match) {
      return null;
   }

   const [, projectPublicID, keyID, keySecret] = match;
   if (!projectPublicID || !keyID || !keySecret) {
      return null;
   }

   return {
      projectPublicID,
      keyID,
      keySecret,
   };
}

export function normalizeApiKey(value: string | null): string | null {
   const trimmed = value?.trim();
   if (!trimmed) {
      return null;
   }

   return trimmed;
}
