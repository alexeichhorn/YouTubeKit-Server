export interface EmbeddedPlayerConfig {
   encryptedHostFlags: string;
   visitorData: string;
   clientVersion: string;
}

export function extractEmbeddedPlayerConfig(html: string): EmbeddedPlayerConfig {
   const match = html.match(/ytcfg\.set\s*\(\s*(\{.*?\})\s*\);/s);
   if (!match) {
      throw new Error('Embedded player config is missing');
   }

   const config = JSON.parse(match[1]);
   const encryptedHostFlags = config.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER?.encryptedHostFlags;
   const visitorData = config.VISITOR_DATA ?? config.INNERTUBE_CONTEXT?.client?.visitorData;
   const clientVersion = config.INNERTUBE_CONTEXT?.client?.clientVersion;
   if (![encryptedHostFlags, visitorData, clientVersion].every(value => typeof value === 'string' && value.length > 0)) {
      throw new Error('Embedded player config is missing host flags, visitor data, or client version');
   }

   return { encryptedHostFlags, visitorData, clientVersion };
}

export async function applyEmbeddedPlayerConfig(request: Request, config?: EmbeddedPlayerConfig): Promise<Request> {
   if (!config || request.headers.get('X-Youtube-Client-Name') !== '56') {
      return request;
   }

   const body = await request.json<Record<string, unknown>>();
   // The embedded player must use its own identity, without inherited web-session fields.
   body.context = {
      client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: config.clientVersion, clientScreen: 'EMBED' },
      thirdParty: { embedUrl: 'https://www.reddit.com/' },
   };
   request.headers.set('X-Goog-Visitor-Id', config.visitorData);
   request.headers.set('X-Youtube-Client-Version', config.clientVersion);
   request.headers.set(
      'User-Agent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)'
   );
   return new Request(request, { body: JSON.stringify(body) });
}
