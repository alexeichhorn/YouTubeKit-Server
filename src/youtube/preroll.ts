// Stream URLs of a player response with preroll ads return 403 until those ads could have been watched or skipped.
// Requesting them earlier can make them fail permanently (see https://github.com/alexeichhorn/YouTubeKit/issues/94).
// Mirrors YouTubeKit's `InnerTube+PrerollAds.swift`; ad JSON is untrusted, so anything unexpected counts as no wait.

/** Milliseconds after receiving the raw `/player` response until its stream URLs may be requested. */
export function prerollWaitMs(playerResponse: any): number {
   const slotAds = asArray(playerResponse?.adSlots)
      .filter(slot => slot?.adSlotRenderer?.adSlotMetadata?.triggerEvent === 'SLOT_TRIGGER_EVENT_BEFORE_CONTENT')
      .flatMap(slot => videoAds(slot.adSlotRenderer.fulfillmentContent?.fulfilledLayout));
   const placementAds = asArray(playerResponse?.adPlacements)
      .filter(placement => placement?.adPlacementRenderer?.config?.adPlacementConfig?.kind === 'AD_PLACEMENT_KIND_START')
      .map(placement => placement.adPlacementRenderer.renderer?.instreamVideoAdRenderer);
   return [...slotAds, ...placementAds].reduce((sum, ad) => sum + adWaitMs(ad), 0);
}

/** Ads of a web `playerBytesAdLayoutRenderer`, either direct or nested in a sequential layout. */
function videoAds(layout: any): any[] {
   const content = layout?.playerBytesAdLayoutRenderer?.renderingContent;
   const sequentialAds = asArray(content?.playerBytesSequentialLayoutRenderer?.sequentialLayouts).flatMap(videoAds);
   return [content?.instreamVideoAdRenderer, ...sequentialAds];
}

/** Skippable ads only need to be waited for until they can be skipped. */
function adWaitMs(ad: any): number {
   if (typeof ad?.skipOffsetMilliseconds === 'number') return Math.max(0, ad.skipOffsetMilliseconds);
   const lengthSeconds = typeof ad?.playerVars === 'string' ? Number(new URLSearchParams(ad.playerVars).get('length_seconds')) : 0;
   return lengthSeconds > 0 ? lengthSeconds * 1000 : 0;
}

function asArray(value: unknown): any[] {
   return Array.isArray(value) ? value : [];
}
