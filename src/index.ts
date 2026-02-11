import { YouTubeService } from './youtube/service';
import { AppRateLimiter } from './durable-objects/app-rate-limiter';
import { ApiKeyRateLimiter } from './durable-objects/api-key-rate-limiter';
import { RateLimitAdmissionService } from './services/rate-limit-admission-service';
import { RateLimitInternalService } from './services/rate-limit-internal-service';

export { AppRateLimiter };
export { ApiKeyRateLimiter };

const APP_ID_HEADER = 'X-AppID-v1';
const API_KEY_HEADER = 'X-API-Key';

const APP_ID_MAX_LENGTH = 128;

export default {
   async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const userAgent = request.headers.get('User-Agent') ?? 'unknown';
      console.log(`User Agent: ${userAgent}`);

      const rateLimitAdmissionService = new RateLimitAdmissionService(env);
      const rateLimitInternalService = new RateLimitInternalService(env);

      if (url.pathname === '/internal/usage' && request.method === 'GET') {
         return rateLimitInternalService.handleUsageRequest(request, url);
      }
      if (url.pathname === '/internal/project-config' && request.method === 'PUT') {
         return rateLimitInternalService.handleProjectConfigRequest(request);
      }

      const appID = normalizeAppID(request.headers.get(APP_ID_HEADER));
      console.log(`App ID: ${appID ?? 'missing'}`);
      if (!appID) {
         console.warn(`Rejected request: missing ${APP_ID_HEADER}`);
         return new Response(`Missing ${APP_ID_HEADER}`, { status: 400 });
      }

      if (url.pathname === '/v1' && request.headers.get('Upgrade') === 'websocket') {
         try {
            const checkResult = await rateLimitAdmissionService.evaluate(appID, request.headers.get(API_KEY_HEADER));

            if (checkResult.invalidApiKeyFormat) {
               console.warn('Rejected request: invalid API key format', JSON.stringify({ appID, path: url.pathname }));
               return new Response('Invalid API key format', { status: 401 });
            }

            const decision = checkResult.decision;
            const parsedKey = checkResult.parsedKey;
            if (!decision) {
               return new Response('Rate limiter unavailable', { status: 503 });
            }

            if (!decision.allowed) {
               if (decision.deniedReason === 'invalid_key') {
                  console.warn(
                     'API key rejected request',
                     JSON.stringify({
                        appID,
                        path: url.pathname,
                        keyID: parsedKey?.keyID ?? null,
                     }),
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
                  }),
               );

               return rateLimitAdmissionService.buildRateLimitResponse(decision);
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

function normalizeAppID(rawAppID: string | null): string | null {
   const trimmed = rawAppID?.trim();
   if (!trimmed) {
      return null;
   }

   return trimmed.slice(0, APP_ID_MAX_LENGTH);
}
