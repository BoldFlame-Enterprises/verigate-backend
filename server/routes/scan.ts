import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { AuthRequest, APIResponse } from '../types';
import { verifyQrForArea } from '../services/qrVerification';

const router = Router();

// Real server-side QR verification fallback. The apps verify offline first;
// this endpoint is called when the local check on the scanner device is
// inconclusive (e.g. user not yet synced locally) so it re-validates the
// signed QR payload and looks up the actual access assignment.
router.post('/verify',
  [
    body('qr_code').isString().notEmpty(),
    body('area_id').isInt(),
    body('event_id').isInt()
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { qr_code, area_id, event_id, device_info } = req.body;
      const result = await verifyQrForArea(qr_code, area_id, event_id);

      // Log the scan attempt (server-verified fallback path).
      try {
        const db = getDB();
        await db.query(
          `INSERT INTO scan_logs (event_id, user_id, area_id, scanner_user_id, access_granted, failure_reason, scanned_at, device_info)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
          [
            event_id,
            result.user?.id || null,
            area_id,
            req.user?.id || null,
            result.access_granted,
            result.access_granted ? null : (result.reason || 'Access denied'),
            JSON.stringify({ source: 'server-fallback', ...(device_info || {}) })
          ]
        );
      } catch (logError) {
        console.error('Error logging server-fallback scan:', logError);
      }

      const response: APIResponse = {
        success: true,
        data: result
      };
      res.json(response);
    } catch (error) {
      console.error('Error verifying scan:', error);
      res.status(500).json({ success: false, error: 'Failed to verify scan', data: { access_granted: false } } as APIResponse);
    }
  }
);

export default router;
