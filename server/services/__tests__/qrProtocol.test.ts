import crypto from 'crypto';
import {
  QR_PROTOCOL_VERSION,
  canonicalize,
  createTestDeviceKeyPair,
  issueAuthorityCredential,
  signTestPresentation,
  verifyPresentation,
} from '../qrProtocol';

describe('QR protocol v2', () => {
  const now = Date.now();
  const device = createTestDeviceKeyPair();
  const credential = issueAuthorityCredential({
    credential_id: 'credential-1',
    credential_version: 'assignment-hash',
    user_id: 7,
    email: 'user@test.com',
    name: 'Test User',
    event_id: 4,
    device_id: 'device-1',
    device_public_key: device.publicKeyBase64,
    assignments: [{
      area_id: 3,
      area_name: 'Main Arena',
      access_level_id: 2,
      access_level_name: 'VIP',
      access_priority: 10,
      valid_from: new Date(now - 60_000).toISOString(),
      valid_until: new Date(now + 3_600_000).toISOString(),
    }],
    issued_at: now - 1_000,
    expires_at: now + 3_600_000,
  });

  function presentation() {
    const payload = {
      version: QR_PROTOCOL_VERSION,
      credential: JSON.parse(JSON.stringify(credential)),
      issued_at: now,
      expires_at: now + 30_000,
      nonce: crypto.randomUUID(),
    } as const;
    return signTestPresentation(payload, device.privateKey);
  }

  it('canonicalizes object keys recursively', () => {
    expect(canonicalize({ z: 1, a: { d: 2, b: 1 } }))
      .toBe('{"a":{"b":1,"d":2},"z":1}');
  });

  it('accepts a valid authority credential and device presentation', () => {
    expect(verifyPresentation(JSON.stringify(presentation()), 4, now).valid).toBe(true);
  });

  it('rejects a different event', () => {
    expect(verifyPresentation(JSON.stringify(presentation()), 5, now).reason)
      .toMatch(/different event/i);
  });

  it('rejects authority-payload mutation', () => {
    const value = presentation();
    value.payload.credential.payload.user_id = 99;
    expect(verifyPresentation(JSON.stringify(value), 4, now).reason)
      .toMatch(/authority signature/i);
  });

  it('rejects device-presentation mutation', () => {
    const value = presentation();
    value.payload.nonce = 'forged';
    expect(verifyPresentation(JSON.stringify(value), 4, now).reason)
      .toMatch(/device presentation signature/i);
  });

  it('rejects an expired presentation', () => {
    const value = presentation();
    expect(verifyPresentation(JSON.stringify(value), 4, now + 120_000).reason)
      .toMatch(/expired/i);
  });
});
