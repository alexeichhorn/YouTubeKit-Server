import { RemoteStream } from './websocket';

// Using the same string literal type as youtubei.js internally uses
export type AvailableInnertubeClient =
   | 'IOS'
   | 'WEB'
   | 'MWEB'
   | 'ANDROID'
   | 'ANDROID_VR'
   | 'VISIONOS'
   | 'YTMUSIC'
   | 'YTMUSIC_ANDROID'
   | 'YTSTUDIO_ANDROID'
   | 'TV'
   | 'TV_SAMSUNG'
   | 'TV_SIMPLY'
   | 'TV_EMBEDDED'
   | 'YTKIDS'
   | 'WEB_EMBEDDED'
   | 'WEB_CREATOR';

/** A stream whose URL may be requested from `availableAt` (epoch ms) on. */
export type TimedRemoteStream = RemoteStream & { availableAt: number };
