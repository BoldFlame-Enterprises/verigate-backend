import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../config/redis', () => ({ getCache: jest.fn(), setCache: jest.fn(), deleteCache: jest.fn() }));
jest.mock('../../services/push', () => ({ sendPushToUsers: jest.fn().mockResolvedValue({ attempted: 0, sent: 0, failed: 0, skippedIosDisabled: 0 }) }));
jest.mock('../../middleware/auth', () => ({
  requireAdmin: (req: any, _res: any, next: any) => { req.user = { id: 1, email: 'admin@test.com', role: 'admin' }; next(); },
}));

import { getDB } from '../../config/database';
import { deleteCache } from '../../config/redis';
import accessRouter from '../access';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/access', accessRouter);
  return app;
}

describe('GET /api/access', () => {
  it('requires event_id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/access');
    expect(res.status).toBe(400);
  });

  it('scopes access levels to the requested event', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, event_id: 5, name: 'VIP', priority: 5, is_active: true }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/access?event_id=5');

    expect(res.status).toBe(200);
    expect(res.body.data[0].event_id).toBe(5);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE event_id = $1'), [5]);
  });
});

describe('POST /api/access/assignments', () => {
  it('upserts respecting the (user_id, area_id, event_id) constraint and invalidates caches', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ level_ok: 1, area_ok: 1 }] }) // cross-event scope check
      .mockResolvedValueOnce({ rows: [] }) // event_members insert
      .mockResolvedValueOnce({ rows: [{ id: 10, event_id: 5, user_id: 2, access_level_id: 1, area_id: 3, is_active: true }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).post('/api/access/assignments').send({
      event_id: 5, user_id: 2, access_level_id: 1, area_id: 3
    });

    expect(res.status).toBe(201);
    expect(query.mock.calls[2][0]).toContain('ON CONFLICT (user_id, area_id, event_id)');
    expect(deleteCache).toHaveBeenCalledWith('sync:users-database:5');
  });

  it('rejects an access_level_id/area_id that belongs to a different event', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ level_ok: null, area_ok: 1 }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).post('/api/access/assignments').send({
      event_id: 5, user_id: 2, access_level_id: 999, area_id: 3
    });

    expect(res.status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
