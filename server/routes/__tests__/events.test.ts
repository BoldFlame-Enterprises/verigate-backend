import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../config/redis', () => ({ getCache: jest.fn(), setCache: jest.fn(), deleteCache: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  // Pass-through only - req.user is set by the test's own injected middleware
  // so GET / can be exercised with both admin and non-admin roles.
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import { getDB } from '../../config/database';
import eventsRouter from '../events';

function buildApp(user: { id: number; email: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/events', eventsRouter);
  return app;
}

describe('GET /api/events', () => {
  it('returns every event for an admin', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Event A' }, { id: 2, name: 'Event B' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).get('/api/events');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(query.mock.calls[0][0]).not.toContain('event_members');
  });

  it('scopes to membership for a non-admin user', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, name: 'Event A' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 2, email: 'user@test.com', role: 'user' });
    const res = await request(app).get('/api/events');

    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('event_members');
    expect(query.mock.calls[0][1]).toEqual([2]);
  });
});

describe('POST /api/events', () => {
  it('rejects a duplicate slug', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 9 }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/events').send({ name: 'Demo Event', slug: 'demo-event' });

    expect(res.status).toBe(409);
  });

  it('creates a new event', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 10, name: 'Demo Event', slug: 'demo-event' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/events').send({ name: 'Demo Event', slug: 'demo-event' });

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('demo-event');
  });

  it('rejects an invalid slug', async () => {
    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/events').send({ name: 'Demo Event', slug: 'not a slug!' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/events/:id/members', () => {
  it('upserts a membership row', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, event_id: 5, user_id: 3, role_in_event: 'attendee' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/events/5/members').send({ user_id: 3 });

    expect(res.status).toBe(201);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (event_id, user_id)');
  });
});

describe('DELETE /api/events/:id/members/:userId', () => {
  it('returns 404 when the membership does not exist', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).delete('/api/events/5/members/3');

    expect(res.status).toBe(404);
  });
});
