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
