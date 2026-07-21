import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../config/redis', () => ({ getCache: jest.fn(), setCache: jest.fn(), deleteCache: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAdmin: (req: any, _res: any, next: any) => { req.user = { id: 1, email: 'admin@test.com', role: 'admin' }; next(); },
}));

import { getDB } from '../../config/database';
import { deleteCache } from '../../config/redis';
import areasRouter from '../areas';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 1, email: 'admin@test.com', role: 'admin' };
    next();
  });
  app.use('/api/areas', areasRouter);
  return app;
}

describe('GET /api/areas', () => {
  it('requires event_id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/areas');
    expect(res.status).toBe(400);
  });

  it('scopes areas to the requested event', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, event_id: 5, name: 'Main Arena' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/areas?event_id=5');

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE event_id = $1'), [5]);
  });
});

describe('POST /api/areas', () => {
  it('creates an area and invalidates its sync/analytics caches', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // no existing area with this name
      .mockResolvedValueOnce({ rows: [{ id: 2, event_id: 5, name: 'VIP Lounge' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).post('/api/areas').send({ event_id: 5, name: 'VIP Lounge' });

    expect(res.status).toBe(201);
    expect(deleteCache).toHaveBeenCalledWith('sync:areas-database:5');
    expect(deleteCache).toHaveBeenCalledWith('analytics:5:breakdown');
  });

  it('rejects a duplicate area name within the same event', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 2 }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).post('/api/areas').send({ event_id: 5, name: 'VIP Lounge' });

    expect(res.status).toBe(409);
  });
});

describe('PUT /api/areas/:id', () => {
  it('rejects an update with no fields', async () => {
    const app = buildApp();
    const res = await request(app).put('/api/areas/1').send({});
    expect(res.status).toBe(400);
  });

  it('updates fields and invalidates caches using the row event_id', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, event_id: 7, name: 'Renamed' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).put('/api/areas/1').send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(deleteCache).toHaveBeenCalledWith('sync:areas-database:7');
  });
});

describe('DELETE /api/areas/:id', () => {
  it('deactivates the area and returns 404 if missing', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).delete('/api/areas/999');

    expect(res.status).toBe(404);
  });
});
