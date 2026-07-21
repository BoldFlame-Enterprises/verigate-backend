import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireAdmin } from '../middleware/auth';
import { APIResponse } from '../types';
import { deleteCache } from '../config/redis';
import { sendPushToUsers } from '../services/push';
import { requireEventAccess, requireEventResourceAccess } from '../middleware/eventAuthorization';

const router = Router();
const ACCESS_LEVEL_COLUMNS = `id, event_id, name, description, priority, is_active`;

// Access-level/assignment changes affect the scanner sync payload (a user's
// allowed_areas / access_level) and the analytics breakdown; invalidate both.
async function invalidateAccessCaches(eventId: number): Promise<void> {
  await deleteCache(`sync:users-database:${eventId}`);
  await deleteCache(`analytics:${eventId}:breakdown`);
}

// List access levels for an event
router.get('/',
  [query('event_id').isInt().withMessage('event_id is required')],
  requireEventAccess({ location: 'query' }),
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
        `SELECT ${ACCESS_LEVEL_COLUMNS} FROM access_levels WHERE event_id = $1 ORDER BY priority DESC, id`,
        [eventId]
      );
      res.json({ success: true, data: result.rows } as APIResponse);
    } catch (error) {
      console.error('Error listing access levels:', error);
      res.status(500).json({ success: false, error: 'Failed to list access levels' } as APIResponse);
    }
  }
);

