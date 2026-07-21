import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../services/qrVerification', () => ({
  verifyQrForArea: jest.fn(),
}));

import { getDB } from '../../config/database';
import { verifyQrForArea } from '../../services/qrVerification';
import qrRouter from '../qr';

const devicePublicKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function generatePath(eventId = 1): string {
  const params = new URLSearchParams({
    event_id: String(eventId),
    device_id: 'device-test-1',
    device_public_key: devicePublicKey,
  });
  return `/api/qr/generate?${params.toString()}`;
}

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
    const res = await request(app).get(generatePath());
    expect(res.status).toBe(401);
  });

  it('returns 404 for an inactive/missing user', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'vip@test.com', role: 'admin' });
    const res = await request(app).get(generatePath());

    expect(res.status).toBe(404);
  });

  it('builds a signed, event-scoped QR payload for a real user', async () => {
    const assignments = [{
      area_id: 3,
      area_name: 'Main Arena',
      access_level_id: 2,
      access_level_name: 'VIP',
      access_priority: 5,
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: '2027-01-01T00:00:00.000Z',
    }];
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 7, email: 'vip@test.com', name: 'VIP Guest', is_active: true, assignments }] })
      .mockResolvedValueOnce({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 7, email: 'vip@test.com', role: 'admin' });
    const res = await request(app).get(generatePath());

    expect(res.status).toBe(200);
    expect(res.body.data.contract_version).toBe('qr-credential-v2');
    expect(res.body.data.credential.payload.user_id).toBe(7);
    expect(res.body.data.credential.payload.event_id).toBe(1);
    expect(res.body.data.credential.payload.assignments).toEqual(assignments);
    expect(res.body.data.credential.authority_signature).toBeTruthy();
    expect(res.body.data.user_info.name).toBe('VIP Guest');
  });
});

describe('POST /api/qr/verify', () => {
  it('delegates to the same real verification function as /api/scan/verify', async () => {
    (verifyQrForArea as jest.Mock).mockResolvedValue({ access_granted: true, user: { id: 7, name: 'VIP Guest' } });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
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
