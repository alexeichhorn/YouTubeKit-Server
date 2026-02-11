import type { SyncProjectConfigRequest } from '../durable-objects/api-key-rate-limiter';
import type { ParsedApiKey } from '../rate-limit-admission/models';
import type { ParsedProjectConfigPayload } from './models';

const INTERNAL_USAGE_TOKEN_HEADER = 'X-Internal-Usage-Token';
const INTERNAL_CONFIG_TOKEN_HEADER = 'X-Internal-Config-Token';

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
      if (!payload || typeof payload !== 'object') {
         return null;
      }

      const raw = payload as Record<string, unknown>;
      const projectID = typeof raw.projectID === 'string' ? raw.projectID.trim() : '';
      if (!projectID) {
         return null;
      }

      const version = Number(raw.version);
      if (!Number.isInteger(version)) {
         return null;
      }

      const keysRaw = raw.keys;
      if (!Array.isArray(keysRaw)) {
         return null;
      }

      const keys = keysRaw.map((entry): SyncProjectConfigRequest['keys'][number] | null => {
         if (!entry || typeof entry !== 'object') {
            return null;
         }
         const key = entry as Record<string, unknown>;

         const keyID = typeof key.keyID === 'string' ? key.keyID : null;
         const secretHash = typeof key.secretHash === 'string' ? key.secretHash : null;
         const status = this.parseKeyStatus(key.status);
         const keyPolicy = this.parseNullablePolicyObject(key.keyPolicy);

         if (!keyID || !secretHash || !status || keyPolicy === undefined) {
            return null;
         }

         return {
            keyID,
            secretHash,
            status,
            keyPolicy,
         };
      });

      if (keys.some((key) => key === null)) {
         return null;
      }

      const projectPolicy = this.parseNullablePolicyObject(raw.projectPolicy);
      if (projectPolicy === undefined) {
         return null;
      }

      return {
         projectID,
         config: {
            version,
            projectPolicy,
            keys: keys as SyncProjectConfigRequest['keys'],
         },
      };
   }

   private parseKeyStatus(value: unknown): 'active' | 'revoked' | null {
      if (value === 'active' || value === 'revoked') {
         return value;
      }

      return null;
   }

   private parseNullablePolicyObject(value: unknown):
      | {
           dailyLimit?: number | null;
           weeklyLimit?: number | null;
           monthlyLimit?: number | null;
        }
      | undefined {
      if (value === undefined || value === null) {
         return {};
      }
      if (typeof value !== 'object') {
         return undefined;
      }

      const raw = value as Record<string, unknown>;

      const dailyLimit = this.parseNullableLimit(raw.dailyLimit);
      const weeklyLimit = this.parseNullableLimit(raw.weeklyLimit);
      const monthlyLimit = this.parseNullableLimit(raw.monthlyLimit);
      if (dailyLimit === undefined || weeklyLimit === undefined || monthlyLimit === undefined) {
         return undefined;
      }

      return {
         dailyLimit,
         weeklyLimit,
         monthlyLimit,
      };
   }

   private parseNullableLimit(value: unknown): number | null | undefined {
      if (value === undefined || value === null) {
         return null;
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
         return undefined;
      }

      return parsed;
   }

   private parseApiKey(raw: string): ParsedApiKey | null {
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

   private normalizeApiKey(value: string | null): string | null {
      const trimmed = value?.trim();
      if (!trimmed) {
         return null;
      }

      return trimmed;
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