router.get('/:id',
  requireEventResourceAccess('access_levels'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid access level id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(`SELECT ${ACCESS_LEVEL_COLUMNS} FROM access_levels WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Access level not found' } as APIResponse);
      return;
    }
    res.json({ success: true, data: result.rows[0] } as APIResponse);
  } catch (error) {
    console.error('Error getting access level:', error);
    res.status(500).json({ success: false, error: 'Failed to get access level' } as APIResponse);
  }
  }
);

router.post('/',
  requireAdmin,
  [
    body('event_id').isInt(),
    body('name').trim().isLength({ min: 1, max: 100 }),
    body('description').optional().trim(),
    body('priority').optional().isInt({ min: 0 })
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { event_id, name, description = null, priority = 0 } = req.body;
      const db = getDB();

      const existing = await db.query('SELECT id FROM access_levels WHERE event_id = $1 AND name = $2', [event_id, name]);
      if (existing.rows.length > 0) {
        res.status(409).json({ success: false, error: 'An access level with this name already exists for this event' } as APIResponse);
        return;
      }

      const result = await db.query(
        `INSERT INTO access_levels (event_id, name, description, priority, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING ${ACCESS_LEVEL_COLUMNS}`,
        [event_id, name, description, priority]
      );

      await invalidateAccessCaches(event_id);
      res.status(201).json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error creating access level:', error);
      res.status(500).json({ success: false, error: 'Failed to create access level' } as APIResponse);
    }
  }
);

router.put('/:id',
  requireAdmin,
  [
    body('name').optional().trim().isLength({ min: 1, max: 100 }),
    body('description').optional().trim(),
    body('priority').optional().isInt({ min: 0 }),
    body('is_active').optional().isBoolean()
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) {
        res.status(400).json({ success: false, error: 'Invalid access level id' } as APIResponse);
        return;
      }

      const fields: string[] = [];
      const params: any[] = [];
      for (const key of ['name', 'description', 'priority', 'is_active'] as const) {
        if (req.body[key] !== undefined) {
          params.push(req.body[key]);
          fields.push(`${key} = $${params.length}`);
        }
      }

      if (fields.length === 0) {
        res.status(400).json({ success: false, error: 'No fields to update' } as APIResponse);
        return;
      }

      params.push(id);
      const db = getDB();
      const result = await db.query(
        `UPDATE access_levels SET ${fields.join(', ')} WHERE id = $${params.length}
         RETURNING ${ACCESS_LEVEL_COLUMNS}`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Access level not found' } as APIResponse);
        return;
      }

      await invalidateAccessCaches(result.rows[0].event_id);
      res.json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error updating access level:', error);
      res.status(500).json({ success: false, error: 'Failed to update access level' } as APIResponse);
    }
  }
);

router.delete('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid access level id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(
      `UPDATE access_levels SET is_active = false WHERE id = $1 RETURNING ${ACCESS_LEVEL_COLUMNS}`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Access level not found' } as APIResponse);
      return;
    }
    await invalidateAccessCaches(result.rows[0].event_id);
    res.json({ success: true, data: result.rows[0], message: 'Access level deactivated' } as APIResponse);
  } catch (error) {
    console.error('Error deactivating access level:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate access level' } as APIResponse);
  }
});

// --- Access assignment management (user <-> area via access level, scoped to an event) ---

// List assignments (optionally filtered by user_id or area_id, required event_id)
router.get('/assignments/list',
  requireAdmin,
  [query('event_id').isInt().withMessage('event_id is required')],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const params: any[] = [parseInt(req.query.event_id as string, 10)];
      const conditions: string[] = ['aa.event_id = $1'];

      if (req.query.user_id) {
        params.push(parseInt(req.query.user_id as string, 10));
        conditions.push(`aa.user_id = $${params.length}`);
      }
      if (req.query.area_id) {
        params.push(parseInt(req.query.area_id as string, 10));
        conditions.push(`aa.area_id = $${params.length}`);
      }

      const db = getDB();
      const result = await db.query(
        `SELECT aa.id, aa.event_id, aa.user_id, u.name as user_name, u.email as user_email,
                aa.access_level_id, al.name as access_level_name,
                aa.area_id, a.name as area_name,
                aa.valid_from, aa.valid_until, aa.is_active
         FROM access_assignments aa
         JOIN users u ON u.id = aa.user_id
         JOIN access_levels al ON al.id = aa.access_level_id
         JOIN areas a ON a.id = aa.area_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY aa.id`,
        params
      );

      res.json({ success: true, data: result.rows } as APIResponse);
    } catch (error) {
      console.error('Error listing access assignments:', error);
      res.status(500).json({ success: false, error: 'Failed to list access assignments' } as APIResponse);
    }
  }
);

// Assign (or update) a user's access to an area within an event.
// Respects the (user_id, area_id, event_id) unique constraint.
router.post('/assignments',
  requireAdmin,
  [
    body('event_id').isInt(),
    body('user_id').isInt(),
    body('access_level_id').isInt(),
    body('area_id').isInt(),
    body('valid_until').optional().isISO8601()
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { event_id, user_id, access_level_id, area_id, valid_until } = req.body;
      const db = getDB();

      // Reject cross-event mismatches: the access level and area must both
      // actually belong to the event being assigned to.
      const scopeCheck = await db.query(
        `SELECT
           (SELECT 1 FROM access_levels WHERE id = $1 AND event_id = $2) as level_ok,
           (SELECT 1 FROM areas WHERE id = $3 AND event_id = $2) as area_ok`,
        [access_level_id, event_id, area_id]
      );
      if (!scopeCheck.rows[0].level_ok || !scopeCheck.rows[0].area_ok) {
        res.status(400).json({ success: false, error: 'access_level_id and area_id must belong to the specified event_id' } as APIResponse);
        return;
      }

      // Ensure the user is a member of this event (auto-join on first assignment).
      await db.query(
        `INSERT INTO event_members (event_id, user_id, role_in_event, is_active)
         VALUES ($1, $2, 'attendee', true)
         ON CONFLICT (event_id, user_id) DO NOTHING`,
        [event_id, user_id]
      );

      const result = await db.query(
        `INSERT INTO access_assignments (event_id, user_id, access_level_id, area_id, valid_from, valid_until, is_active)
         VALUES ($1, $2, $3, $4, NOW(), COALESCE($5, NOW() + INTERVAL '1 year'), true)
         ON CONFLICT (user_id, area_id, event_id)
         DO UPDATE SET access_level_id = EXCLUDED.access_level_id,
                       valid_until = EXCLUDED.valid_until,
                       is_active = true
         RETURNING id, event_id, user_id, access_level_id, area_id, valid_from, valid_until, is_active`,
        [event_id, user_id, access_level_id, area_id, valid_until || null]
      );

      await invalidateAccessCaches(event_id);

      // Notify the affected user's pass app (Android FCM now; iOS gated - see push.ts).
      // Fire-and-forget: push delivery must never block or fail the assignment write.
      sendPushToUsers(event_id, [user_id], {
        title: 'Access updated',
        body: 'Your event access has changed. Open the app to see your updated permitted areas.',
        data: { type: 'access_change', event_id: String(event_id) }
      }).catch(err => console.error('Push notify (access change) failed:', err));

      res.status(201).json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error creating access assignment:', error);
      res.status(500).json({ success: false, error: 'Failed to create access assignment' } as APIResponse);
    }
  }
);

// Revoke an assignment
router.delete('/assignments/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid assignment id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(
      `UPDATE access_assignments SET is_active = false WHERE id = $1 RETURNING id, event_id`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Assignment not found' } as APIResponse);
      return;
    }
    await invalidateAccessCaches(result.rows[0].event_id);
    res.json({ success: true, data: result.rows[0], message: 'Assignment revoked' } as APIResponse);
  } catch (error) {
    console.error('Error revoking access assignment:', error);
    res.status(500).json({ success: false, error: 'Failed to revoke access assignment' } as APIResponse);
  }
});

export default router;
