import { deleteCache } from '../config/redis';

export function scanReadCacheKeys(eventId: number): string[] {
  return [
    `event:${eventId}:dashboard`,
    `analytics:${eventId}:scan-volume`,
    `analytics:${eventId}:breakdown`,
  ];
}

export async function invalidateScanReadCaches(eventId: number): Promise<void> {
  await Promise.all(scanReadCacheKeys(eventId).map((key) => deleteCache(key)));
}
