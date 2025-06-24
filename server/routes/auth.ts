import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import argon2 from 'argon2';
import { getDB } from '../config/database';
import { generateTokens, verifyRefreshToken } from '../middleware/auth';
import { APIResponse } from '../types';

const router = Router();

// Register endpoint
router.post('/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('name').trim().isLength({ min: 2, max: 100 }),
    body('phone').trim().isLength({ min: 10, max: 15 }),
    body('password').isLength({ min: 8, max: 128 })
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const response: APIResponse = {
          success: false,
          error: 'Validation failed',
          data: errors.array()
        };
        res.status(400).json(response);
        return;
      }

      const { email, name, phone, password, role = 'user' } = req.body;
      const db = getDB();

      // Check if user already exists
      const existingUser = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );

      if (existingUser.rows.length > 0) {
        const response: APIResponse = {
          success: false,
          error: 'User already exists with this email'
        };
        res.status(409).json(response);
        return;
      }

      // Hash password with Argon2
      const hashedPassword = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16, // 64 MB
        timeCost: 3,
        parallelism: 1,
      });

      // Create user
      const result = await db.query(
        `INSERT INTO users (email, name, phone, password_hash, role, is_active, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW()) 
         RETURNING id, email, name, phone, role, is_active, created_at`,
        [email, name, phone, hashedPassword, role]
      );

      const user = result.rows[0];
      const tokens = generateTokens({
        id: user.id,
        email: user.email,
        role: user.role
      });

      const response: APIResponse = {
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            phone: user.phone,
            role: user.role,
            is_active: user.is_active,
            created_at: user.created_at
          },
          ...tokens
        }
      };

      res.status(201).json(response);
    } catch (error) {
      console.error('Registration error:', error);
      const response: APIResponse = {
        success: false,
        error: 'Failed to register user'
      };
      res.status(500).json(response);
    }
  }
);

// Login endpoint
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const response: APIResponse = {
          success: false,
          error: 'Validation failed',
          data: errors.array()
        };
        res.status(400).json(response);
        return;
      }

      const { email, password } = req.body;
      const db = getDB();

      // Get user
      const result = await db.query(
        'SELECT id, email, name, phone, password_hash, role, is_active FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        const response: APIResponse = {
          success: false,
          error: 'Invalid credentials'
        };
        res.status(401).json(response);
        return;
      }

      const user = result.rows[0];

      if (!user.is_active) {
        const response: APIResponse = {
          success: false,
          error: 'Account is deactivated'
        };
        res.status(401).json(response);
        return;
      }

      // Verify password
      const validPassword = await argon2.verify(user.password_hash, password);
      if (!validPassword) {
        const response: APIResponse = {
          success: false,
          error: 'Invalid credentials'
        };
        res.status(401).json(response);
        return;
      }

      const tokens = generateTokens({
        id: user.id,
        email: user.email,
        role: user.role
      });

      const response: APIResponse = {
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            phone: user.phone,
            role: user.role,
            is_active: user.is_active
          },
          ...tokens
        }
      };

      res.json(response);
    } catch (error) {
      console.error('Login error:', error);
      const response: APIResponse = {
        success: false,
        error: 'Failed to login'
      };
      res.status(500).json(response);
    }
  }
);

// Refresh token endpoint
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      const response: APIResponse = {
        success: false,
        error: 'Refresh token required'
      };
      res.status(401).json(response);
      return;
    }

    const decoded = verifyRefreshToken(refreshToken);
    const tokens = generateTokens({
      id: decoded.id,
      email: decoded.email,
      role: decoded.role
    });

    const response: APIResponse = {
      success: true,
      data: tokens
    };

    res.json(response);
  } catch (error) {
    const response: APIResponse = {
      success: false,
      error: 'Invalid refresh token'
    };
    res.status(401).json(response);
  }
});

export default router;
