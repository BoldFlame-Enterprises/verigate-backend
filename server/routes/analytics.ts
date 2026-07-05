import { Router, Request, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireAdmin } from '../middleware/auth';
import { APIResponse } from '../types';
import { getCache, setCache } from '../config/redis';

const router = Router();
router.use(requireAdmin);

const ANALYTICS_CACHE_TTL = 60; // seconds

// Scan volume over time (hourly buckets for the last 48h) + peak-time analysis.
router.get('/scan-volume',
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const eventId = parseInt(req.query.event_id as string, 10);
      const cacheKey = `analytics:${eventId}:scan-volume`;
      const cached = await getCache(cacheKey);
      if (cached) {
        res.json({ success: true, data: JSON.parse(cached) } as APIResponse);
        return;
      }

      const db = getDB();
      const hourly = await db.query(
        `SELECT date_trunc('hour', scanned_at) as bucket,
                COUNT(*) FILTER (WHERE access_granted) as granted,
                COUNT(*) FILTER (WHERE NOT access_granted) as denied
         FROM scan_logs
         WHERE event_id = $1 AND scanned_at > NOW() - INTERVAL '48 hours'
         GROUP BY bucket
         ORDER BY bucket`,
        [eventId]
      );

      const peakHour = await db.query(
        `SELECT EXTRACT(HOUR FROM scanned_at) as hour_of_day, COUNT(*) as count
         FROM scan_logs
         WHERE event_id = $1
         GROUP BY hour_of_day
         ORDER BY count DESC
         LIMIT 5`,
        [eventId]
      );

      const payload = { hourly: hourly.rows, peak_hours: peakHour.rows };
      await setCache(cacheKey, JSON.stringify(payload), ANALYTICS_CACHE_TTL);
      res.json({ success: true, data: payload } as APIResponse);
    } catch (error) {
      console.error('Error building scan-volume analytics:', error);
      res.status(500).json({ success: false, error: 'Failed to load scan volume analytics' } as APIResponse);
    }
  }
);

// Per-area and per-access-level breakdowns + grant/deny rates + scanner activity.
router.get('/breakdown',
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const eventId = parseInt(req.query.event_id as string, 10);
      const cacheKey = `analytics:${eventId}:breakdown`;
      const cached = await getCache(cacheKey);
      if (cached) {
        res.json({ success: true, data: JSON.parse(cached) } as APIResponse);
        return;
      }

      const db = getDB();

      const [byArea, byAccessLevel, byScanner, overall] = await Promise.all([
        db.query(
          `SELECT a.id, a.name, COUNT(*) as total,
                  COUNT(*) FILTER (WHERE sl.access_granted) as granted,
                  COUNT(*) FILTER (WHERE NOT sl.access_granted) as denied
           FROM scan_logs sl JOIN areas a ON a.id = sl.area_id
           WHERE sl.event_id = $1
           GROUP BY a.id, a.name ORDER BY total DESC`,
          [eventId]
        ),
        db.query(
          `SELECT al.id, al.name, COUNT(aa.id) as assigned_users
           FROM access_levels al
           LEFT JOIN access_assignments aa ON aa.access_level_id = al.id AND aa.is_active = true AND aa.event_id = $1
           WHERE al.event_id = $1
           GROUP BY al.id, al.name ORDER BY assigned_users DESC`,
          [eventId]
        ),
        db.query(
          `SELECT su.id, su.name, COUNT(*) as scans,
                  COUNT(*) FILTER (WHERE sl.access_granted) as granted,
                  COUNT(*) FILTER (WHERE NOT sl.access_granted) as denied,
                  MAX(sl.scanned_at) as last_scan_at
           FROM scan_logs sl JOIN users su ON su.id = sl.scanner_user_id
           WHERE sl.event_id = $1
           GROUP BY su.id, su.name ORDER BY scans DESC`,
          [eventId]
        ),
        db.query(
          `SELECT COUNT(*) as total,
                  COUNT(*) FILTER (WHERE access_granted) as granted,
                  COUNT(*) FILTER (WHERE NOT access_granted) as denied
           FROM scan_logs WHERE event_id = $1`,
          [eventId]
        )
      ]);

      const total = parseInt(overall.rows[0].total, 10) || 0;
      const granted = parseInt(overall.rows[0].granted, 10) || 0;

      const payload = {
        overall: {
          total,
          granted,
          denied: parseInt(overall.rows[0].denied, 10) || 0,
          grant_rate: total > 0 ? Number((granted / total).toFixed(4)) : 0
        },
        by_area: byArea.rows,
        by_access_level: byAccessLevel.rows,
        by_scanner: byScanner.rows
      };

      await setCache(cacheKey, JSON.stringify(payload), ANALYTICS_CACHE_TTL);
      res.json({ success: true, data: payload } as APIResponse);
    } catch (error) {
      console.error('Error building breakdown analytics:', error);
      res.status(500).json({ success: false, error: 'Failed to load breakdown analytics' } as APIResponse);
    }
  }
);

// CSV export of the raw scan log for a given event (for offline reporting).
router.get('/export/scans.csv',
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
        `SELECT sl.id, sl.scanned_at, u.name as user_name, u.email as user_email,
                a.name as area_name, sl.access_granted, sl.failure_reason,
                su.name as scanner_name
         FROM scan_logs sl
         LEFT JOIN users u ON u.id = sl.user_id
         LEFT JOIN areas a ON a.id = sl.area_id
         LEFT JOIN users su ON su.id = sl.scanner_user_id
         WHERE sl.event_id = $1
         ORDER BY sl.scanned_at DESC`,
        [eventId]
      );

      const header = 'id,scanned_at,user_name,user_email,area_name,access_granted,failure_reason,scanner_name';
      const escape = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = result.rows.map(r =>
        [r.id, new Date(r.scanned_at).toISOString(), r.user_name, r.user_email, r.area_name, r.access_granted, r.failure_reason, r.scanner_name]
          .map(escape).join(',')
      );
      const csv = [header, ...rows].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="scans-event-${eventId}.csv"`);
      res.send(csv);
    } catch (error) {
      console.error('Error exporting scans CSV:', error);
      res.status(500).json({ success: false, error: 'Failed to export scans' } as APIResponse);
    }
  }
);

export default router;
