import { YouTubeService } from './youtube/service';
import { AppRateLimiter } from './durable-objects/app-rate-limiter';
import { ApiKeyRateLimiter, type SyncProjectConfigRequest } from './durable-objects/api-key-rate-limiter';

export { AppRateLimiter };
export { ApiKeyRateLimiter };

const APP_ID_HEADER = 'X-AppID-v1';
const API_KEY_HEADER = 'X-API-Key';
const INTERNAL_USAGE_TOKEN_HEADER = 'X-Internal-Usage-Token';
const INTERNAL_CONFIG_TOKEN_HEADER = 'X-Internal-Config-Token';

const APP_ID_MAX_LENGTH = 128;

type RateTier = 'public_no_key' | 'free_api_key';

interface ParsedApiKey {
   projectPublicID: string;
   keyID: string;
   keySecret: string;
}

interface EffectiveDecision {
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

export default {
   async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const userAgent = request.headers.get('User-Agent') ?? 'unknown';
      console.log(`User Agent: ${userAgent}`);

      if (url.pathname === '/internal/usage' && request.method === 'GET') {
         return handleUsageRequest(request, url, env);
      }
      if (url.pathname === '/internal/project-config' && request.method === 'PUT') {
         return handleProjectConfigRequest(request, env);
      }

      // Log the App ID header for debugging purposes
      const appID = normalizeAppID(request.headers.get(APP_ID_HEADER));
      console.log(`App ID: ${appID ?? 'missing'}`);
      if (!appID) {
         console.warn(`Rejected request: missing ${APP_ID_HEADER}`);
         return new Response(`Missing ${APP_ID_HEADER}`, { status: 400 });
      }

      if (url.pathname === '/v1' && request.headers.get('Upgrade') === 'websocket') {
         const rawApiKey = normalizeApiKey(request.headers.get(API_KEY_HEADER));
         const parsedKey = rawApiKey ? parseApiKey(rawApiKey) : null;

         if (rawApiKey && !parsedKey) {
            console.warn('Rejected request: invalid API key format', JSON.stringify({ appID, path: url.pathname }));
            return new Response('Invalid API key format', { status: 401 });
         }

         try {
            const decision = parsedKey ? await checkApiKeyRateLimit(parsedKey, env) : await checkAppRateLimit(appID, env);

            if (!decision.allowed) {
               if (decision.deniedReason === 'invalid_key') {
                  console.warn(
                     'API key rejected request',
                     JSON.stringify({
                        appID,
                        path: url.pathname,
                        keyID: parsedKey?.keyID ?? null,
                     })
                  );
                  return new Response('Invalid API key', { status: 401 });
               }

               console.warn(
                  'Rate limit rejected request',
                  JSON.stringify({
                     appID,
                     path: url.pathname,
                     tier: decision.tier,
                     limitDay: decision.limitDaily,
                     remainingDay: decision.remainingDaily,
                     limitWeek: decision.limitWeekly,
                     remainingWeek: decision.remainingWeekly,
                     limitMonth: decision.limitMonthly,
                     remainingMonth: decision.remainingMonthly,
                     keyID: parsedKey?.keyID ?? null,
                  })
               );
               return buildRateLimitResponse(decision);
            }
         } catch (error) {
            console.error('Rate limiter unavailable:', error);
            return new Response('Rate limiter unavailable', { status: 503 });
         }

         const videoID = url.searchParams.get('videoID');
         if (!videoID) {
            console.warn('Rejected request: missing videoID', JSON.stringify({ appID, path: url.pathname }));
            return new Response('Missing videoID', { status: 400 });
         }

         const [clientSock, serverSock] = Object.values(new WebSocketPair());
         serverSock.accept();

         const youtubeService = new YouTubeService(videoID, serverSock);
         youtubeService.start();

         return new Response(null, { status: 101, webSocket: clientSock });
      }

      return new Response('Not found', { status: 404 });
   },
} satisfies ExportedHandler<Env>;

