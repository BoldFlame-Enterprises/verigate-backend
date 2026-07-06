import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../services/qrVerification', () => ({
  signQrData: jest.fn().mockReturnValue('mock-signature'),
  verifyQrForArea: jest.fn(),
}));

import { getDB } from '../../config/database';
import { verifyQrForArea } from '../../services/qrVerification';
import qrRouter from '../qr';

function buildApp(user?: { id: number; email: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/qr', qrRouter);
  return app;
}

describe('GET /api/qr/generate', () => {
  it('requires event_id', async () => {
    const app = buildApp({ id: 1, email: 'vip@test.com', role: 'user' });
    const res = await request(app).get('/api/qr/generate');
    expect(res.status).toBe(400);
  });

  it('returns 401 when there is no authenticated user', async () => {
    const app = buildApp(undefined);
    const res = await request(app).get('/api/qr/generate?event_id=1');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an inactive/missing user', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'vip@test.com', role: 'user' });
    const res = await request(app).get('/api/qr/generate?event_id=1');

    expect(res.status).toBe(404);
  });

  it('builds a signed, event-scoped QR payload for a real user', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 7, email: 'vip@test.com', name: 'VIP Guest', is_active: true, access_level: 'VIP', access_priority: 5, allowed_areas: ['Main Arena'] }],
    });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 7, email: 'vip@test.com', role: 'user' });
    const res = await request(app).get('/api/qr/generate?event_id=1');

    expect(res.status).toBe(200);
    const qrContent = JSON.parse(res.body.data.qr_content);
    expect(qrContent.signature).toBe('mock-signature');
    const payload = JSON.parse(qrContent.data);
    expect(payload.user_id).toBe(7);
    expect(payload.event_id).toBe(1);
    expect(res.body.data.user_info.name).toBe('VIP Guest');
  });
});

describe('POST /api/qr/verify', () => {
  it('delegates to the same real verification function as /api/scan/verify', async () => {
    (verifyQrForArea as jest.Mock).mockResolvedValue({ access_granted: true, user: { id: 7, name: 'VIP Guest' } });

    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/qr/verify').send({
      qr_content: 'signed-payload', area_id: 3, event_id: 1,
    });

    expect(res.status).toBe(200);
    expect(verifyQrForArea).toHaveBeenCalledWith('signed-payload', 3, 1);
    expect(res.body.data.access_granted).toBe(true);
  });

  it('rejects a caller with role "user" (only scanner/admin may verify)', async () => {
    const app = buildApp({ id: 1, email: 'attendee@test.com', role: 'user' });
    const res = await request(app).post('/api/qr/verify').send({
      qr_content: 'signed-payload', area_id: 3, event_id: 1,
    });

    expect(res.status).toBe(403);
  });
});
