import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../config/redis', () => ({ getCache: jest.fn().mockResolvedValue(null), setCache: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAdmin: (req: any, _res: any, next: any) => { req.user = { id: 1, email: 'admin@test.com', role: 'admin' }; next(); },
}));

import { getDB } from '../../config/database';
import { setCache } from '../../config/redis';
import analyticsRouter from '../analytics';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRouter);
  return app;
}

describe('GET /api/analytics/breakdown', () => {
  it('requires event_id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/analytics/breakdown');
    expect(res.status).toBe(400);
  });

  it('computes a real grant_rate from granted/denied counts and caches the result', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Main Arena', total: '10', granted: '8', denied: '2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'VIP', assigned_users: '4' }] })
      .mockResolvedValueOnce({ rows: [{ id: 2, name: 'Scanner One', scans: '10', granted: '8', denied: '2', last_scan_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ total: '10', granted: '8', denied: '2' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/analytics/breakdown?event_id=5');

    expect(res.status).toBe(200);
    expect(res.body.data.overall.grant_rate).toBeCloseTo(0.8);
    expect(setCache).toHaveBeenCalledWith('analytics:5:breakdown', expect.any(String), 60);
  });
});
