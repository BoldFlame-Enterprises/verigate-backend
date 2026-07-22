import { LIVE_CACHE_WINDOW_MS, windowedCacheKey } from '../cacheWindow';

describe('windowed cache keys', () => {
  it('shares a key within the same time window', () => {
    expect(windowedCacheKey('analytics:7:breakdown', LIVE_CACHE_WINDOW_MS, 10_000))
      .toBe('analytics:7:breakdown:2');
    expect(windowedCacheKey('analytics:7:breakdown', LIVE_CACHE_WINDOW_MS, 14_999))
      .toBe('analytics:7:breakdown:2');
  });

  it('moves to a new key at the next window boundary', () => {
    expect(windowedCacheKey('event:7:dashboard', LIVE_CACHE_WINDOW_MS, 15_000))
      .toBe('event:7:dashboard:3');
  });

  it('rejects an invalid cache window', () => {
    expect(() => windowedCacheKey('event:7:dashboard', 0, 15_000))
      .toThrow('Cache window must be a positive number of milliseconds');
  });
});
