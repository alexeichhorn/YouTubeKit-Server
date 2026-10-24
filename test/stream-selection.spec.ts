import { expect, it } from 'vitest';
import { Innertube } from 'youtubei.js';
import { YouTubeService } from '../src/youtube/service';

it('prefers Samsung clear formats while keeping clear alternatives to DRM formats', async () => {
   const clients: string[] = [];
   const innertube = await Innertube.create({
      generate_session_locally: true,
      retrieve_player: false,
      retrieve_innertube_config: false,
      fetch: async (input, init) => {
         const request = new Request(input, init);
         if (!new URL(request.url).pathname.endsWith('/player')) return Response.json({});
         const { context } = await request.json<{ context: { client: { clientName: string } } }>();
         const client = context.client.clientName;
         clients.push(client);
         const format = {
            mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 1000,
            qualityLabel: '1080p', width: 1920, height: 1080,
         };
         const formats = client === 'TVHTML5' ? [
            { ...format, itag: 137, url: 'https://example.com/drm', drmFamilies: ['WIDEVINE'] },
            { ...format, itag: 136, url: 'https://example.com/samsung-clear', drmFamilies: [] },
         ] : client === 'VISIONOS' ? [
            { ...format, itag: 137, url: 'https://example.com/vision-clear' },
            { ...format, itag: 136, url: 'https://example.com/vision-duplicate' },
         ] : [];
         return Response.json({ playabilityStatus: { status: 'OK' }, streamingData: { formats, adaptiveFormats: [] } });
      },
   });
   const service = new YouTubeService('test-video', new WebSocketPair()[1]);
   const streams = await service['getStreams'](innertube, async () => { throw new Error('Unexpected embedded fallback'); });
   expect(clients).toEqual(['TVHTML5', 'VISIONOS', 'WEB']);
   expect(streams.map(({ itag, url }) => ({ itag, url }))).toEqual([
      { itag: 136, url: 'https://example.com/samsung-clear' },
      { itag: 137, url: 'https://example.com/vision-clear' },
   ]);
});
