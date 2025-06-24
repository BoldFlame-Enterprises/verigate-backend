import { Router, Request, Response } from 'express';
import { AuthRequest, APIResponse } from '../types';
import { getDB } from '../config/database';
import crypto from 'crypto';

const router = Router();

// Generate QR code data for user
router.get('/generate', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      const response: APIResponse = {
        success: false,
        error: 'User not authenticated'
      };
      res.status(401).json(response);
      return;
    }

    const db = getDB();
    
    // Get user with access information
    const result = await db.query(`
      SELECT DISTINCT
        u.id,
        u.email,
        u.name,
        u.is_active,
        al.name as access_level,
        al.priority as access_priority,
        array_agg(DISTINCT a.name) as allowed_areas
      FROM users u
      LEFT JOIN access_assignments aa ON u.id = aa.user_id AND aa.is_active = true
      LEFT JOIN access_levels al ON aa.access_level_id = al.id
      LEFT JOIN areas a ON aa.area_id = a.id AND a.is_active = true
      WHERE u.id = $1 AND u.is_active = true
      GROUP BY u.id, u.email, u.name, u.is_active, al.name, al.priority
    `, [userId]);

    if (result.rows.length === 0) {
      const response: APIResponse = {
        success: false,
        error: 'User not found or inactive'
      };
      res.status(404).json(response);
      return;
    }

    const user = result.rows[0];
    
    // Create QR payload with simple encryption
    const timestamp = Date.now();
    const qrData = {
      user_id: user.id,
      email: user.email,
      name: user.name,
      access_level: user.access_level || 'general',
      allowed_areas: user.allowed_areas?.filter(Boolean) || [],
      timestamp,
      expires_at: timestamp + (60 * 60 * 1000), // 1 hour expiry
    };

    // Simple encryption for demo (in production, use proper encryption)
    const secret = process.env.ENCRYPTION_KEY || 'demo-secret-key';
    const qrString = JSON.stringify(qrData);
    const encrypted = crypto.createHmac('sha256', secret).update(qrString).digest('hex');
    
    // Create QR code content
    const qrContent = {
      data: encrypted,
      checksum: crypto.createHash('md5').update(qrString).digest('hex').substring(0, 8),
      version: '1.0'
    };

    const response: APIResponse = {
      success: true,
      data: {
        qr_content: JSON.stringify(qrContent),
        user_info: {
          name: user.name,
          email: user.email,
          access_level: user.access_level || 'general',
          allowed_areas: user.allowed_areas?.filter(Boolean) || []
        },
        expires_at: qrData.expires_at,
        generated_at: timestamp
      }
    };

    res.json(response);
  } catch (error) {
    console.error('Error generating QR code:', error);
    const response: APIResponse = {
      success: false,
      error: 'Failed to generate QR code'
    };
    res.status(500).json(response);
  }
});

// Verify QR code (for testing)
router.post('/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const { qr_content, area_id } = req.body;
    
    if (!qr_content || !area_id) {
      const response: APIResponse = {
        success: false,
        error: 'QR content and area ID required'
      };
      res.status(400).json(response);
      return;
    }

    try {
      JSON.parse(qr_content); // Just validate JSON format for demo
      
      // This is a simplified verification for demo
      // In production, you'd properly decrypt and validate
      
      const response: APIResponse = {
        success: true,
        data: {
          access_granted: true,
          user_name: 'Demo User',
          access_level: 'VIP',
          message: 'Access granted - Demo verification'
        }
      };

      res.json(response);
    } catch (parseError) {
      const response: APIResponse = {
        success: false,
        error: 'Invalid QR code format',
        data: { access_granted: false }
      };
      res.status(400).json(response);
    }
  } catch (error) {
    console.error('Error verifying QR code:', error);
    const response: APIResponse = {
      success: false,
      error: 'Failed to verify QR code',
      data: { access_granted: false }
    };
    res.status(500).json(response);
  }
});

export default router;
