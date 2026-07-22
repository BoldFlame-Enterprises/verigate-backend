export const LIVE_CACHE_WINDOW_MS = 5_000;

export function windowedCacheKey(
  baseKey: string,
  windowMs: number = LIVE_CACHE_WINDOW_MS,
  now: number = Date.now()
): string {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('Cache window must be a positive number of milliseconds');
  }

  return `${baseKey}:${Math.floor(now / windowMs)}`;
}
