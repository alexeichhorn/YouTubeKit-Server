import { z } from 'zod';

export type RateTier = 'public_no_key' | 'free_api_key';

export const ApiKeyPattern = /^ytk_([^_]{1,64})_([^_]{1,64})_(.{16,})$/;

export const NormalizedApiKeySchema = z.string().trim().min(1);
export const RawApiKeySchema = z.string().trim().regex(ApiKeyPattern);
export const ParsedApiKeySchema = z
   .object({
      projectPublicID: z.string().min(1).max(64),
      keyID: z.string().min(1).max(64),
      keySecret: z.string().min(16),
   })
   .strict();

export type ParsedApiKey = z.infer<typeof ParsedApiKeySchema>;

export const ParsedApiKeyFromRawSchema = RawApiKeySchema.transform((value) => {
   const match = ApiKeyPattern.exec(value);
   if (!match) {
      throw new Error('Invalid API key format');
   }

   const [, projectPublicID, keyID, keySecret] = match;
   return {
      projectPublicID,
      keyID,
      keySecret,
   };
}).pipe(ParsedApiKeySchema);

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
