import type { SyncProjectConfigRequest } from '../durable-objects/api-key-rate-limiter';

export interface ParsedProjectConfigPayload {
   projectID: string;
   config: SyncProjectConfigRequest;
}
