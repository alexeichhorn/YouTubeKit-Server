import { expect, it } from 'vitest';
import { applyEmbeddedPlayerConfig, extractEmbeddedPlayerConfig } from '../src/youtube/embedded-player';

it('pairs embedded host flags with the embed-page identity without changing other clients', async () => {
   const html = `<script>ytcfg.set({
      "INNERTUBE_CONTEXT":{"client":{"visitorData":"embed-visitor","clientVersion":"2.20261023.01.00"}},
      "WEB_PLAYER_CONTEXT_CONFIGS":{
         "WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH":{"encryptedHostFlags":"wrong-flags"},
         "WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER":{"encryptedHostFlags":"embed-flags\\u003d"}
      }
   });</script>`;
   const config = extractEmbeddedPlayerConfig(html);
   expect(config.encryptedHostFlags).toBe('embed-flags=');

   const body = {
      videoId: 'test-video',
      context: { client: { visitorData: 'watch-visitor', clientVersion: 'old', browserName: 'Chrome' } },
      playbackContext: { contentPlaybackContext: { encryptedHostFlags: config.encryptedHostFlags, signatureTimestamp: 20746 } },
   };
   const request = new Request('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '56', 'X-Goog-Visitor-Id': 'watch-visitor' },
      body: JSON.stringify(body),
   });
   const updated = await applyEmbeddedPlayerConfig(request, config);
   expect(updated.headers.get('X-Goog-Visitor-Id')).toBe('embed-visitor');
   expect(updated.headers.get('X-Youtube-Client-Version')).toBe(config.clientVersion);
   expect(updated.headers.get('User-Agent')).toContain('Version/15.5 Safari/605.1.15');
   expect(await updated.json()).toEqual({
      ...body,
      context: {
         client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: config.clientVersion, clientScreen: 'EMBED' },
         thirdParty: { embedUrl: 'https://www.reddit.com/' },
      },
   });

   const web = new Request(request.url, { method: 'POST', headers: { 'X-Youtube-Client-Name': '1' }, body: JSON.stringify(body) });
   expect(await applyEmbeddedPlayerConfig(web, config)).toBe(web);
   expect(await web.json()).toEqual(body);
   expect(() => extractEmbeddedPlayerConfig('ytcfg.set({});')).toThrow('missing host flags');
});
