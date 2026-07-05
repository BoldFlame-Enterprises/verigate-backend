import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../services/qrVerification', () => ({ verifyQrForArea: jest.fn() }));

import { getDB } from '../../config/database';
import { verifyQrForArea } from '../../services/qrVerification';
import scanRouter from '../scan';

function buildApp(user?: { id: number; email: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/scan', scanRouter);
  return app;
}

describe('POST /api/scan/verify', () => {
  it('returns 400 when required fields are missing', async () => {
    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/scan/verify').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('logs the scan and returns the real verification result (no hardcoded identity)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    (getDB as jest.Mock).mockReturnValue({ query });
    (verifyQrForArea as jest.Mock).mockResolvedValue({
      access_granted: true,
      user: { id: 7, name: 'VIP Guest', email: 'vip@test.com', access_level: 'VIP' },
      area: { id: 3, name: 'Main Arena' },
    });

    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/scan/verify').send({
      qr_code: 'signed-qr-payload',
      area_id: 3,
      event_id: 1,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.access_granted).toBe(true);
    expect(res.body.data.user.name).not.toBe('Demo User');
    expect(res.body.data.user.name).toBe('VIP Guest');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO scan_logs'),
      expect.arrayContaining([1, 7, 3, 1, true])
    );
  });

  it('logs a denial with the real failure reason', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 2 }] });
    (getDB as jest.Mock).mockReturnValue({ query });
    (verifyQrForArea as jest.Mock).mockResolvedValue({
      access_granted: false,
      reason: 'No active access assignment for this area',
    });

    const app = buildApp({ id: 1, email: 'scanner@test.com', role: 'scanner' });
    const res = await request(app).post('/api/scan/verify').send({
      qr_code: 'signed-qr-payload',
      area_id: 3,
      event_id: 1,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.access_granted).toBe(false);
    expect(res.body.data.reason).toBe('No active access assignment for this area');
  });
});
