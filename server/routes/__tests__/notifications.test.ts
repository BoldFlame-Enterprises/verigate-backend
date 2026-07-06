import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../services/push', () => ({ sendPushToUsers: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAdmin: (req: any, _res: any, next: any) => { req.user = req.user || { id: 1, email: 'admin@test.com', role: 'admin' }; next(); },
}));

import { getDB } from '../../config/database';
import { sendPushToUsers } from '../../services/push';
import notificationsRouter from '../notifications';

function buildApp(user?: { id: number; email: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/notifications', notificationsRouter);
  return app;
}

describe('POST /api/notifications/register-device', () => {
  it('upserts the token scoped to the authenticated user', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, user_id: 3, event_id: 5, platform: 'android', is_active: true }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 3, email: 'attendee@test.com', role: 'user' });
    const res = await request(app).post('/api/notifications/register-device').send({
      event_id: 5, token: 'device-token-1', platform: 'android',
    });

    expect(res.status).toBe(201);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (token)');
    expect(query.mock.calls[0][1]).toEqual([3, 5, 'device-token-1', 'android']);
  });
});

describe('POST /api/notifications/unregister-device', () => {
  it('scopes deactivation to the caller\'s own token', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 3, email: 'attendee@test.com', role: 'user' });
    const res = await request(app).post('/api/notifications/unregister-device').send({ token: 'device-token-1' });

    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('user_id = $2');
    expect(query.mock.calls[0][1]).toEqual(['device-token-1', 3]);
  });
});

describe('POST /api/notifications/send', () => {
  it('sends to explicit user_ids without querying event_members', async () => {
    (sendPushToUsers as jest.Mock).mockResolvedValue({ attempted: 1, sent: 1, failed: 0, skippedIosDisabled: 0 });
    const query = jest.fn();
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/notifications/send').send({
      event_id: 5, title: 'Hello', body: 'World', user_ids: [3, 4],
    });

    expect(res.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
    expect(sendPushToUsers).toHaveBeenCalledWith(5, [3, 4], { title: 'Hello', body: 'World', data: undefined });
  });

  it('falls back to every active event member when no user_ids are given', async () => {
    (sendPushToUsers as jest.Mock).mockResolvedValue({ attempted: 2, sent: 2, failed: 0, skippedIosDisabled: 0 });
    const query = jest.fn().mockResolvedValue({ rows: [{ user_id: 1 }, { user_id: 2 }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/notifications/send').send({
      event_id: 5, title: 'Hello', body: 'World',
    });

    expect(res.status).toBe(200);
    expect(sendPushToUsers).toHaveBeenCalledWith(5, [1, 2], expect.any(Object));
  });
});

describe('POST /api/notifications/sync-heartbeat', () => {
  it('writes to last_sync_at by default', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/notifications/sync-heartbeat').send({
      device_id: 'device-1', app: 'scan', event_id: 5,
    });

    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('last_sync_at');
    expect(query.mock.calls[0][0]).not.toContain('last_scan_upload_at =');
  });

  it('writes to last_scan_upload_at when kind is scan_upload', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/notifications/sync-heartbeat').send({
      device_id: 'device-1', app: 'scan', event_id: 5, kind: 'scan_upload',
    });

    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('last_scan_upload_at = NOW()');
  });
});

describe('GET /api/notifications/device-status', () => {
  it('classifies devices as online, stale, offline, or unknown from seconds_since_sync', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        { device_id: 'd-online', seconds_since_sync: 30 },
        { device_id: 'd-stale', seconds_since_sync: 300 },
        { device_id: 'd-offline', seconds_since_sync: 5000 },
        { device_id: 'd-unknown', seconds_since_sync: null },
      ],
    });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).get('/api/notifications/device-status?event_id=5');

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((d: any) => [d.device_id, d.status]));
    expect(byId['d-online']).toBe('online');
    expect(byId['d-stale']).toBe('stale');
    expect(byId['d-offline']).toBe('offline');
    expect(byId['d-unknown']).toBe('unknown');
    // Confirms the GREATEST (not COALESCE) fix: query merges both timestamp columns.
    expect(query.mock.calls[0][0]).toContain('GREATEST(ds.last_sync_at, ds.last_scan_upload_at)');
  });
});
