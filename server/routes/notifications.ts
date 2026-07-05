import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireAdmin } from '../middleware/auth';
import { AuthRequest, APIResponse } from '../types';
import { sendPushToUsers } from '../services/push';

const router = Router();

// Register (or refresh) a device's push token for an event.
router.post('/register-device',
  [
    body('event_id').isInt(),
    body('token').isString().notEmpty(),
    body('platform').isIn(['android', 'ios'])
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { event_id, token, platform } = req.body;
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ success: false, error: 'User not authenticated' } as APIResponse);
        return;
      }

      const db = getDB();
      const result = await db.query(
        `INSERT INTO device_tokens (user_id, event_id, token, platform, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, NOW(), NOW())
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, event_id = EXCLUDED.event_id,
                       platform = EXCLUDED.platform, is_active = true, updated_at = NOW()
         RETURNING id, user_id, event_id, platform, is_active`,
        [userId, event_id, token, platform]
      );

      res.status(201).json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error registering device token:', error);
      res.status(500).json({ success: false, error: 'Failed to register device token' } as APIResponse);
    }
  }
);

router.post('/unregister-device',
  [body('token').isString().notEmpty()],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { token } = req.body;
      const db = getDB();
      await db.query(`UPDATE device_tokens SET is_active = false WHERE token = $1`, [token]);
      res.json({ success: true, data: { unregistered: true } } as APIResponse);
    } catch (error) {
      console.error('Error unregistering device token:', error);
      res.status(500).json({ success: false, error: 'Failed to unregister device token' } as APIResponse);
    }
  }
);

// Admin: send an announcement / access-change push to specific users (or the whole event).
router.post('/send',
  requireAdmin,
  [
    body('event_id').isInt(),
    body('title').isString().notEmpty(),
    body('body').isString().notEmpty(),
    body('user_ids').optional().isArray()
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { event_id, title, body: messageBody, data, user_ids } = req.body;
      const db = getDB();

      let userIds: number[] = user_ids;
      if (!userIds || userIds.length === 0) {
        const members = await db.query(
          `SELECT user_id FROM event_members WHERE event_id = $1 AND is_active = true`,
          [event_id]
        );
        userIds = members.rows.map(r => r.user_id);
      }

      const result = await sendPushToUsers(event_id, userIds, { title, body: messageBody, data });
      res.json({ success: true, data: result } as APIResponse);
    } catch (error) {
      console.error('Error sending push notification:', error);
      res.status(500).json({ success: false, error: 'Failed to send push notification' } as APIResponse);
    }
  }
);

// Sync heartbeat: called periodically by both apps so the dashboard can show
// each device's last-sync time, local-DB freshness, and connectivity.
router.post('/sync-heartbeat',
  [
    body('device_id').isString().notEmpty(),
    body('app').isIn(['pass', 'scan']),
    body('event_id').optional().isInt(),
    body('local_db_version').optional().isInt()
  ],
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { device_id, app, event_id, platform, local_db_version, kind } = req.body;
      const db = getDB();

      const lastSyncColumn = kind === 'scan_upload' ? 'last_scan_upload_at' : 'last_sync_at';

      await db.query(
        `INSERT INTO device_sync_status (device_id, user_id, event_id, app, platform, ${lastSyncColumn}, local_db_version, is_online, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, true, NOW())
         ON CONFLICT (device_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           event_id = EXCLUDED.event_id,
           app = EXCLUDED.app,
           platform = EXCLUDED.platform,
           ${lastSyncColumn} = NOW(),
           local_db_version = COALESCE(EXCLUDED.local_db_version, device_sync_status.local_db_version),
           is_online = true,
           updated_at = NOW()`,
        [device_id, req.user?.id || null, event_id || null, app, platform || null, local_db_version || null]
      );

      res.json({ success: true, data: { acknowledged: true } } as APIResponse);
    } catch (error) {
      console.error('Error recording sync heartbeat:', error);
      res.status(500).json({ success: false, error: 'Failed to record sync heartbeat' } as APIResponse);
    }
  }
);

// Admin: real-time sync monitoring — every device's last-sync time and
// inferred online/stale status for an event.
router.get('/device-status',
  requireAdmin,
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const eventId = parseInt(req.query.event_id as string, 10);
      const db = getDB();

      const result = await db.query(
        `SELECT ds.device_id, ds.app, ds.platform, ds.last_sync_at, ds.last_scan_upload_at,
                ds.local_db_version, u.name as user_name,
                (COALESCE(ds.last_sync_at, ds.last_scan_upload_at) > NOW() - INTERVAL '2 minutes') as is_stale_free,
                EXTRACT(EPOCH FROM (NOW() - COALESCE(ds.last_sync_at, ds.last_scan_upload_at))) as seconds_since_sync
         FROM device_sync_status ds
         LEFT JOIN users u ON u.id = ds.user_id
         WHERE ds.event_id = $1
         ORDER BY COALESCE(ds.last_sync_at, ds.last_scan_upload_at) DESC NULLS LAST`,
        [eventId]
      );

      const devices = result.rows.map(row => ({
        ...row,
        status: row.seconds_since_sync == null ? 'unknown'
          : row.seconds_since_sync < 120 ? 'online'
          : row.seconds_since_sync < 900 ? 'stale'
          : 'offline'
      }));

      res.json({ success: true, data: devices } as APIResponse);
    } catch (error) {
      console.error('Error getting device sync status:', error);
      res.status(500).json({ success: false, error: 'Failed to get device sync status' } as APIResponse);
    }
  }
);

export default router;
