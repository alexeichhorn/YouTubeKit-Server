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
