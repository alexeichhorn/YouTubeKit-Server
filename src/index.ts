import { YouTubeService } from './youtube/service';
import { AppRateLimiter } from './durable-objects/app-rate-limiter';
import { ApiKeyRateLimiter } from './durable-objects/api-key-rate-limiter';

export { AppRateLimiter };
export { ApiKeyRateLimiter };

const APP_ID_HEADER = 'X-AppID-v1';
const API_KEY_HEADER = 'X-API-Key';
const INTERNAL_USAGE_TOKEN_HEADER = 'X-Internal-Usage-Token';

const APP_ID_MAX_LENGTH = 128;

type RateTier = 'public_no_key' | 'free_api_key';

interface ParsedApiKey {
   projectPublicID: string;
   keyID: string;
}

interface EffectiveDecision {
   tier: RateTier;
   allowed: boolean;
   limitDaily: number;
   limitWeekly: number;
   limitMonthly?: number;
   remainingDaily: number;
   remainingWeekly: number;
   remainingMonthly?: number;
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
                     limitMonth: decision.limitMonthly ?? null,
                     remainingMonth: decision.remainingMonthly ?? null,
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
      ...decision,
   };
}

async function checkApiKeyRateLimit(parsedKey: ParsedApiKey, env: Env): Promise<EffectiveDecision> {
   const objectID = env.API_KEY_RATE_LIMITER.idFromName(parsedKey.projectPublicID);
   const limiter = env.API_KEY_RATE_LIMITER.get(objectID);

   const decision = await limiter.admit({
      cost: 1,
      nowMs: Date.now(),
      keyID: parsedKey.keyID,
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
      'X-RateLimit-Limit-Day': decision.limitDaily.toString(),
      'X-RateLimit-Limit-Week': decision.limitWeekly.toString(),
      'X-RateLimit-Remaining-Day': decision.remainingDaily.toString(),
      'X-RateLimit-Remaining-Week': decision.remainingWeekly.toString(),
   };

   if (decision.limitMonthly !== undefined && decision.remainingMonthly !== undefined) {
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

function parseApiKey(raw: string): ParsedApiKey | null {
   const match = /^ytk_([^_]{1,64})_([^_]{1,64})_(.{16,})$/.exec(raw);
   if (!match) {
      return null;
   }

   const [, projectPublicID, keyID] = match;
   if (!projectPublicID || !keyID) {
      return null;
   }

   return {
      projectPublicID,
      keyID,
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

function json(value: unknown): Response {
   return new Response(JSON.stringify(value), {
      status: 200,
      headers: {
         'content-type': 'application/json',
      },
   });
}
