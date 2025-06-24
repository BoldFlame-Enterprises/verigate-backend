import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, JWTPayload, APIResponse } from '../types';

export async function authenticateToken(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      const response: APIResponse = {
        success: false,
        error: 'Access token required',
      };
      res.status(401).json(response);
      return;
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT secret not configured');
    }
    const decoded = jwt.verify(token, jwtSecret) as JWTPayload;
    
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    const response: APIResponse = {
      success: false,
      error: 'Invalid or expired token',
    };
    res.status(401).json(response);
  }
}

export function requireRole(roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      const response: APIResponse = {
        success: false,
        error: 'Authentication required',
      };
      res.status(401).json(response);
      return;
    }

    if (!roles.includes(req.user.role)) {
      const response: APIResponse = {
        success: false,
        error: 'Insufficient permissions',
      };
      res.status(403).json(response);
      return;
    }

    next();
  };
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  requireRole(['admin'])(req, res, next);
}

export function requireScannerOrAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  requireRole(['admin', 'scanner'])(req, res, next);
}

export function generateTokens(payload: { id: number; email: string; role: string }) {
  const jwtSecret = process.env.JWT_SECRET;
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  
  if (!jwtSecret || !jwtRefreshSecret) {
    throw new Error('JWT secrets not configured');
  }

  const accessToken = jwt.sign(payload, jwtSecret, { 
    expiresIn: process.env.JWT_EXPIRE_TIME || '1h' 
  } as jwt.SignOptions);

  const refreshToken = jwt.sign(payload, jwtRefreshSecret, { 
    expiresIn: process.env.JWT_REFRESH_EXPIRE_TIME || '7d' 
  } as jwt.SignOptions);

  return { accessToken, refreshToken };
}

export function verifyRefreshToken(token: string): JWTPayload {
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!jwtRefreshSecret) {
    throw new Error('JWT refresh secret not configured');
  }
  return jwt.verify(token, jwtRefreshSecret) as JWTPayload;
}
