import { Router, Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { AuthRequest } from '../types';
import { getDB } from '../config/database';
import { APIResponse } from '../types';
import crypto from 'crypto';
import { getCache, setCache } from '../config/redis';

const router = Router();

const USERS_DB_CACHE_TTL = 30; // seconds - short TTL, this feeds device sync
const AREAS_DB_CACHE_TTL = 300;

// Get users database for scanner app sync, scoped to a single event.
router.get('/users-database',
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const eventId = parseInt(req.query.event_id as string, 10);
      const cacheKey = `sync:users-database:${eventId}`;

      const cached = await getCache(cacheKey);
      if (cached) {
        res.json({ success: true, data: JSON.parse(cached) } as APIResponse);
        return;
      }

      const db = getDB();

      // Only users who are members of this event and have at least one
      // active assignment (or are event members generally) are synced down.
      const result = await db.query(`
        SELECT DISTINCT
          u.id,
          u.email,
          u.name,
          u.phone,
          u.is_active,
          al.name as access_level,
          al.priority as access_priority,
          array_agg(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL) as allowed_areas,
          array_agg(DISTINCT a.id) FILTER (WHERE a.id IS NOT NULL) as allowed_area_ids
        FROM users u
        JOIN event_members em ON em.user_id = u.id AND em.event_id = $1 AND em.is_active = true
        LEFT JOIN access_assignments aa ON u.id = aa.user_id AND aa.is_active = true AND aa.event_id = $1
        LEFT JOIN access_levels al ON aa.access_level_id = al.id
        LEFT JOIN areas a ON aa.area_id = a.id AND a.is_active = true AND a.event_id = $1
        WHERE u.is_active = true
        GROUP BY u.id, u.email, u.name, u.phone, u.is_active, al.name, al.priority
        ORDER BY u.id
      `, [eventId]);

      const users = result.rows.map(user => ({
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        access_level: user.access_level || 'general',
        access_priority: user.access_priority || 1,
        allowed_areas: user.allowed_areas || [],
        allowed_area_ids: user.allowed_area_ids || [],
        is_active: user.is_active
      }));

      const dataString = JSON.stringify(users);
      const checksum = crypto.createHash('sha256').update(dataString).digest('hex');
      const timestamp = new Date().toISOString();

      const payload = {
        users,
        metadata: {
          checksum,
          timestamp,
          count: users.length,
          version: Date.now(),
          event_id: eventId
        }
      };

      await setCache(cacheKey, JSON.stringify(payload), USERS_DB_CACHE_TTL);

      res.json({ success: true, data: payload } as APIResponse);
    } catch (error) {
      console.error('Error getting users database:', error);
      res.status(500).json({ success: false, error: 'Failed to get users database' } as APIResponse);
    }
  }
);

// Get areas database for scanner app, scoped to a single event.
router.get('/areas-database',
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const eventId = parseInt(req.query.event_id as string, 10);
      const cacheKey = `sync:areas-database:${eventId}`;

      const cached = await getCache(cacheKey);
      if (cached) {
        res.json({ success: true, data: JSON.parse(cached) } as APIResponse);
        return;
      }

      const db = getDB();
      const result = await db.query(`
        SELECT id, name, description, requires_scan, is_active
        FROM areas
        WHERE is_active = true AND event_id = $1
        ORDER BY id
      `, [eventId]);

      const areas = result.rows;
      const dataString = JSON.stringify(areas);
      const checksum = crypto.createHash('sha256').update(dataString).digest('hex');

      const payload = {
        areas,
        metadata: {
          checksum,
          timestamp: new Date().toISOString(),
          count: areas.length,
          event_id: eventId
        }
      };

      await setCache(cacheKey, JSON.stringify(payload), AREAS_DB_CACHE_TTL);

      res.json({ success: true, data: payload } as APIResponse);
    } catch (error) {
      console.error('Error getting areas database:', error);
      res.status(500).json({ success: false, error: 'Failed to get areas database' } as APIResponse);
    }
  }
);

// Upload scan logs from scanner apps, scoped to a single event.
// Each log may include a client-generated `device_scan_id` (UUID) so retried
// uploads (e.g. after a dropped connection) are de-duplicated server-side
// instead of being inserted twice.
router.post('/scan-logs', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { logs, device_id, event_id } = req.body;

    if (!logs || !Array.isArray(logs)) {
      res.status(400).json({ success: false, error: 'Invalid logs data' } as APIResponse);
      return;
    }
    if (!event_id) {
      res.status(400).json({ success: false, error: 'event_id is required' } as APIResponse);
      return;
    }

    const db = getDB();
    let processed = 0;
    let duplicates = 0;
    let errors = 0;

    for (const log of logs) {
      try {
        const result = await db.query(`
          INSERT INTO scan_logs (
            event_id, user_id, area_id, scanner_user_id, access_granted,
            failure_reason, scanned_at, device_info, device_scan_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (device_scan_id) DO NOTHING
          RETURNING id
        `, [
          event_id,
          log.user_id,
          log.area_id,
          req.user?.id || null,
          log.access_granted,
          log.failure_reason,
          log.scanned_at,
          JSON.stringify({ device_id, ...log.device_info }),
          log.device_scan_id || null
        ]);

        if (result.rows.length > 0) {
          processed++;
        } else if (log.device_scan_id) {
          duplicates++;
        } else {
          processed++;
        }
      } catch (logError) {
        console.error('Error inserting scan log:', logError);
        errors++;
      }
    }

    const response: APIResponse = {
      success: true,
      data: { processed, duplicates, errors, total: logs.length }
    };

    res.json(response);
  } catch (error) {
    console.error('Error uploading scan logs:', error);
    res.status(500).json({ success: false, error: 'Failed to upload scan logs' } as APIResponse);
  }
});

// Check for database updates, scoped to a single event.
router.get('/check-updates',
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { users_version, areas_version } = req.query;
      const eventId = parseInt(req.query.event_id as string, 10);
      const db = getDB();

      const usersUpdate = await db.query(`
        SELECT EXTRACT(EPOCH FROM MAX(u.updated_at)) * 1000 as last_update
        FROM users u
        JOIN event_members em ON em.user_id = u.id AND em.event_id = $1
        WHERE u.is_active = true
      `, [eventId]);

      const areasUpdate = await db.query(`
        SELECT EXTRACT(EPOCH FROM NOW()) * 1000 as last_update
      `);

      const currentUsersVersion = parseInt(usersUpdate.rows[0]?.last_update) || 0;
      const currentAreasVersion = parseInt(areasUpdate.rows[0]?.last_update) || 0;

      const response: APIResponse = {
        success: true,
        data: {
          users_update_available: currentUsersVersion > parseInt(users_version as string || '0'),
          areas_update_available: currentAreasVersion > parseInt(areas_version as string || '0'),
          current_users_version: currentUsersVersion,
          current_areas_version: currentAreasVersion
        }
      };

      res.json(response);
    } catch (error) {
      console.error('Error checking updates:', error);
      res.status(500).json({ success: false, error: 'Failed to check updates' } as APIResponse);
    }
  }
);

export default router;
