import Innertube from 'youtubei.js';
import { ServerMessage, ServerMessageType, RemoteURLResponse, RemoteURLRequest, RemoteStream } from './models';

export class YouTubeService {
   readonly videoID: string;
   private websocket: WebSocket;

   constructor(videoID: string, websocket: WebSocket) {
      this.videoID = videoID;
      this.websocket = websocket;
   }

   private send(data: ServerMessage<any>) {
      this.websocket.send(JSON.stringify(data));
   }

   async start() {
      const inflightFetches = new Map<string, (msg: RemoteURLResponse) => void>();

      const wsFetch: typeof fetch = async (input, init = {}) => {
         const req = new Request(input, init);
         const id = crypto.randomUUID();

         const body = req.body ? await req.arrayBuffer() : undefined;

         const payload: RemoteURLRequest = {
            id,
            url: req.url,
            method: req.method,
            headers: Object.fromEntries(req.headers.entries()),
            body: body ? btoa(String.fromCharCode(...new Uint8Array(body))) : undefined,
            allow_redirects: true,
            apply_cookies_on_redirect: true,
            save_intermediate_responses: false,
         };

         this.send({ type: ServerMessageType.urlRequest, content: payload });

         // Wait for the matching response
         const responsePromise = new Promise<RemoteURLResponse>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Client fetch timeout')), 30_000);
            inflightFetches.set(id, msg => {
               clearTimeout(timer);
               resolve(msg);
            });
         });

         const resMsg = await responsePromise;
         const binary = Uint8Array.from(atob(resMsg.data), c => c.charCodeAt(0));
         return new Response(binary, { status: resMsg.status_code, headers: resMsg.headers });
      };

      // Listen for messages from client
      this.websocket.addEventListener('message', async event => {
         console.log('Received message', event.data); // TODO: remove
         try {
            let messageData: string;
            const data: any = event.data; // Explicitly cast to any for instanceof checks

            if (data instanceof ArrayBuffer) {
               // Decode ArrayBuffer to string (assuming UTF-8)
               messageData = new TextDecoder().decode(data);
            } else if (data instanceof Blob) {
               // Decode Blob to string (assuming UTF-8)
               messageData = await data.text();
            } else if (typeof data === 'string') {
               messageData = data;
            } else {
               console.error('Received unexpected message data type:', typeof data);
               return;
            }

            const parsed = JSON.parse(messageData) as RemoteURLResponse;
            const cont = inflightFetches.get(parsed.id);
            if (cont) {
               inflightFetches.delete(parsed.id);
               cont(parsed);
            }
         } catch (error: any) {
            console.error('Bad message from client', error);
         }
      });

      try {
         const innertube = await Innertube.create({ fetch: wsFetch });
         const streams = await this.getStreams(innertube);

         this.send({ type: ServerMessageType.result, content: streams });
      } catch (error: any) {
         console.error(error);
         this.websocket.send(JSON.stringify({ type: 'error', message: error.message }));
         this.websocket.close(1008, 'Failed to get video info');
      } finally {
         this.websocket.close();
      }
   }

   // -

   private async getStreams(innertube: Innertube): Promise<RemoteStream[]> {
      const info = await innertube.getInfo(this.videoID);
      const f = info.streaming_data || { formats: [], adaptive_formats: [] };
      const formats = [...(f.formats ?? []), ...(f.adaptive_formats ?? [])];

      const allStreams: (RemoteStream | null)[] = formats.map(format => {
         let streamUrl = format.url;
         if (!streamUrl && format.signature_cipher) {
            streamUrl = format.decipher(innertube.session.player);
         }

         if (!streamUrl) {
            return null;
         }

         const stream: RemoteStream = {
            url: streamUrl,
            itag: format.itag,
            ext: format.mime_type?.split('/')[1]?.split(';')[0] || 'unknown',
            video_codec: format.mime_type?.includes('video')
               ? format.mime_type.split('codecs=')[1]?.split(',')[0]?.replace(/"/g, '') || undefined
               : undefined,
            audio_codec: format.mime_type?.includes('audio')
               ? format.mime_type.split('codecs=')[1]?.split(',')[0]?.replace(/"/g, '') || undefined
               : undefined,
            average_bitrate: format.bitrate || undefined,
            audio_bitrate: format.bitrate || undefined,
            video_bitrate: format.bitrate || undefined,
            filesize: format.content_length ? Number(format.content_length) : undefined,
         };
         return stream;
      });
      const filteredStreams = allStreams.filter(stream => stream !== null);

      return filteredStreams;
   }
}
