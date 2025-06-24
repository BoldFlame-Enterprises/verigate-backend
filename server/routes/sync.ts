import { Router, Request, Response } from 'express';
import { AuthRequest } from '../types';
import { getDB } from '../config/database';
import { APIResponse } from '../types';
import crypto from 'crypto';

const router = Router();

// Get users database for scanner app sync
router.get('/users-database', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = getDB();
    
    // Get all active users with their access assignments
    const result = await db.query(`
      SELECT DISTINCT
        u.id,
        u.email,
        u.name,
        u.phone,
        u.is_active,
        al.name as access_level,
        al.priority as access_priority,
        array_agg(DISTINCT a.name) as allowed_areas,
        array_agg(DISTINCT a.id) as allowed_area_ids
      FROM users u
      LEFT JOIN access_assignments aa ON u.id = aa.user_id AND aa.is_active = true
      LEFT JOIN access_levels al ON aa.access_level_id = al.id
      LEFT JOIN areas a ON aa.area_id = a.id AND a.is_active = true
      WHERE u.is_active = true
      GROUP BY u.id, u.email, u.name, u.phone, u.is_active, al.name, al.priority
      ORDER BY u.id
    `);

    const users = result.rows.map(user => ({
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      access_level: user.access_level || 'general',
      access_priority: user.access_priority || 1,
      allowed_areas: user.allowed_areas?.filter(Boolean) || [],
      allowed_area_ids: user.allowed_area_ids?.filter(Boolean) || [],
      is_active: user.is_active
    }));

    // Generate database checksum for integrity verification
    const dataString = JSON.stringify(users);
    const checksum = crypto.createHash('sha256').update(dataString).digest('hex');
    const timestamp = new Date().toISOString();

    const response: APIResponse = {
      success: true,
      data: {
        users,
        metadata: {
          checksum,
          timestamp,
          count: users.length,
          version: Date.now() // Simple versioning
        }
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error getting users database:', error);
    const response: APIResponse = {
      success: false,
      error: 'Failed to get users database'
    };
    res.status(500).json(response);
  }
});

// Get areas database for scanner app
router.get('/areas-database', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = getDB();
    
    const result = await db.query(`
      SELECT id, name, description, requires_scan, is_active
      FROM areas
      WHERE is_active = true
      ORDER BY id
    `);

    const areas = result.rows;
    const dataString = JSON.stringify(areas);
    const checksum = crypto.createHash('sha256').update(dataString).digest('hex');

    const response: APIResponse = {
      success: true,
      data: {
        areas,
        metadata: {
          checksum,
          timestamp: new Date().toISOString(),
          count: areas.length
        }
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error getting areas database:', error);
    const response: APIResponse = {
      success: false,
      error: 'Failed to get areas database'
    };
    res.status(500).json(response);
  }
});

// Upload scan logs from scanner apps
router.post('/scan-logs', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { logs, device_id } = req.body;
    
    if (!logs || !Array.isArray(logs)) {
      const response: APIResponse = {
        success: false,
        error: 'Invalid logs data'
      };
      res.status(400).json(response);
      return;
    }

    const db = getDB();
    let processed = 0;
    let errors = 0;

    for (const log of logs) {
      try {
        await db.query(`
          INSERT INTO scan_logs (
            user_id, area_id, scanner_user_id, access_granted, 
            failure_reason, scanned_at, device_info
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (user_id, scanned_at) DO NOTHING
        `, [
          log.user_id,
          log.area_id,
          req.user?.id || null, // Scanner user ID from auth
          log.access_granted,
          log.failure_reason,
          log.scanned_at,
          JSON.stringify({ device_id, ...log.device_info })
        ]);
        processed++;
      } catch (logError) {
        console.error('Error inserting scan log:', logError);
        errors++;
      }
    }

    const response: APIResponse = {
      success: true,
      data: {
        processed,
        errors,
        total: logs.length
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error uploading scan logs:', error);
    const response: APIResponse = {
      success: false,
      error: 'Failed to upload scan logs'
    };
    res.status(500).json(response);
  }
});

// Check for database updates
router.get('/check-updates', async (req: Request, res: Response): Promise<void> => {
  try {
    const { users_version, areas_version } = req.query;
    
    const db = getDB();
    
    // Simple versioning based on last update timestamp
    const usersUpdate = await db.query(`
      SELECT EXTRACT(EPOCH FROM MAX(updated_at)) * 1000 as last_update
      FROM users WHERE is_active = true
    `);
    
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
    const response: APIResponse = {
      success: false,
      error: 'Failed to check updates'
    };
    res.status(500).json(response);
  }
});

export default router;
