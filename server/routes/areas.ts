import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireAdmin } from '../middleware/auth';
import { APIResponse } from '../types';
import { deleteCache } from '../config/redis';
import { requireEventAccess, requireEventResourceAccess } from '../middleware/eventAuthorization';

const router = Router();
const AREA_COLUMNS = `id, event_id, name, description, requires_scan, is_active`;

// Areas feed the scanner sync payload and the dashboard's area list; both are
// cached (see sync.ts / access.ts). Any write invalidates the relevant keys.
async function invalidateAreaCaches(eventId: number): Promise<void> {
  await deleteCache(`sync:areas-database:${eventId}`);
  await deleteCache(`analytics:${eventId}:breakdown`);
}

// List areas for an event (any authenticated role)
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
        `SELECT ${AREA_COLUMNS} FROM areas WHERE event_id = $1 ORDER BY id`,
        [eventId]
      );
      res.json({ success: true, data: result.rows } as APIResponse);
    } catch (error) {
      console.error('Error listing areas:', error);
      res.status(500).json({ success: false, error: 'Failed to list areas' } as APIResponse);
    }
  }
);

router.get('/:id',
  requireEventResourceAccess('areas'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid area id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(`SELECT ${AREA_COLUMNS} FROM areas WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Area not found' } as APIResponse);
      return;
    }
    res.json({ success: true, data: result.rows[0] } as APIResponse);
  } catch (error) {
    console.error('Error getting area:', error);
    res.status(500).json({ success: false, error: 'Failed to get area' } as APIResponse);
  }
  }
);

router.post('/',
  requireAdmin,
  [
    body('event_id').isInt(),
    body('name').trim().isLength({ min: 1, max: 100 }),
    body('description').optional().trim(),
    body('requires_scan').optional().isBoolean()
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { event_id, name, description = null, requires_scan = true } = req.body;
      const db = getDB();

      const existing = await db.query('SELECT id FROM areas WHERE event_id = $1 AND name = $2', [event_id, name]);
      if (existing.rows.length > 0) {
        res.status(409).json({ success: false, error: 'An area with this name already exists for this event' } as APIResponse);
        return;
      }

      const result = await db.query(
        `INSERT INTO areas (event_id, name, description, requires_scan, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING ${AREA_COLUMNS}`,
        [event_id, name, description, requires_scan]
      );

      await invalidateAreaCaches(event_id);
      res.status(201).json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error creating area:', error);
      res.status(500).json({ success: false, error: 'Failed to create area' } as APIResponse);
    }
  }
);

router.put('/:id',
  requireAdmin,
  [
    body('name').optional().trim().isLength({ min: 1, max: 100 }),
    body('description').optional().trim(),
    body('requires_scan').optional().isBoolean(),
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
        res.status(400).json({ success: false, error: 'Invalid area id' } as APIResponse);
        return;
      }

      const fields: string[] = [];
      const params: any[] = [];
      for (const key of ['name', 'description', 'requires_scan', 'is_active'] as const) {
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
        `UPDATE areas SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING ${AREA_COLUMNS}`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Area not found' } as APIResponse);
        return;
      }

      await invalidateAreaCaches(result.rows[0].event_id);
      res.json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error updating area:', error);
      res.status(500).json({ success: false, error: 'Failed to update area' } as APIResponse);
    }
  }
);

router.delete('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid area id' } as APIResponse);
      return;
    }
    const db = getDB();
    const result = await db.query(
      `UPDATE areas SET is_active = false WHERE id = $1 RETURNING ${AREA_COLUMNS}`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Area not found' } as APIResponse);
      return;
    }
    await invalidateAreaCaches(result.rows[0].event_id);
    res.json({ success: true, data: result.rows[0], message: 'Area deactivated' } as APIResponse);
  } catch (error) {
    console.error('Error deactivating area:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate area' } as APIResponse);
  }
});

export default router;
