export interface RemoteURLRequest {
   id: string;
   url: string;
   method: string;
   headers: Record<string, string>;
   body?: string; // base64
   allow_redirects: boolean;
   apply_cookies_on_redirect: boolean;
   save_intermediate_responses: boolean;

   max_message_chunk_size?: number;
}

export interface RemoteURLResponse {
   id: string;
   url?: string;
   status_code?: number;
   headers: Record<string, string>;
   data: string; // base64
}

export interface RemoteStream {
   url: string;
   itag: number;
   ext: string;
   video_codec?: string;
   audio_codec?: string;
   average_bitrate?: number;
   audio_bitrate?: number;
   video_bitrate?: number;
   filesize?: number;
}

// - Communication

export enum ServerMessageType {
   urlRequest = 'urlRequest',
   result = 'result',
}

export interface ServerMessage<Content> {
   type: ServerMessageType;
   content: Content;
}
