jest.mock('../../config/redis', () => ({ deleteCache: jest.fn() }));

import { deleteCache } from '../../config/redis';
import { invalidateScanReadCaches, scanReadCacheKeys } from '../scanReadCache';

describe('scan read cache invalidation', () => {
  it('targets every scan-derived read model for the event', () => {
    expect(scanReadCacheKeys(7)).toEqual([
      'event:7:dashboard',
      'analytics:7:scan-volume',
      'analytics:7:breakdown',
    ]);
  });

  it('deletes every scan-derived cache key', async () => {
    (deleteCache as jest.Mock).mockResolvedValue(undefined);

    await invalidateScanReadCaches(7);

    expect(deleteCache).toHaveBeenCalledTimes(3);
    expect(deleteCache).toHaveBeenCalledWith('event:7:dashboard');
    expect(deleteCache).toHaveBeenCalledWith('analytics:7:scan-volume');
    expect(deleteCache).toHaveBeenCalledWith('analytics:7:breakdown');
  });
});
