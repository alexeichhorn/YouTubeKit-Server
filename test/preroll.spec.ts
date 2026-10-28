import { expect, it } from 'vitest';
import { prerollWaitMs } from '../src/youtube/preroll';

it('sums only preroll ads of web slots and TV placements, ignoring malformed ad JSON', () => {
   const ad = (instreamVideoAdRenderer: unknown) => ({ playerBytesAdLayoutRenderer: { renderingContent: { instreamVideoAdRenderer } } });
   const slot = (triggerEvent: string, fulfilledLayout: unknown) => ({
      adSlotRenderer: { adSlotMetadata: { triggerEvent }, fulfillmentContent: { fulfilledLayout } },
   });
   const placement = (kind: string, instreamVideoAdRenderer: unknown) => ({
      adPlacementRenderer: { config: { adPlacementConfig: { kind } }, renderer: { instreamVideoAdRenderer } },
   });
   expect(prerollWaitMs({
      adSlots: [
         slot('SLOT_TRIGGER_EVENT_BEFORE_CONTENT', ad({ playerVars: 'length_seconds=15&foo=bar' })),
         slot('SLOT_TRIGGER_EVENT_BEFORE_CONTENT', {
            playerBytesAdLayoutRenderer: { renderingContent: { playerBytesSequentialLayoutRenderer: { sequentialLayouts: [
               ad({ skipOffsetMilliseconds: 5000, playerVars: 'length_seconds=30' }),
               ad({ playerVars: 42 }),
            ] } } },
         }),
         slot('SLOT_TRIGGER_EVENT_CORE', ad({ skipOffsetMilliseconds: 99000 })),
         null,
         { adSlotRenderer: 'unexpected' },
      ],
      adPlacements: [
         placement('AD_PLACEMENT_KIND_START', { skipOffsetMilliseconds: 5000 }),
         placement('AD_PLACEMENT_KIND_END', { skipOffsetMilliseconds: 99000 }),
         placement('AD_PLACEMENT_KIND_START', null),
      ],
   })).toBe(25_000);
   expect(prerollWaitMs({ adSlots: {}, adPlacements: 'unexpected' })).toBe(0);
});
