import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { AuthRequest, APIResponse } from '../types';
import { signQrData, verifyQrForArea } from '../services/qrVerification';

const router = Router();

// Generate a signed QR payload for the authenticated user, scoped to an event.
// Uses the exact wire format produced by verigate-pass's DatabaseService
// (generateSecureQRData): { data: JSON string, signature: sha256(data+secret), timestamp }.
router.get('/generate',
  [query('event_id').isInt().withMessage('event_id is required')],
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
      const db = getDB();

      const result = await db.query(`
        SELECT DISTINCT
          u.id,
          u.email,
          u.name,
          u.is_active,
          al.name as access_level,
          al.priority as access_priority,
          array_agg(DISTINCT a.name) as allowed_areas
        FROM users u
        LEFT JOIN access_assignments aa ON u.id = aa.user_id AND aa.is_active = true AND aa.event_id = $2
        LEFT JOIN access_levels al ON aa.access_level_id = al.id
        LEFT JOIN areas a ON aa.area_id = a.id AND a.is_active = true AND a.event_id = $2
        WHERE u.id = $1 AND u.is_active = true
        GROUP BY u.id, u.email, u.name, u.is_active, al.name, al.priority
      `, [userId, eventId]);

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'User not found or inactive' } as APIResponse);
        return;
      }

      const user = result.rows[0];
      const timestamp = Date.now();
      const qrPayload = {
        user_id: user.id,
        email: user.email,
        name: user.name,
        access_level: user.access_level || 'general',
        allowed_areas: user.allowed_areas?.filter(Boolean) || [],
        timestamp,
        expires_at: timestamp + (60 * 60 * 1000), // 1 hour expiry
        event_id: eventId,
        version: '2.0'
      };

      const dataString = JSON.stringify(qrPayload);
      const signature = signQrData(dataString);
      const qrContent = JSON.stringify({ data: dataString, signature, timestamp });

      const response: APIResponse = {
        success: true,
        data: {
          qr_content: qrContent,
          user_info: {
            name: user.name,
            email: user.email,
            access_level: user.access_level || 'general',
            allowed_areas: qrPayload.allowed_areas
          },
          expires_at: qrPayload.expires_at,
          generated_at: timestamp
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
  [
    body('qr_content').isString().notEmpty(),
    body('area_id').isInt(),
    body('event_id').isInt()
  ],
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
