import {
  QR_PROTOCOL_VERSION,
  createTestDeviceKeyPair,
  issueAuthorityCredential,
  signTestPresentation,
} from '../qrProtocol';
import { getDB } from '../../config/database';
import { verifyQrForArea } from '../qrVerification';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));

function buildQr(eventId = 1, areaId = 3) {
  const now = Date.now();
  const device = createTestDeviceKeyPair();
  const credential = issueAuthorityCredential({
    credential_id: 'credential-1',
    credential_version: 'v1',
    user_id: 7,
    email: 'vip@test.com',
    name: 'VIP Guest',
    event_id: eventId,
    device_id: 'device-1',
    device_public_key: device.publicKeyBase64,
    assignments: [{
      area_id: areaId,
      area_name: 'Main Arena',
      access_level_id: 2,
      access_level_name: 'VIP',
      access_priority: 10,
      valid_from: new Date(now - 60_000).toISOString(),
      valid_until: new Date(now + 60_000).toISOString(),
    }],
    issued_at: now - 1_000,
    expires_at: now + 60_000,
  });
  return JSON.stringify(signTestPresentation({
    version: QR_PROTOCOL_VERSION,
    credential,
    issued_at: now,
    expires_at: now + 30_000,
    nonce: 'nonce-1',
  }, device.privateKey));
}

describe('verifyQrForArea', () => {
  beforeEach(() => jest.clearAllMocks());

  it('grants only when the current database authorizes the signed credential version', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{
        id: 7,
        name: 'VIP Guest',
        email: 'vip@test.com',
        is_active: true,
        area_id: 3,
        area_name: 'Main Arena',
        area_active: true,
        access_level_name: 'VIP',
      }],
    });
    (getDB as jest.Mock).mockReturnValue({
      query,
    });

    const result = await verifyQrForArea(buildQr(), 3, 1);

    expect(result.access_granted).toBe(true);
    expect(result.credential_id).toBe('credential-1');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('dc.credential_version = $6'),
      [7, 1, 3, 'device-1', expect.any(String), 'v1']
    );
  });

  it('rejects cross-event presentation before database access', async () => {
    const query = jest.fn();
    (getDB as jest.Mock).mockReturnValue({ query });

    const result = await verifyQrForArea(buildQr(2), 3, 1);

    expect(result.access_granted).toBe(false);
    expect(result.reason).toMatch(/different event/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a stale or revoked credential', async () => {
    (getDB as jest.Mock).mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    });

    const result = await verifyQrForArea(buildQr(), 3, 1);
    expect(result.access_granted).toBe(false);
    expect(result.reason).toMatch(/revoked|stale/i);
  });

  it('rejects malformed QR without database access', async () => {
    const query = jest.fn();
    (getDB as jest.Mock).mockReturnValue({ query });
    const result = await verifyQrForArea('not-json', 3, 1);
    expect(result.access_granted).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
