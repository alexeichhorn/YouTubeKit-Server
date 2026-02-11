import type { SyncProjectConfigRequest } from '../durable-objects/api-key-rate-limiter';

export interface ParsedProjectConfigPayload {
   projectID: string;
   config: SyncProjectConfigRequest;
}

export function parseProjectConfigPayload(payload: unknown): ParsedProjectConfigPayload | null {
   if (!payload || typeof payload !== 'object') {
      return null;
   }

   const raw = payload as Record<string, unknown>;
   const projectID = typeof raw.projectID === 'string' ? raw.projectID.trim() : '';
   if (!projectID) {
      return null;
   }

   const version = Number(raw.version);
   if (!Number.isInteger(version)) {
      return null;
   }

   const keysRaw = raw.keys;
   if (!Array.isArray(keysRaw)) {
      return null;
   }

   const keys = keysRaw.map((entry): SyncProjectConfigRequest['keys'][number] | null => {
      if (!entry || typeof entry !== 'object') {
         return null;
      }
      const key = entry as Record<string, unknown>;

      const keyID = typeof key.keyID === 'string' ? key.keyID : null;
      const secretHash = typeof key.secretHash === 'string' ? key.secretHash : null;
      const status = parseKeyStatus(key.status);
      const keyPolicy = parseNullablePolicyObject(key.keyPolicy);

      if (!keyID || !secretHash || !status || keyPolicy === undefined) {
         return null;
      }

      return {
         keyID,
         secretHash,
         status,
         keyPolicy,
      };
   });

   if (keys.some((key) => key === null)) {
      return null;
   }

   const projectPolicy = parseNullablePolicyObject(raw.projectPolicy);
   if (projectPolicy === undefined) {
      return null;
   }

   return {
      projectID,
      config: {
         version,
         projectPolicy,
         keys: keys as SyncProjectConfigRequest['keys'],
      },
   };
}

function parseKeyStatus(value: unknown): 'active' | 'revoked' | null {
   if (value === 'active' || value === 'revoked') {
      return value;
   }

   return null;
}

function parseNullablePolicyObject(value: unknown):
   | {
        dailyLimit?: number | null;
        weeklyLimit?: number | null;
        monthlyLimit?: number | null;
     }
   | undefined {
   if (value === undefined || value === null) {
      return {};
   }
   if (typeof value !== 'object') {
      return undefined;
   }

   const raw = value as Record<string, unknown>;

   const dailyLimit = parseNullableLimit(raw.dailyLimit);
   const weeklyLimit = parseNullableLimit(raw.weeklyLimit);
   const monthlyLimit = parseNullableLimit(raw.monthlyLimit);
   if (dailyLimit === undefined || weeklyLimit === undefined || monthlyLimit === undefined) {
      return undefined;
   }

   return {
      dailyLimit,
      weeklyLimit,
      monthlyLimit,
   };
}

function parseNullableLimit(value: unknown): number | null | undefined {
   if (value === undefined) {
      return null;
   }
   if (value === null) {
      return null;
   }

   const parsed = Number(value);
   if (!Number.isFinite(parsed)) {
      return undefined;
   }

   return parsed;
}
