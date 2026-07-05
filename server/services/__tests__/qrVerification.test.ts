import crypto from 'crypto';

jest.mock('../../config/database', () => ({
  getDB: jest.fn(),
}));

import { getDB } from '../../config/database';
import { signQrData, verifyQrSignature, verifyQrForArea } from '../qrVerification';

function buildSignedQr(payload: Record<string, any>, secret = 'event_secret_key_2024') {
  const dataString = JSON.stringify(payload);
  const signature = crypto.createHash('sha256').update(dataString + secret).digest('hex');
  return JSON.stringify({ data: dataString, signature, timestamp: payload.timestamp });
}

describe('signQrData', () => {
  it('matches the sha256(data + secret) scheme used by verigate-pass/verigate-scan', () => {
    const data = JSON.stringify({ user_id: 1 });
    const expected = crypto.createHash('sha256').update(data + 'event_secret_key_2024').digest('hex');
    expect(signQrData(data)).toBe(expected);
  });
});

describe('verifyQrSignature', () => {
  const basePayload = {
    user_id: 42,
    email: 'user@test.com',
    name: 'Test User',
    access_level: 'VIP',
    allowed_areas: ['Main Arena'],
    timestamp: Date.now(),
    expires_at: Date.now() + 60_000,
  };

  it('accepts a correctly signed, unexpired payload', () => {
    const qr = buildSignedQr(basePayload);
    const result = verifyQrSignature(qr);
    expect(result.valid).toBe(true);
    expect(result.payload?.user_id).toBe(42);
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const parsed = JSON.parse(buildSignedQr(basePayload));
    parsed.data = JSON.stringify({ ...basePayload, user_id: 999 });
    const result = verifyQrSignature(JSON.stringify(parsed));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/tampered|invalid/i);
  });

  it('rejects an expired QR payload', () => {
    const expired = { ...basePayload, expires_at: Date.now() - 1000 };
    const qr = buildSignedQr(expired);
    const result = verifyQrSignature(qr);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it('rejects malformed JSON', () => {
    const result = verifyQrSignature('not json');
    expect(result.valid).toBe(false);
  });

  it('rejects a QR signed with the wrong secret', () => {
    const qr = buildSignedQr(basePayload, 'wrong-secret');
    const result = verifyQrSignature(qr);
    expect(result.valid).toBe(false);
  });
});

describe('verifyQrForArea', () => {
  const payload = {
    user_id: 7,
    email: 'vip@test.com',
    name: 'VIP Guest',
    access_level: 'VIP',
    allowed_areas: ['Main Arena'],
    timestamp: Date.now(),
    expires_at: Date.now() + 60_000,
  };

  it('grants access when the user is active and has a matching active assignment', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'VIP Guest', email: 'vip@test.com', is_active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 3, name: 'Main Arena', is_active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 99, access_level_name: 'VIP' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const qr = buildSignedQr(payload);
    const result = await verifyQrForArea(qr, 3, 1);

    expect(result.access_granted).toBe(true);
    expect(result.user?.id).toBe(7);
    expect(result.area?.id).toBe(3);
  });

  it('denies access when there is no active assignment for the area', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'VIP Guest', email: 'vip@test.com', is_active: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 3, name: 'Main Arena', is_active: true }] })
      .mockResolvedValueOnce({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const qr = buildSignedQr(payload);
    const result = await verifyQrForArea(qr, 3, 1);

    expect(result.access_granted).toBe(false);
    expect(result.reason).toMatch(/no active access assignment/i);
  });

  it('denies access for an inactive user without ever returning a hardcoded identity', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 7, name: 'VIP Guest', email: 'vip@test.com', is_active: false }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const qr = buildSignedQr(payload);
    const result = await verifyQrForArea(qr, 3, 1);

    expect(result.access_granted).toBe(false);
    expect(result.user).toBeUndefined();
  });

  it('denies access for a bad signature without hitting the database', async () => {
    const query = jest.fn();
    (getDB as jest.Mock).mockReturnValue({ query });

    const result = await verifyQrForArea('garbage', 3, 1);

    expect(result.access_granted).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
