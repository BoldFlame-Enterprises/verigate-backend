import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireAdmin } from '../middleware/auth';
import { AuthRequest, APIResponse } from '../types';
import { deleteCache } from '../config/redis';
import { requireEventAccess } from '../middleware/eventAuthorization';

const router = Router();

const EVENT_COLUMNS = `id, name, slug, description, starts_at, ends_at, is_active, created_at, updated_at`;

// List events. Regular users/scanners only see events they're a member of;
// admins see everything.
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const db = getDB();

    if (req.user?.role === 'admin') {
      const result = await db.query(`SELECT ${EVENT_COLUMNS} FROM events ORDER BY id DESC`);
      res.json({ success: true, data: result.rows } as APIResponse);
      return;
    }

    const result = await db.query(
      `SELECT e.${EVENT_COLUMNS.split(', ').join(', e.')}, em.role_in_event
       FROM events e
       JOIN event_members em ON em.event_id = e.id
       WHERE em.user_id = $1 AND em.is_active = true
       ORDER BY e.id DESC`,
      [req.user?.id]
    );
    res.json({ success: true, data: result.rows } as APIResponse);
  } catch (error) {
    console.error('Error listing events:', error);
    res.status(500).json({ success: false, error: 'Failed to list events' } as APIResponse);
  }
});

router.get('/:id',
  requireEventAccess({ location: 'params', key: 'id' }),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid event id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Event not found' } as APIResponse);
      return;
    }
    res.json({ success: true, data: result.rows[0] } as APIResponse);
  } catch (error) {
    console.error('Error getting event:', error);
    res.status(500).json({ success: false, error: 'Failed to get event' } as APIResponse);
  }
  }
);

router.post('/',
  requireAdmin,
  [
    body('name').trim().isLength({ min: 2, max: 200 }),
    body('slug').trim().isSlug(),
    body('description').optional().trim(),
    body('starts_at').optional().isISO8601(),
    body('ends_at').optional().isISO8601()
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { name, slug, description = null, starts_at = null, ends_at = null } = req.body;
      const db = getDB();

      const existing = await db.query('SELECT id FROM events WHERE slug = $1', [slug]);
      if (existing.rows.length > 0) {
        res.status(409).json({ success: false, error: 'An event with this slug already exists' } as APIResponse);
        return;
      }

      const result = await db.query(
        `INSERT INTO events (name, slug, description, starts_at, ends_at, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING ${EVENT_COLUMNS}`,
        [name, slug, description, starts_at, ends_at]
      );

      res.status(201).json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error creating event:', error);
      res.status(500).json({ success: false, error: 'Failed to create event' } as APIResponse);
    }
  }
);

router.put('/:id',
  requireAdmin,
  [
    body('name').optional().trim().isLength({ min: 2, max: 200 }),
    body('description').optional().trim(),
    body('starts_at').optional().isISO8601(),
    body('ends_at').optional().isISO8601(),
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
        res.status(400).json({ success: false, error: 'Invalid event id' } as APIResponse);
        return;
      }

      const fields: string[] = [];
      const params: any[] = [];
      for (const key of ['name', 'description', 'starts_at', 'ends_at', 'is_active'] as const) {
        if (req.body[key] !== undefined) {
          params.push(req.body[key]);
          fields.push(`${key} = $${params.length}`);
        }
      }

      if (fields.length === 0) {
        res.status(400).json({ success: false, error: 'No fields to update' } as APIResponse);
        return;
      }

      fields.push('updated_at = NOW()');
      params.push(id);

      const db = getDB();
      const result = await db.query(
        `UPDATE events SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING ${EVENT_COLUMNS}`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Event not found' } as APIResponse);
        return;
      }

      await deleteCache(`event:${id}:dashboard`);
      res.json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error updating event:', error);
      res.status(500).json({ success: false, error: 'Failed to update event' } as APIResponse);
    }
  }
);

// --- Event membership ---

router.get('/:id/members', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (Number.isNaN(eventId)) {
      res.status(400).json({ success: false, error: 'Invalid event id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(
      `SELECT em.id, em.user_id, u.name, u.email, u.role, em.role_in_event, em.is_active, em.joined_at
       FROM event_members em
       JOIN users u ON u.id = em.user_id
       WHERE em.event_id = $1
       ORDER BY em.id`,
      [eventId]
    );
    res.json({ success: true, data: result.rows } as APIResponse);
  } catch (error) {
    console.error('Error listing event members:', error);
    res.status(500).json({ success: false, error: 'Failed to list event members' } as APIResponse);
  }
});

router.post('/:id/members',
  requireAdmin,
  [body('user_id').isInt(), body('role_in_event').optional().trim()],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const eventId = parseInt(req.params.id, 10);
      if (Number.isNaN(eventId)) {
        res.status(400).json({ success: false, error: 'Invalid event id' } as APIResponse);
        return;
      }

      const { user_id, role_in_event = 'attendee' } = req.body;
      const db = getDB();

      const result = await db.query(
        `INSERT INTO event_members (event_id, user_id, role_in_event, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (event_id, user_id) DO UPDATE SET role_in_event = EXCLUDED.role_in_event, is_active = true
         RETURNING id, event_id, user_id, role_in_event, is_active, joined_at`,
        [eventId, user_id, role_in_event]
      );

      res.status(201).json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error adding event member:', error);
      res.status(500).json({ success: false, error: 'Failed to add event member' } as APIResponse);
    }
  }
);

router.delete('/:id/members/:userId', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(eventId) || Number.isNaN(userId)) {
      res.status(400).json({ success: false, error: 'Invalid id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(
      `UPDATE event_members SET is_active = false WHERE event_id = $1 AND user_id = $2 RETURNING id`,
      [eventId, userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Membership not found' } as APIResponse);
      return;
    }
    res.json({ success: true, data: result.rows[0], message: 'Member removed from event' } as APIResponse);
  } catch (error) {
    console.error('Error removing event member:', error);
    res.status(500).json({ success: false, error: 'Failed to remove event member' } as APIResponse);
  }
});

export default router;
