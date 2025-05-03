import Innertube from 'youtubei.js';
import { ServerMessage, ServerMessageType, RemoteURLResponse, RemoteURLRequest, RemoteStream } from './models';

export class YouTubeService {
   readonly videoID: string;
   private websocket: WebSocket;
   private inflightFetches = new Map<string, (msg: RemoteURLResponse) => void>();

   // State for handling incoming chunked messages, keyed by packetId (stringified)
   private chunkBuffers = new Map<string, { buffer: ArrayBuffer[]; expectedTotal: number; receivedCount: number }>();
   // Fixed 12-byte header: packetId (4), chunkIndex (4), totalChunks (4)
   private static readonly CHUNK_HEADER_SIZE = 12;

   constructor(videoID: string, websocket: WebSocket) {
      this.videoID = videoID;
      this.websocket = websocket;
   }

   private send(data: ServerMessage<any>) {
      this.websocket.send(JSON.stringify(data));
   }

   async start() {
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
            this.inflightFetches.set(id, msg => {
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
         try {
            const data: any = event.data; // Explicitly cast to any for instanceof checks

            if (data instanceof ArrayBuffer) {
               if (data.byteLength >= YouTubeService.CHUNK_HEADER_SIZE) {
                  await this.handleChunk(data);
               } else {
                  console.warn(`Received small ArrayBuffer (size: ${data.byteLength}), processing as non-chunked.`);
                  this.processCompleteMessage(new TextDecoder().decode(data));
               }
            } else if (data instanceof Blob) {
               const arrayBuffer = await data.arrayBuffer();
               if (arrayBuffer.byteLength >= YouTubeService.CHUNK_HEADER_SIZE) {
                  await this.handleChunk(arrayBuffer);
               } else {
                  console.warn(`Received small Blob message (size: ${arrayBuffer.byteLength}), processing as non-chunked.`);
                  this.processCompleteMessage(new TextDecoder().decode(arrayBuffer));
               }
            } else if (typeof data === 'string') {
               // Should ideally not happen if client always sends ArrayBuffer for chunked
               console.warn('Received unexpected string message, processing as non-chunked.');
               this.processCompleteMessage(data);
            } else {
               console.error('Received unexpected message data type:', typeof data);
            }
         } catch (error: any) {
            console.error('Error processing message from client:', error);
            // Consider adding cleanup logic here or a timeout mechanism for stale buffers
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

   // - Chunk Handling Methods (Updated for Fixed 12-byte Header) -

   private async handleChunk(chunkData: ArrayBuffer): Promise<void> {
      if (chunkData.byteLength < YouTubeService.CHUNK_HEADER_SIZE) {
         console.error(`Chunk too small for header (size: ${chunkData.byteLength}, needed: ${YouTubeService.CHUNK_HEADER_SIZE})`);
         return;
      }
      const headerView = new DataView(chunkData, 0, YouTubeService.CHUNK_HEADER_SIZE);
      let packetId: number | undefined;

      try {
         // 1. Read Packet Identifier (UInt32 BE)
         packetId = headerView.getUint32(0, false); // false for big-endian
         const packetIdStr = packetId.toString(); // Use string for map key

         // 2. Read Chunk Index (UInt32 BE)
         const chunkIndex = headerView.getUint32(4, false);

         // 3. Read Total Chunks (UInt32 BE)
         const totalChunks = headerView.getUint32(8, false);

         // 4. Extract Payload
         const payload = chunkData.slice(YouTubeService.CHUNK_HEADER_SIZE);

         // console.log(`Received chunk ${chunkIndex + 1}/${totalChunks} for Packet ID ${packetIdStr}, size ${payload.byteLength}`); // DEBUG

         // --- State Management ---
         let state = this.chunkBuffers.get(packetIdStr);

         if (chunkIndex === 0) {
            if (state && state.receivedCount > 0) {
               console.warn(`Received chunk 0 for Packet ID ${packetIdStr} while previous msg incomplete. Resetting.`);
            }
            state = { buffer: new Array(totalChunks), expectedTotal: totalChunks, receivedCount: 0 };
            this.chunkBuffers.set(packetIdStr, state);
         } else if (!state) {
            console.error(`Received chunk ${chunkIndex + 1} for unknown/expired Packet ID ${packetIdStr}. Discarding.`);
            return;
         }

         if (totalChunks !== state.expectedTotal) {
            console.error(
               `Chunk total mismatch for Packet ID ${packetIdStr}: received ${totalChunks}, expected ${state.expectedTotal}. Discarding buffer.`
            );
            this.chunkBuffers.delete(packetIdStr);
            return;
         }

         if (chunkIndex >= state.expectedTotal || state.buffer[chunkIndex]) {
            console.warn(`Duplicate or invalid chunk index ${chunkIndex + 1} for Packet ID ${packetIdStr}. Ignoring.`);
            return;
         }

         // Store chunk & update count
         state.buffer[chunkIndex] = payload;
         state.receivedCount++;

         // Check completion
         if (state.receivedCount === state.expectedTotal) {
            // console.log(`Message complete for Packet ID ${packetIdStr}. Reassembling.`); // DEBUG
            await this.reassembleAndProcess(packetIdStr);
         }
      } catch (error: any) {
         console.error('Error handling chunk:', error);
         if (packetId !== undefined && this.chunkBuffers.has(packetId.toString())) {
            console.log(`Cleaning up buffer for Packet ID ${packetId} due to error.`);
            this.chunkBuffers.delete(packetId.toString());
         }
      }
   }

   private async reassembleAndProcess(packetIdStr: string): Promise<void> {
      const state = this.chunkBuffers.get(packetIdStr);
      if (!state) {
         console.error(`Attempted to reassemble non-existent Packet ID: ${packetIdStr}`);
         return;
      }

      try {
         // Verify all chunks are present before assembling
         for (let i = 0; i < state.expectedTotal; i++) {
            if (!state.buffer[i]) {
               throw new Error(`Missing chunk ${i + 1} during final reassembly for Packet ID ${packetIdStr}`);
            }
         }

         const completeBuffer = await this.reassembleChunks(state.buffer);
         const messageData = new TextDecoder().decode(completeBuffer);
         this.processCompleteMessage(messageData);
      } catch (e) {
         console.error(`Failed to reassemble or process Packet ID ${packetIdStr}:`, e);
      } finally {
         // Always remove buffer after processing attempt
         this.chunkBuffers.delete(packetIdStr);
      }
   }

   private async reassembleChunks(buffer: ArrayBuffer[]): Promise<ArrayBuffer> {
      // Calculate total size
      const totalSize = buffer.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const reassembled = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of buffer) {
         // Already validated chunks exist in reassembleAndProcess
         reassembled.set(new Uint8Array(chunk), offset);
         offset += chunk.byteLength;
      }
      return reassembled.buffer;
   }

   // Processes a fully reassembled message string
   private processCompleteMessage(messageData: string): void {
      // console.log('Processing complete message:', messageData.substring(0, 100) + '...'); // DEBUG
      try {
         const parsed = JSON.parse(messageData) as RemoteURLResponse;
         const callback = this.inflightFetches.get(parsed.id);
         if (callback) {
            // Note: The message ID (parsed.id) inside the JSON payload is the one
            // used for matching the original request, NOT the packetId used for chunking.
            this.inflightFetches.delete(parsed.id);
            callback(parsed);
         } else {
            console.warn(`Received response for unknown or timed out request ID: ${parsed.id}`);
         }
      } catch (error: any) {
         console.error('Bad message format or JSON parse error:', error, 'Data:', messageData.substring(0, 200) + '...');
      }
   }

   // - InnerTube Methods -

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
