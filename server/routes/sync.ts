import { Router, Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { AuthRequest, EventUserProjection, QueueRecordResult } from '../types';
import { getDB } from '../config/database';
import { APIResponse } from '../types';
import crypto from 'crypto';
import { getCache, setCache } from '../config/redis';
import { requireScannerOrAdmin } from '../middleware/auth';
import { requireEventAccess } from '../middleware/eventAuthorization';
import { authorityPublicKeyBase64 } from '../services/qrProtocol';

const router = Router();

const USERS_DB_CACHE_TTL = 30; // seconds - short TTL, this feeds device sync
const AREAS_DB_CACHE_TTL = 300;

async function loadEventUsers(eventId: number, userId?: number): Promise<EventUserProjection[]> {
  const db = getDB();
  const params: number[] = [eventId];
  const selfFilter = userId == null ? '' : 'AND u.id = $2';
  if (userId != null) params.push(userId);

  const result = await db.query(`
    SELECT
      u.id,
      $1::integer as event_id,
      u.email,
      u.name,
      u.phone,
      u.is_active,
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
      ON em.user_id = u.id AND em.event_id = $1 AND em.is_active = true
    LEFT JOIN access_assignments aa
      ON u.id = aa.user_id AND aa.is_active = true AND aa.event_id = $1
     AND aa.valid_from <= NOW() AND aa.valid_until >= NOW()
    LEFT JOIN access_levels al
      ON aa.access_level_id = al.id AND al.event_id = $1 AND al.is_active = true
    LEFT JOIN areas a
      ON aa.area_id = a.id AND a.event_id = $1 AND a.is_active = true
    WHERE u.is_active = true ${selfFilter}
    GROUP BY u.id, u.email, u.name, u.phone, u.is_active
    ORDER BY u.id
  `, params);

  return result.rows.map((user) => ({
    id: Number(user.id),
    event_id: eventId,
    email: user.email,
    name: user.name,
    phone: user.phone,
    is_active: user.is_active,
    assignments: user.assignments || [],
  }));
}

// Pass receives only the authenticated attendee's own event projection.
router.get('/my-credential',
  [query('event_id').isInt().withMessage('event_id is required')],
  requireEventAccess({ location: 'query' }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }
      const eventId = req.event!.id;
      const users = await loadEventUsers(eventId, req.user!.id);
      if (users.length === 0) {
        res.status(404).json({ success: false, error: 'Active event credential not found' } as APIResponse);
        return;
      }
      res.json({
        success: true,
        data: { contract_version: 'event-user-v2', user: users[0] },
      } as APIResponse);
    } catch (error) {
      console.error('Error getting own credential projection:', error);
      res.status(500).json({ success: false, error: 'Failed to get credential projection' } as APIResponse);
    }
  }
);

// Get users database for scanner app sync, scoped to a single event.
router.get('/users-database',
  requireScannerOrAdmin,
  [query('event_id').isInt().withMessage('event_id is required')],
  requireEventAccess({ location: 'query', principalRoles: ['scanner'] }),
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

      const users = await loadEventUsers(eventId);

      const dataString = JSON.stringify(users);
      const checksum = crypto.createHash('sha256').update(dataString).digest('hex');
      const timestamp = new Date().toISOString();

      const payload = {
        contract_version: 'event-user-v2',
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
  requireScannerOrAdmin,
  [query('event_id').isInt().withMessage('event_id is required')],
  requireEventAccess({ location: 'query', principalRoles: ['scanner'] }),
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
        qr_authority_public_key: authorityPublicKeyBase64(),
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
router.post('/scan-logs',
  requireScannerOrAdmin,
  requireEventAccess({ location: 'body', principalRoles: ['scanner'] }),
  async (req: AuthRequest, res: Response): Promise<void> => {
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
    const results: QueueRecordResult[] = [];

    for (const log of logs) {
      const clientRecordId = String(log.client_record_id || log.device_scan_id || '');
      if (!clientRecordId) {
        results.push({
          client_record_id: '',
          status: 'rejected',
          error: 'client_record_id is required',
        });
        continue;
      }
      if (Number(log.event_id) !== Number(req.event!.id)) {
        results.push({
          client_record_id: clientRecordId,
          status: 'rejected',
          error: 'Queued record event_id does not match the authorized event',
        });
        continue;
      }

      try {
        const result = await db.query(`
          INSERT INTO scan_logs (
            event_id, user_id, area_id, scanner_user_id, access_granted,
            failure_reason, scanned_at, device_info, device_scan_id
          )
          SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
          WHERE EXISTS (SELECT 1 FROM areas WHERE id = $3 AND event_id = $1)
          ON CONFLICT (device_scan_id) DO NOTHING
          RETURNING id
        `, [
          req.event!.id,
          log.user_id,
          log.area_id,
          req.user?.id || null,
          log.access_granted,
          log.failure_reason,
          log.scanned_at,
          JSON.stringify({ device_id, ...log.device_info }),
          clientRecordId,
        ]);

        if (result.rows.length > 0) {
          results.push({
            client_record_id: clientRecordId,
            status: 'accepted',
            server_id: result.rows[0].id,
          });
        } else {
          const duplicate = await db.query(
            'SELECT id FROM scan_logs WHERE device_scan_id = $1',
            [clientRecordId]
          );
          results.push(duplicate.rows.length > 0
            ? {
                client_record_id: clientRecordId,
                status: 'duplicate',
                server_id: duplicate.rows[0].id,
              }
            : {
                client_record_id: clientRecordId,
                status: 'rejected',
                error: 'area_id does not belong to the authorized event',
              });
        }
      } catch (logError) {
        console.error('Error inserting scan log:', logError);
        results.push({
          client_record_id: clientRecordId,
          status: 'retryable_error',
          error: 'Temporary persistence failure',
        });
      }
    }

    const response: APIResponse = {
      success: true,
      data: {
        contract_version: 'queue-ack-v2',
        results,
        accepted: results.filter((item) => item.status === 'accepted').length,
        duplicates: results.filter((item) => item.status === 'duplicate').length,
        rejected: results.filter((item) => item.status === 'rejected').length,
        retryable_errors: results.filter((item) => item.status === 'retryable_error').length,
        total: logs.length,
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error uploading scan logs:', error);
    res.status(500).json({ success: false, error: 'Failed to upload scan logs' } as APIResponse);
  }
  }
);

// Check for database updates, scoped to a single event.
router.get('/check-updates',
  requireScannerOrAdmin,
  [query('event_id').isInt().withMessage('event_id is required')],
  requireEventAccess({ location: 'query', principalRoles: ['scanner'] }),
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
