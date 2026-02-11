import type { SyncProjectConfigRequest } from '../durable-objects/api-key-rate-limiter';
import type { ParsedApiKey } from '../rate-limit-admission/models';
import type { ParsedProjectConfigPayload } from './models';
import { z } from 'zod';

const INTERNAL_USAGE_TOKEN_HEADER = 'X-Internal-Usage-Token';
const INTERNAL_CONFIG_TOKEN_HEADER = 'X-Internal-Config-Token';

const NORMALIZED_API_KEY_SCHEMA = z.string().trim().min(1);
const API_KEY_PATTERN = /^ytk_([^_]{1,64})_([^_]{1,64})_(.{16,})$/;
const PARSED_API_KEY_SCHEMA = z.string().trim().regex(API_KEY_PATTERN);

const RATE_LIMIT_POLICY_SCHEMA = z
   .object({
      dailyLimit: z.number().finite().nullable().optional(),
      weeklyLimit: z.number().finite().nullable().optional(),
      monthlyLimit: z.number().finite().nullable().optional(),
   })
   .strict();

const PROJECT_CONFIG_PAYLOAD_SCHEMA = z
   .object({
      projectID: z.string().trim().min(1),
      version: z.number().int(),
      projectPolicy: RATE_LIMIT_POLICY_SCHEMA.nullish().transform((value) => value ?? {}),
      keys: z.array(
         z
            .object({
               keyID: z.string().min(1),
               secretHash: z.string().min(1),
               status: z.enum(['active', 'revoked']),
               keyPolicy: RATE_LIMIT_POLICY_SCHEMA.nullish().transform((value) => value ?? {}),
            })
            .strict(),
      ),
   })
   .strict()
   .transform((value): ParsedProjectConfigPayload => {
      const config: SyncProjectConfigRequest = {
         version: value.version,
         projectPolicy: value.projectPolicy,
         keys: value.keys,
      };
      return {
         projectID: value.projectID,
         config,
      };
   });

export class RateLimitInternalService {
   constructor(private readonly env: Env) {}

   async handleUsageRequest(request: Request, url: URL): Promise<Response> {
      if (!this.isUsageRequestAuthorized(request)) {
         return new Response('Forbidden', { status: 403 });
      }

      const kind = url.searchParams.get('kind');
      if (kind === 'project') {
         const projectID = url.searchParams.get('projectID')?.trim();
         if (!projectID) {
            return new Response('Missing projectID', { status: 400 });
         }

         const keyID = url.searchParams.get('keyID')?.trim() || undefined;
         const objectID = this.env.API_KEY_RATE_LIMITER.idFromName(projectID);
         const limiter = this.env.API_KEY_RATE_LIMITER.get(objectID);
         const usage = await limiter.usage({
            nowMs: Date.now(),
            keyID,
         });

         return this.json({
            kind: 'project',
            projectID,
            usage,
         });
      }

      if (kind === 'key') {
         const rawApiKey = this.normalizeApiKey(url.searchParams.get('apiKey'));
         if (!rawApiKey) {
            return new Response('Missing apiKey', { status: 400 });
         }

         const parsedKey = this.parseApiKey(rawApiKey);
         if (!parsedKey) {
            return new Response('Invalid API key format', { status: 400 });
         }

         const objectID = this.env.API_KEY_RATE_LIMITER.idFromName(parsedKey.projectPublicID);
         const limiter = this.env.API_KEY_RATE_LIMITER.get(objectID);
         const usage = await limiter.usage({
            nowMs: Date.now(),
            keyID: parsedKey.keyID,
         });

         return this.json({
            kind: 'key',
            projectID: parsedKey.projectPublicID,
            keyID: parsedKey.keyID,
            usage,
         });
      }

      return new Response('Invalid kind. Use kind=project or kind=key', { status: 400 });
   }

   async handleProjectConfigRequest(request: Request): Promise<Response> {
      if (!this.isConfigRequestAuthorized(request)) {
         return new Response('Forbidden', { status: 403 });
      }

      let payload: unknown;
      try {
         payload = await request.json();
      } catch {
         return new Response('Invalid JSON body', { status: 400 });
      }

      const parsed = this.parseProjectConfigPayload(payload);
      if (!parsed) {
         return new Response('Invalid project config payload', { status: 400 });
      }

      try {
         const objectID = this.env.API_KEY_RATE_LIMITER.idFromName(parsed.projectID);
         const limiter = this.env.API_KEY_RATE_LIMITER.get(objectID);
         const result = await limiter.syncProjectConfig(parsed.config);

         return this.json({
            projectID: parsed.projectID,
            ...result,
         });
      } catch (error) {
         console.error('Failed to sync project config:', error);
         return new Response('Failed to sync project config', { status: 400 });
      }
   }

   private isUsageRequestAuthorized(request: Request): boolean {
      const configuredToken = this.env.INTERNAL_USAGE_API_TOKEN?.trim();
      if (!configuredToken) {
         return false;
      }

      const providedToken = request.headers.get(INTERNAL_USAGE_TOKEN_HEADER)?.trim();
      return Boolean(providedToken && providedToken === configuredToken);
   }

   private isConfigRequestAuthorized(request: Request): boolean {
      const configuredToken = this.env.INTERNAL_CONFIG_API_TOKEN?.trim();
      if (!configuredToken) {
         return false;
      }

      const providedToken = request.headers.get(INTERNAL_CONFIG_TOKEN_HEADER)?.trim();
      return Boolean(providedToken && providedToken === configuredToken);
   }

   private parseProjectConfigPayload(payload: unknown): ParsedProjectConfigPayload | null {
      const result = PROJECT_CONFIG_PAYLOAD_SCHEMA.safeParse(payload);
      return result.success ? result.data : null;
   }

   private parseApiKey(raw: string): ParsedApiKey | null {
      const result = PARSED_API_KEY_SCHEMA.safeParse(raw);
      if (!result.success) {
         return null;
      }

      const match = API_KEY_PATTERN.exec(result.data);
      if (!match) {
         return null;
      }

      const [, projectPublicID, keyID, keySecret] = match;
      return {
         projectPublicID,
         keyID,
         keySecret,
      };
   }

   private normalizeApiKey(value: string | null): string | null {
      const result = NORMALIZED_API_KEY_SCHEMA.safeParse(value);
      if (!result.success) {
         return null;
      }

      return result.data;
   }

   private json(value: unknown): Response {
      return new Response(JSON.stringify(value), {
         status: 200,
         headers: {
            'content-type': 'application/json',
         },
      });
   }
}
