import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireScannerOrAdmin } from '../middleware/auth';
import { AuthRequest, APIResponse } from '../types';
import crypto from 'crypto';
import { verifyQrForArea } from '../services/qrVerification';
import { requireEventAccess } from '../middleware/eventAuthorization';
import {
  CredentialAssignment,
  credentialVersion,
  issueAuthorityCredential,
} from '../services/qrProtocol';

const router = Router();

// Generate a signed QR payload for the authenticated user, scoped to an event.
// Uses the exact wire format produced by verigate-pass's DatabaseService
// (generateSecureQRData): { data: JSON string, signature: sha256(data+secret), timestamp }.
router.get('/generate',
  [
    query('event_id').isInt().withMessage('event_id is required'),
    query('device_id').isString().trim().isLength({ min: 8, max: 255 }),
    query('device_public_key').isString().notEmpty(),
  ],
  requireEventAccess({ location: 'query' }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: 'User not authenticated' } as APIResponse);
        return;
      }

      const eventId = parseInt(req.query.event_id as string, 10);
      const deviceId = String(req.query.device_id);
      const devicePublicKey = String(req.query.device_public_key);
      try {
        crypto.createPublicKey({
          key: Buffer.from(devicePublicKey, 'base64'),
          format: 'der',
          type: 'spki',
        });
      } catch {
        res.status(400).json({ success: false, error: 'device_public_key must be a valid P-256 SPKI key' } as APIResponse);
        return;
      }
      const db = getDB();

      const result = await db.query(`
        SELECT
          u.id,
          u.email,
          u.name,
          u.is_active,
          e.ends_at,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'area_id', a.id,
                'area_name', a.name,
                'access_level_id', al.id,
                'access_level_name', al.name,
                'access_priority', al.priority,
                'valid_from', aa.valid_from,
                'valid_until', aa.valid_until
              )
              ORDER BY a.id
            ) FILTER (WHERE aa.id IS NOT NULL),
            '[]'::jsonb
          ) as assignments
        FROM users u
        JOIN event_members em
          ON em.user_id = u.id AND em.event_id = $2 AND em.is_active = true
        JOIN events e ON e.id = $2 AND e.is_active = true
        LEFT JOIN access_assignments aa
          ON u.id = aa.user_id AND aa.is_active = true AND aa.event_id = $2
         AND aa.valid_from <= NOW() AND aa.valid_until >= NOW()
        LEFT JOIN access_levels al
          ON aa.access_level_id = al.id AND al.event_id = $2 AND al.is_active = true
        LEFT JOIN areas a
          ON aa.area_id = a.id AND a.is_active = true AND a.event_id = $2
        WHERE u.id = $1 AND u.is_active = true
        GROUP BY u.id, u.email, u.name, u.is_active, e.ends_at
      `, [userId, eventId]);

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'User not found or inactive' } as APIResponse);
        return;
      }

      const user = result.rows[0];
      const assignments = (user.assignments || []) as CredentialAssignment[];
      const version = credentialVersion(assignments);
      await db.query(
        `INSERT INTO device_credentials
           (user_id, event_id, device_id, public_key, credential_version, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
         ON CONFLICT (event_id, user_id, device_id) DO UPDATE SET
           public_key = EXCLUDED.public_key,
           credential_version = EXCLUDED.credential_version,
           is_active = true,
           updated_at = NOW()`,
        [userId, eventId, deviceId, devicePublicKey, version]
      );

      const issuedAt = Date.now();
      const eventEnd = user.ends_at ? new Date(user.ends_at).getTime() : Number.POSITIVE_INFINITY;
      const expiresAt = Math.min(issuedAt + 24 * 60 * 60 * 1000, eventEnd);
      const credential = issueAuthorityCredential({
        credential_id: crypto.randomUUID(),
        credential_version: version,
        user_id: user.id,
        email: user.email,
        name: user.name,
        event_id: eventId,
        device_id: deviceId,
        device_public_key: devicePublicKey,
        assignments,
        issued_at: issuedAt,
        expires_at: expiresAt,
      });

      const response: APIResponse = {
        success: true,
        data: {
          contract_version: 'qr-credential-v2',
          credential,
          user_info: {
            name: user.name,
            email: user.email,
            assignments,
          },
          expires_at: expiresAt,
          generated_at: issuedAt
        }
      };

      res.json(response);
    } catch (error) {
      console.error('Error generating QR code:', error);
      res.status(500).json({ success: false, error: 'Failed to generate QR code' } as APIResponse);
    }
  }
);

// Real QR verification. Kept for backward compatibility with clients still
// calling /api/qr/verify; delegates to the exact same verification function
// as /api/scan/verify so there is only one real verification path.
router.post('/verify',
  requireScannerOrAdmin,
  [
    body('qr_content').isString().notEmpty(),
    body('area_id').isInt(),
    body('event_id').isInt()
  ],
  requireEventAccess({ location: 'body', principalRoles: ['scanner'] }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { qr_content, area_id, event_id } = req.body;
      const result = await verifyQrForArea(qr_content, area_id, event_id);

      res.json({ success: true, data: result } as APIResponse);
    } catch (error) {
      console.error('Error verifying QR code:', error);
      res.status(500).json({ success: false, error: 'Failed to verify QR code', data: { access_granted: false } } as APIResponse);
    }
  }
);

export default router;
