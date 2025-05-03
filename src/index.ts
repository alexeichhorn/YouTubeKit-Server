/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { YouTubeService } from './youtube/service';

export default {
   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // Only handle GET /v1?videoID=... as WebSocket upgrades
      if (url.pathname === '/v1' && request.headers.get('Upgrade') === 'websocket') {
         const videoID = url.searchParams.get('videoID');
         if (!videoID) {
            return new Response('Missing videoID', { status: 400 });
         }

         const [clientSock, serverSock] = Object.values(new WebSocketPair());

         // accept and handle on server side
         serverSock.accept();

         const youtubeService = new YouTubeService(videoID, serverSock);
         youtubeService.start();

         return new Response(null, { status: 101, webSocket: clientSock });
      }

      return new Response('Not found', { status: 404 });
   },
} satisfies ExportedHandler<Env>;
