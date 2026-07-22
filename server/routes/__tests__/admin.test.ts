import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../config/redis', () => ({ getCache: jest.fn(), setCache: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAdmin: (req: any, _res: any, next: any) => { req.user = { id: 1, email: 'admin@test.com', role: 'admin' }; next(); },
}));

import { getDB } from '../../config/database';
import { getCache, setCache } from '../../config/redis';
import adminRouter from '../admin';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

describe('GET /api/admin/dashboard', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(12_345);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requires event_id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/admin/dashboard');
    expect(res.status).toBe(400);
  });

  it('returns cached data without querying the DB on a cache hit', async () => {
    const cached = { event_id: 5, members: 10 };
    (getCache as jest.Mock).mockResolvedValue(JSON.stringify(cached));
    const query = jest.fn();
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/admin/dashboard?event_id=5');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(cached);
    expect(query).not.toHaveBeenCalled();
  });

  it('computes real aggregates from the DB on a cache miss and caches the result', async () => {
    (getCache as jest.Mock).mockResolvedValue(null);
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ count: '12' }] }) // members
      .mockResolvedValueOnce({ rows: [{ count: '3' }] }) // areas
      .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // access_levels
      .mockResolvedValueOnce({ rows: [{ granted: '8', denied: '2', last_24h: '4' }] }) // scan stats
      .mockResolvedValueOnce({ rows: [{ area_id: 1, area_name: 'Main Arena', granted: '8', denied: '2' }] }) // scans_by_area
      .mockResolvedValueOnce({ rows: [{ access_level_id: 1, access_level_name: 'VIP', count: '5' }] }) // assignments_by_access_level
      .mockResolvedValueOnce({ rows: [{ id: 1, user_name: 'VIP Guest' }] }) // recent_scans
      .mockResolvedValueOnce({ rows: [{ scanner_user_id: 2, scanner_name: 'Scanner One' }] }); // device_activity
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/admin/dashboard?event_id=5');

    expect(res.status).toBe(200);
    expect(res.body.data.members).toBe(12);
    expect(res.body.data.scans.total).toBe(10);
    expect(res.body.data.scans.grant_rate).toBeCloseTo(0.8);
    expect(setCache).toHaveBeenCalledWith('event:5:dashboard:2', expect.any(String), 15);
  });
});
