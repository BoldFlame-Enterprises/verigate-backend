import { getDB } from '../config/database';
import {
  CredentialAssignment,
  QrPresentation,
  verifyPresentation,
} from './qrProtocol';

export interface VerifyResult {
  access_granted: boolean;
  reason?: string;
  credential_id?: string;
  nonce?: string;
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

function matchingAssignment(
  presentation: QrPresentation,
  areaId: number,
  now: number
): CredentialAssignment | undefined {
  return presentation.payload.credential.payload.assignments.find((assignment) =>
    assignment.area_id === areaId &&
    Date.parse(assignment.valid_from) <= now &&
    Date.parse(assignment.valid_until) >= now
  );
}

export async function verifyQrForArea(
  qrCode: string,
  areaId: number,
  eventId: number
): Promise<VerifyResult> {
  const now = Date.now();
  const verified = verifyPresentation(qrCode, eventId, now);
  if (!verified.valid || !verified.presentation) {
    return { access_granted: false, reason: verified.reason || 'Invalid QR code' };
  }

  const credential = verified.presentation.payload.credential.payload;
  const signedAssignment = matchingAssignment(verified.presentation, areaId, now);
  if (!signedAssignment) {
    return {
      access_granted: false,
      reason: 'Credential has no active assignment for this area',
      credential_id: credential.credential_id,
      nonce: verified.presentation.payload.nonce,
    };
  }

  const db = getDB();
  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.is_active,
            a.id as area_id, a.name as area_name, a.is_active as area_active,
            al.name as access_level_name
     FROM users u
     JOIN event_members em
       ON em.user_id = u.id AND em.event_id = $2 AND em.is_active = true
     JOIN access_assignments aa
       ON aa.user_id = u.id AND aa.event_id = $2 AND aa.area_id = $3
      AND aa.is_active = true AND aa.valid_from <= NOW() AND aa.valid_until >= NOW()
     JOIN areas a
       ON a.id = aa.area_id AND a.event_id = $2
     JOIN access_levels al
       ON al.id = aa.access_level_id AND al.event_id = $2
     JOIN device_credentials dc
       ON dc.user_id = u.id AND dc.event_id = $2 AND dc.device_id = $4
      AND dc.public_key = $5 AND dc.credential_version = $6 AND dc.is_active = true
     WHERE u.id = $1`,
    [
      credential.user_id,
      eventId,
      areaId,
      credential.device_id,
      credential.device_public_key,
      credential.credential_version,
    ]
  );

  if (result.rows.length === 0) {
    return {
      access_granted: false,
      reason: 'Credential is revoked, stale, or no longer assigned',
      credential_id: credential.credential_id,
      nonce: verified.presentation.payload.nonce,
    };
  }

  const row = result.rows[0];
  if (!row.is_active || !row.area_active) {
    return {
      access_granted: false,
      reason: 'User or area is inactive',
      credential_id: credential.credential_id,
      nonce: verified.presentation.payload.nonce,
    };
  }

  return {
    access_granted: true,
    credential_id: credential.credential_id,
    nonce: verified.presentation.payload.nonce,
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      access_level: row.access_level_name,
    },
    area: { id: row.area_id, name: row.area_name },
  };
}
