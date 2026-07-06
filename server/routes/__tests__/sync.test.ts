import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../config/redis', () => ({ getCache: jest.fn(), setCache: jest.fn() }));

import { getDB } from '../../config/database';
import { getCache, setCache } from '../../config/redis';
import syncRouter from '../sync';

function buildApp(user?: { id: number; email: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/sync', syncRouter);
  return app;
}

describe('GET /api/sync/users-database', () => {
  it('requires event_id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/sync/users-database');
    expect(res.status).toBe(400);
  });

  it('returns cached data without querying the DB on a cache hit', async () => {
    const cached = { users: [{ id: 1 }], metadata: { count: 1 } };
    (getCache as jest.Mock).mockResolvedValue(JSON.stringify(cached));
    const query = jest.fn();
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/sync/users-database?event_id=5');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(cached);
    expect(query).not.toHaveBeenCalled();
  });

  it('builds and caches a real payload on a cache miss', async () => {
    (getCache as jest.Mock).mockResolvedValue(null);
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 1, email: 'vip@test.com', name: 'VIP', phone: '1', access_level: 'VIP', access_priority: 5, allowed_areas: ['Main Arena'], allowed_area_ids: [1], is_active: true }],
    });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/sync/users-database?event_id=5');

    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(1);
    expect(res.body.data.metadata.checksum).toBeDefined();
    expect(setCache).toHaveBeenCalledWith('sync:users-database:5', expect.any(String), 30);
  });
});

describe('POST /api/sync/scan-logs', () => {
  it('rejects a request without an event_id', async () => {
    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/sync/scan-logs').send({ logs: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a request whose logs field is not an array', async () => {
    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/sync/scan-logs').send({ logs: 'oops', event_id: 1 });
    expect(res.status).toBe(400);
  });

  it('counts processed vs duplicate logs based on ON CONFLICT de-dup', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 101 }] }) // first log inserted
      .mockResolvedValueOnce({ rows: [] }); // second log was a duplicate (device_scan_id conflict)
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/sync/scan-logs').send({
      event_id: 5,
      device_id: 'device-1',
      logs: [
        { user_id: 1, area_id: 1, access_granted: true, scanned_at: new Date().toISOString(), device_scan_id: 'uuid-1' },
        { user_id: 1, area_id: 1, access_granted: true, scanned_at: new Date().toISOString(), device_scan_id: 'uuid-1' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(1);
    expect(res.body.data.duplicates).toBe(1);
    expect(res.body.data.total).toBe(2);
  });
});

describe('GET /api/sync/check-updates', () => {
  it('reports an update available when the current version is newer', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ last_update: '2000' }] })
      .mockResolvedValueOnce({ rows: [{ last_update: '3000' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/sync/check-updates?event_id=5&users_version=1000&areas_version=1000');

    expect(res.status).toBe(200);
    expect(res.body.data.users_update_available).toBe(true);
    expect(res.body.data.areas_update_available).toBe(true);
  });
});
