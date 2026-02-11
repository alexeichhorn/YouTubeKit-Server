import { z } from 'zod';
import type { SyncProjectConfigRequest } from '../durable-objects/api-key-rate-limiter';

export const RateLimitPolicySchema = z
   .object({
      dailyLimit: z.number().finite().nullable().optional(),
      weeklyLimit: z.number().finite().nullable().optional(),
      monthlyLimit: z.number().finite().nullable().optional(),
   })
   .strict();

export const ProjectConfigPayloadSchema = z
   .object({
      projectID: z.string().trim().min(1),
      version: z.number().int(),
      projectPolicy: RateLimitPolicySchema.nullish().transform((value) => value ?? {}),
      keys: z.array(
         z
            .object({
               keyID: z.string().min(1),
               secretHash: z.string().min(1),
               status: z.enum(['active', 'revoked']),
               keyPolicy: RateLimitPolicySchema.nullish().transform((value) => value ?? {}),
            })
            .strict(),
      ),
   })
   .strict();

export const ParsedProjectConfigPayloadSchema = ProjectConfigPayloadSchema.transform(
   (value): { projectID: string; config: SyncProjectConfigRequest } => {
      const config: SyncProjectConfigRequest = {
         version: value.version,
         projectPolicy: value.projectPolicy,
         keys: value.keys,
      };

      return {
         projectID: value.projectID,
         config,
      };
   },
);

export type ParsedProjectConfigPayload = z.infer<typeof ParsedProjectConfigPayloadSchema>;
