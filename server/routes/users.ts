import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import argon2 from 'argon2';
import { getDB } from '../config/database';
import { requireAdmin } from '../middleware/auth';
import { AuthRequest, APIResponse } from '../types';

const router = Router();

const USER_COLUMNS = `id, email, name, phone, device_id, role, is_active, created_at, updated_at`;

router.get('/me', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const db = getDB();
    const result = await db.query(
      `SELECT id, email, name, phone, role, is_active FROM users WHERE id = $1`,
      [req.user?.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'User not found' } as APIResponse);
      return;
    }

    res.json({ success: true, data: result.rows[0] } as APIResponse);
  } catch (error) {
    console.error('Error getting current user:', error);
    res.status(500).json({ success: false, error: 'Failed to get current user' } as APIResponse);
  }
});

// List users (admin only)
router.get('/',
  requireAdmin,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('role').optional().isIn(['admin', 'scanner', 'user']),
    query('is_active').optional().isBoolean().toBoolean(),
    query('search').optional().trim()
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const response: APIResponse = { success: false, error: 'Validation failed', data: errors.array() };
        res.status(400).json(response);
        return;
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: any[] = [];

      if (req.query.role) {
        params.push(req.query.role);
        conditions.push(`role = $${params.length}`);
      }
      if (req.query.is_active !== undefined) {
        params.push(String(req.query.is_active) === 'true');
        conditions.push(`is_active = $${params.length}`);
      }
      if (req.query.search) {
        params.push(`%${req.query.search}%`);
        conditions.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const db = getDB();

      const countResult = await db.query(`SELECT COUNT(*) FROM users ${where}`, params);
      const total = parseInt(countResult.rows[0].count, 10);

      params.push(limit, offset);
      const result = await db.query(
        `SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      const response: APIResponse = {
        success: true,
        data: result.rows,
        message: undefined
      };
      (response as any).pagination = {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1
      };

      res.json(response);
    } catch (error) {
      console.error('Error listing users:', error);
      res.status(500).json({ success: false, error: 'Failed to list users' } as APIResponse);
    }
  }
);

// Get single user (admin only)
router.get('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid user id' } as APIResponse);
      return;
    }

    const db = getDB();
    const result = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'User not found' } as APIResponse);
      return;
    }

    const assignments = await db.query(
      `SELECT aa.id, aa.area_id, a.name as area_name, aa.access_level_id, al.name as access_level_name,
              aa.valid_from, aa.valid_until, aa.is_active
       FROM access_assignments aa
       JOIN areas a ON a.id = aa.area_id
       JOIN access_levels al ON al.id = aa.access_level_id
       WHERE aa.user_id = $1
       ORDER BY aa.id`,
      [id]
    );

    const response: APIResponse = {
      success: true,
      data: { ...result.rows[0], access_assignments: assignments.rows }
    };
    res.json(response);
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({ success: false, error: 'Failed to get user' } as APIResponse);
  }
});

// Create user (admin only)
router.post('/',
  requireAdmin,
  [
    body('email').isEmail().normalizeEmail(),
    body('name').trim().isLength({ min: 2, max: 100 }),
    body('phone').trim().isLength({ min: 10, max: 15 }),
    body('password').isLength({ min: 8, max: 128 }),
    body('role').optional().isIn(['admin', 'scanner', 'user'])
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const { email, name, phone, password, role = 'user' } = req.body;
      const db = getDB();

      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        res.status(409).json({ success: false, error: 'User already exists with this email' } as APIResponse);
        return;
      }

      const hashedPassword = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16,
        timeCost: 3,
        parallelism: 1,
      });

      const result = await db.query(
        `INSERT INTO users (email, name, phone, password_hash, role, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
         RETURNING ${USER_COLUMNS}`,
        [email, name, phone, hashedPassword, role]
      );

      res.status(201).json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error creating user:', error);
      res.status(500).json({ success: false, error: 'Failed to create user' } as APIResponse);
    }
  }
);

// Update user (admin only)
router.put('/:id',
  requireAdmin,
  [
    body('name').optional().trim().isLength({ min: 2, max: 100 }),
    body('phone').optional().trim().isLength({ min: 10, max: 15 }),
    body('role').optional().isIn(['admin', 'scanner', 'user']),
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
        res.status(400).json({ success: false, error: 'Invalid user id' } as APIResponse);
        return;
      }

      const fields: string[] = [];
      const params: any[] = [];
      for (const key of ['name', 'phone', 'role', 'is_active'] as const) {
        if (req.body[key] !== undefined) {
          params.push(req.body[key]);
          fields.push(`${key} = $${params.length}`);
        }
      }

      if (fields.length === 0) {
        res.status(400).json({ success: false, error: 'No fields to update' } as APIResponse);
        return;
      }

      fields.push(`updated_at = NOW()`);
      params.push(id);

      const db = getDB();
      const result = await db.query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING ${USER_COLUMNS}`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'User not found' } as APIResponse);
        return;
      }

      res.json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error updating user:', error);
      res.status(500).json({ success: false, error: 'Failed to update user' } as APIResponse);
    }
  }
);

