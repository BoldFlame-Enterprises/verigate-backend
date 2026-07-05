import { Router, Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireAdmin } from '../middleware/auth';
import { APIResponse } from '../types';
import { getCache, setCache } from '../config/redis';

const router = Router();

router.use(requireAdmin);

// Dashboard cache TTL is intentionally short: scans arrive continuously from
// scanner devices, so we bound staleness with a TTL instead of invalidating
// on every single scan write (which would defeat the point of caching).
const DASHBOARD_CACHE_TTL = 15; // seconds

// Real dashboard aggregates for a given event.
router.get('/dashboard',
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const eventId = parseInt(req.query.event_id as string, 10);
      const cacheKey = `event:${eventId}:dashboard`;
      const cached = await getCache(cacheKey);
      if (cached) {
        res.json({ success: true, data: JSON.parse(cached) } as APIResponse);
        return;
      }

      const db = getDB();

      const [
        memberCount,
        areaCount,
        accessLevelCount,
        scanStats,
        scansByArea,
        scansByAccessLevel,
        recentScans,
        deviceActivity
      ] = await Promise.all([
        db.query(`SELECT COUNT(*) FROM event_members WHERE event_id = $1 AND is_active = true`, [eventId]),
        db.query(`SELECT COUNT(*) FROM areas WHERE event_id = $1 AND is_active = true`, [eventId]),
        db.query(`SELECT COUNT(*) FROM access_levels WHERE event_id = $1 AND is_active = true`, [eventId]),
        db.query(
          `SELECT
             COUNT(*) FILTER (WHERE access_granted) as granted,
             COUNT(*) FILTER (WHERE NOT access_granted) as denied,
             COUNT(*) FILTER (WHERE scanned_at > NOW() - INTERVAL '24 hours') as last_24h
           FROM scan_logs WHERE event_id = $1`,
          [eventId]
        ),
        db.query(
          `SELECT a.id as area_id, a.name as area_name,
                  COUNT(*) FILTER (WHERE sl.access_granted) as granted,
                  COUNT(*) FILTER (WHERE NOT sl.access_granted) as denied
           FROM scan_logs sl
           JOIN areas a ON a.id = sl.area_id
           WHERE sl.event_id = $1
           GROUP BY a.id, a.name
           ORDER BY (COUNT(*)) DESC`,
          [eventId]
        ),
        db.query(
          `SELECT al.id as access_level_id, al.name as access_level_name, COUNT(*) as count
           FROM access_assignments aa
           JOIN access_levels al ON al.id = aa.access_level_id
           WHERE aa.event_id = $1 AND aa.is_active = true
           GROUP BY al.id, al.name
           ORDER BY count DESC`,
          [eventId]
        ),
        db.query(
          `SELECT sl.id, sl.user_id, u.name as user_name, sl.area_id, a.name as area_name,
                  sl.access_granted, sl.failure_reason, sl.scanned_at, sl.scanner_user_id, su.name as scanner_name
           FROM scan_logs sl
           LEFT JOIN users u ON u.id = sl.user_id
           LEFT JOIN areas a ON a.id = sl.area_id
           LEFT JOIN users su ON su.id = sl.scanner_user_id
           WHERE sl.event_id = $1
           ORDER BY sl.scanned_at DESC
           LIMIT 25`,
          [eventId]
        ),
        db.query(
          `SELECT scanner_user_id, u.name as scanner_name, MAX(scanned_at) as last_scan_at, COUNT(*) as scan_count
           FROM scan_logs sl
           LEFT JOIN users u ON u.id = sl.scanner_user_id
           WHERE sl.event_id = $1 AND scanner_user_id IS NOT NULL
           GROUP BY scanner_user_id, u.name
           ORDER BY last_scan_at DESC`,
          [eventId]
        )
      ]);

      const granted = parseInt(scanStats.rows[0].granted, 10) || 0;
      const denied = parseInt(scanStats.rows[0].denied, 10) || 0;
      const total = granted + denied;

      const dashboardData = {
        event_id: eventId,
        members: parseInt(memberCount.rows[0].count, 10),
        areas: parseInt(areaCount.rows[0].count, 10),
        access_levels: parseInt(accessLevelCount.rows[0].count, 10),
        scans: {
          total,
          granted,
          denied,
          grant_rate: total > 0 ? Number((granted / total).toFixed(4)) : 0,
          last_24h: parseInt(scanStats.rows[0].last_24h, 10) || 0
        },
        scans_by_area: scansByArea.rows,
        assignments_by_access_level: scansByAccessLevel.rows,
        recent_scans: recentScans.rows,
        device_activity: deviceActivity.rows
      };

      await setCache(cacheKey, JSON.stringify(dashboardData), DASHBOARD_CACHE_TTL);

      res.json({ success: true, data: dashboardData } as APIResponse);
    } catch (error) {
      console.error('Error building admin dashboard:', error);
      res.status(500).json({ success: false, error: 'Failed to load dashboard' } as APIResponse);
    }
  }
);

export default router;