async function checkAppRateLimit(appID: string, env: Env): Promise<EffectiveDecision> {
   const objectID = env.APP_RATE_LIMITER.idFromName(appID);
   const limiter = env.APP_RATE_LIMITER.get(objectID);
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

async function checkApiKeyRateLimit(parsedKey: ParsedApiKey, env: Env): Promise<EffectiveDecision> {
   const objectID = env.API_KEY_RATE_LIMITER.idFromName(parsedKey.projectPublicID);
   const limiter = env.API_KEY_RATE_LIMITER.get(objectID);

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

function buildRateLimitResponse(decision: EffectiveDecision): Response {
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

async function handleUsageRequest(request: Request, url: URL, env: Env): Promise<Response> {
   if (!isUsageRequestAuthorized(request, env)) {
      return new Response('Forbidden', { status: 403 });
   }

   const kind = url.searchParams.get('kind');
   if (kind === 'project') {
      const projectID = url.searchParams.get('projectID')?.trim();
      if (!projectID) {
         return new Response('Missing projectID', { status: 400 });
      }

      const keyID = url.searchParams.get('keyID')?.trim() || undefined;
      const objectID = env.API_KEY_RATE_LIMITER.idFromName(projectID);
      const limiter = env.API_KEY_RATE_LIMITER.get(objectID);
      const usage = await limiter.usage({
         nowMs: Date.now(),
         keyID,
      });

      return json({
         kind: 'project',
         projectID,
         usage,
      });
   }

   if (kind === 'key') {
      const rawApiKey = normalizeApiKey(url.searchParams.get('apiKey'));
      if (!rawApiKey) {
         return new Response('Missing apiKey', { status: 400 });
      }

      const parsedKey = parseApiKey(rawApiKey);
      if (!parsedKey) {
         return new Response('Invalid API key format', { status: 400 });
      }

      const objectID = env.API_KEY_RATE_LIMITER.idFromName(parsedKey.projectPublicID);
      const limiter = env.API_KEY_RATE_LIMITER.get(objectID);
      const usage = await limiter.usage({
         nowMs: Date.now(),
         keyID: parsedKey.keyID,
      });

      return json({
         kind: 'key',
         projectID: parsedKey.projectPublicID,
         keyID: parsedKey.keyID,
         usage,
      });
   }

   return new Response('Invalid kind. Use kind=project or kind=key', { status: 400 });
}

async function handleProjectConfigRequest(request: Request, env: Env): Promise<Response> {
   if (!isConfigRequestAuthorized(request, env)) {
      return new Response('Forbidden', { status: 403 });
   }

   let payload: unknown;
   try {
      payload = await request.json();
   } catch {
      return new Response('Invalid JSON body', { status: 400 });
   }

   const parsed = parseProjectConfigPayload(payload);
   if (!parsed) {
      return new Response('Invalid project config payload', { status: 400 });
   }

   try {
      const objectID = env.API_KEY_RATE_LIMITER.idFromName(parsed.projectID);
      const limiter = env.API_KEY_RATE_LIMITER.get(objectID);
      const result = await limiter.syncProjectConfig(parsed.config);

      return json({
         projectID: parsed.projectID,
         ...result,
      });
   } catch (error) {
      console.error('Failed to sync project config:', error);
      return new Response('Failed to sync project config', { status: 400 });
   }
}

function parseApiKey(raw: string): ParsedApiKey | null {
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

function isUsageRequestAuthorized(request: Request, env: Env): boolean {
   const configuredToken = env.INTERNAL_USAGE_API_TOKEN?.trim();
   if (!configuredToken) {
      return false;
   }

   const providedToken = request.headers.get(INTERNAL_USAGE_TOKEN_HEADER)?.trim();
   return Boolean(providedToken && providedToken === configuredToken);
}

function isConfigRequestAuthorized(request: Request, env: Env): boolean {
   const configuredToken = env.INTERNAL_CONFIG_API_TOKEN?.trim();
   if (!configuredToken) {
      return false;
   }

   const providedToken = request.headers.get(INTERNAL_CONFIG_TOKEN_HEADER)?.trim();
   return Boolean(providedToken && providedToken === configuredToken);
}

function normalizeAppID(rawAppID: string | null): string | null {
   const trimmed = rawAppID?.trim();
   if (!trimmed) {
      return null;
   }

   return trimmed.slice(0, APP_ID_MAX_LENGTH);
}

function normalizeApiKey(value: string | null): string | null {
   const trimmed = value?.trim();
   if (!trimmed) {
      return null;
   }

   return trimmed;
}

function parseProjectConfigPayload(
   payload: unknown,
): { projectID: string; config: SyncProjectConfigRequest } | null {
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
      const status = parseKeyStatus(key.status);
      const keyPolicy = parseNullablePolicyObject(key.keyPolicy);

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

   const projectPolicy = parseNullablePolicyObject(raw.projectPolicy);
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

function parseKeyStatus(value: unknown): 'active' | 'revoked' | null {
   if (value === 'active' || value === 'revoked') {
      return value;
   }

   return null;
}

function parseNullablePolicyObject(value: unknown):
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

   const dailyLimit = parseNullableLimit(raw.dailyLimit);
   const weeklyLimit = parseNullableLimit(raw.weeklyLimit);
   const monthlyLimit = parseNullableLimit(raw.monthlyLimit);
   if (dailyLimit === undefined || weeklyLimit === undefined || monthlyLimit === undefined) {
      return undefined;
   }

   return {
      dailyLimit,
      weeklyLimit,
      monthlyLimit,
   };
}

function parseNullableLimit(value: unknown): number | null | undefined {
   if (value === undefined) {
      return null;
   }
   if (value === null) {
      return null;
   }

   const parsed = Number(value);
   if (!Number.isFinite(parsed)) {
      return undefined;
   }

   return parsed;
}

function json(value: unknown): Response {
   return new Response(JSON.stringify(value), {
      status: 200,
      headers: {
         'content-type': 'application/json',
      },
   });
}
