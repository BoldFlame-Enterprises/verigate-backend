import crypto from 'crypto';
import { getDB } from '../config/database';

/**
 * Shared server-side verification for the signed QR payloads produced by the
 * verigate-pass app (DatabaseService.generateSecureQRData). This is the single
 * real verification path used as an online fallback when a scanner's local
 * offline check is inconclusive (per README). Both `/api/scan/verify` and the
 * deprecated `/api/qr/verify` alias call into this function.
 *
 * QR wire format (matches verigate-pass / verigate-scan exactly):
 *   { data: string /* JSON of QRPayload *\/, signature: string /* sha256(data + secret) hex *\/, timestamp: number }
 */

export interface QRPayload {
  user_id: number;
  email: string;
  name: string;
  access_level: string;
  allowed_areas: string[];
  timestamp: number;
  expires_at: number;
  device_fingerprint?: string;
  version?: string;
}

export interface VerifyResult {
  access_granted: boolean;
  reason?: string;
  user?: {
    id: number;
    name: string;
    email: string;
    access_level: string;
  };
  area?: {
    id: number;
    name: string;
  };
}

function getQrSecret(): string {
  return process.env.QR_HMAC_SECRET || 'event_secret_key_2024';
}

export function signQrData(dataString: string): string {
  return crypto.createHash('sha256').update(dataString + getQrSecret()).digest('hex');
}

/**
 * Verifies signature + expiry only (no DB access). Mirrors the offline check
 * both mobile apps already perform locally.
 */
export function verifyQrSignature(qrCode: string): { valid: boolean; payload?: QRPayload; reason?: string } {
  let parsed: { data?: string; signature?: string; timestamp?: number };
  try {
    parsed = JSON.parse(qrCode);
  } catch {
    return { valid: false, reason: 'Invalid QR code format' };
  }

  if (!parsed.data || !parsed.signature || !parsed.timestamp) {
    return { valid: false, reason: 'Invalid QR format' };
  }

  if (Date.now() - parsed.timestamp > 24 * 60 * 60 * 1000) {
    return { valid: false, reason: 'QR code expired' };
  }

  const expectedSignature = signQrData(parsed.data);
  if (parsed.signature !== expectedSignature) {
    return { valid: false, reason: 'QR code signature invalid (tampered or wrong secret)' };
  }

  let payload: QRPayload;
  try {
    payload = JSON.parse(parsed.data);
  } catch {
    return { valid: false, reason: 'Invalid QR payload data' };
  }

  if (payload.expires_at && Date.now() > payload.expires_at) {
    return { valid: false, reason: 'QR code expired' };
  }

  return { valid: true, payload };
}

/**
 * Full server-side verification: signature + expiry + real access-assignment
 * lookup for the requested area. Always returns a real result — never a
 * hardcoded identity.
 *
 * NOTE: as of Phase 2 (multi-event tenancy) this also scopes the area and
 * assignment lookup to the given event; see the event_id predicates below.
 */
export async function verifyQrForArea(
  qrCode: string,
  areaId: number,
  eventId: number
): Promise<VerifyResult> {
  const sig = verifyQrSignature(qrCode);
  if (!sig.valid || !sig.payload) {
    return { access_granted: false, reason: sig.reason || 'Invalid QR code' };
  }

  const payload = sig.payload;
  const db = getDB();

  const userResult = await db.query(
    `SELECT id, name, email, is_active FROM users WHERE id = $1`,
    [payload.user_id]
  );
  if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
    return { access_granted: false, reason: 'User not found or inactive' };
  }
  const user = userResult.rows[0];

  const areaResult = await db.query(
    `SELECT id, name, is_active FROM areas WHERE id = $1 AND event_id = $2`,
    [areaId, eventId]
  );
  if (areaResult.rows.length === 0 || !areaResult.rows[0].is_active) {
    return { access_granted: false, reason: 'Area not found for this event' };
  }
  const area = areaResult.rows[0];

  const assignmentResult = await db.query(
    `SELECT aa.id, al.name as access_level_name
     FROM access_assignments aa
     JOIN access_levels al ON al.id = aa.access_level_id
     WHERE aa.user_id = $1 AND aa.area_id = $2 AND aa.event_id = $3
       AND aa.is_active = true
       AND aa.valid_from <= NOW() AND aa.valid_until >= NOW()`,
    [user.id, area.id, eventId]
  );

  if (assignmentResult.rows.length === 0) {
    return {
      access_granted: false,
      reason: 'No active access assignment for this area',
      user: { id: user.id, name: user.name, email: user.email, access_level: payload.access_level },
      area: { id: area.id, name: area.name }
    };
  }

  return {
    access_granted: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      access_level: assignmentResult.rows[0].access_level_name
    },
    area: { id: area.id, name: area.name }
  };
}