// Deactivate user (admin only) - soft delete
router.delete('/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid user id' } as APIResponse);
      return;
    }

    const db = getDB();
    const result = await db.query(
      `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'User not found' } as APIResponse);
      return;
    }

    res.json({ success: true, data: result.rows[0], message: 'User deactivated' } as APIResponse);
  } catch (error) {
    console.error('Error deactivating user:', error);
    res.status(500).json({ success: false, error: 'Failed to deactivate user' } as APIResponse);
  }
});

// Bulk CSV import (admin only) - body: { csv: string }
// Expected header: email,name,phone,password,role
router.post('/bulk-import', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') {
      res.status(400).json({ success: false, error: 'CSV content required' } as APIResponse);
      return;
    }

    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      res.status(400).json({ success: false, error: 'CSV must contain a header row and at least one data row' } as APIResponse);
      return;
    }

    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const required = ['email', 'name', 'phone', 'password'];
    if (!required.every(col => header.includes(col))) {
      res.status(400).json({ success: false, error: `CSV header must include: ${required.join(', ')}` } as APIResponse);
      return;
    }

    const db = getDB();
    const results = { imported: 0, skipped: 0, errors: [] as string[] };

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row: Record<string, string> = {};
      header.forEach((col, idx) => { row[col] = values[idx] ?? ''; });

      try {
        if (!row.email || !row.name || !row.phone || !row.password) {
          results.errors.push(`Row ${i + 1}: missing required field`);
          continue;
        }

        const existing = await db.query('SELECT id FROM users WHERE email = $1', [row.email]);
        if (existing.rows.length > 0) {
          results.skipped++;
          continue;
        }

        const role = ['admin', 'scanner', 'user'].includes(row.role) ? row.role : 'user';
        const hashedPassword = await argon2.hash(row.password, {
          type: argon2.argon2id,
          memoryCost: 2 ** 16,
          timeCost: 3,
          parallelism: 1,
        });

        await db.query(
          `INSERT INTO users (email, name, phone, password_hash, role, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())`,
          [row.email, row.name, row.phone, hashedPassword, role]
        );
        results.imported++;
      } catch (rowError) {
        results.errors.push(`Row ${i + 1}: ${(rowError as Error).message}`);
      }
    }

    res.json({ success: true, data: results } as APIResponse);
  } catch (error) {
    console.error('Error bulk importing users:', error);
    res.status(500).json({ success: false, error: 'Failed to import users' } as APIResponse);
  }
});

// Bulk CSV export (admin only)
router.get('/export/csv', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = getDB();
    const result = await db.query(
      `SELECT id, email, name, phone, role, is_active, created_at FROM users ORDER BY id`
    );

    const header = 'id,email,name,phone,role,is_active,created_at';
    const rows = result.rows.map(u =>
      [u.id, u.email, u.name, u.phone, u.role, u.is_active, new Date(u.created_at).toISOString()].join(',')
    );
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="users-export.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Error exporting users:', error);
    res.status(500).json({ success: false, error: 'Failed to export users' } as APIResponse);
  }
});

export default router;
