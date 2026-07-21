import { NextFunction, Response } from 'express';
import { getDB } from '../config/database';
import { APIResponse, AuthRequest } from '../types';

export type EventIdLocation = 'params' | 'query' | 'body';

export interface EventAuthorizationOptions {
  location: EventIdLocation;
  key?: string;
  globalRoles?: string[];
  principalRoles?: string[];
  eventRoles?: string[];
}

function reject(res: Response, status: number, error: string): void {
  res.status(status).json({ success: false, error } as APIResponse);
}

function readEventId(req: AuthRequest, location: EventIdLocation, key: string): number {
  const container = req[location] as Record<string, unknown>;
  const raw = container?.[key];
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : Number.NaN;
}

export async function authorizeEventId(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  eventId: number,
  options: Omit<EventAuthorizationOptions, 'location' | 'key'> = {}
): Promise<void> {
  if (!req.user) {
    reject(res, 401, 'Authentication required');
    return;
  }

  if (!Number.isInteger(eventId) || eventId <= 0) {
    reject(res, 400, 'Valid event_id is required');
    return;
  }

  const globalRoles = options.globalRoles ?? ['admin'];
  if (globalRoles.includes(req.user.role)) {
    req.event = { id: eventId, role: req.user.role, isGlobalAdmin: true };
    next();
    return;
  }

  if (options.principalRoles && !options.principalRoles.includes(req.user.role)) {
    reject(res, 403, 'Insufficient permissions for this event operation');
    return;
  }

  try {
    const result = await getDB().query(
      `SELECT role_in_event
       FROM event_members
       WHERE event_id = $1 AND user_id = $2 AND is_active = true`,
      [eventId, req.user.id]
    );

    if (result.rows.length === 0) {
      reject(res, 403, 'Active event membership required');
      return;
    }

    const eventRole = String(result.rows[0].role_in_event || 'attendee');
    if (options.eventRoles && !options.eventRoles.includes(eventRole)) {
      reject(res, 403, 'Insufficient event role');
      return;
    }

    req.event = { id: eventId, role: eventRole, isGlobalAdmin: false };
    next();
  } catch (error) {
    console.error('Event authorization error:', error);
    reject(res, 500, 'Failed to authorize event access');
  }
}

export function requireEventAccess(options: EventAuthorizationOptions) {
  const key = options.key ?? 'event_id';
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const eventId = readEventId(req, options.location, key);
    await authorizeEventId(req, res, next, eventId, options);
  };
}

type EventResource = 'access_levels' | 'areas' | 'access_assignments' | 'incidents' | 'emergency_overrides';

export function requireEventResourceAccess(
  resource: EventResource,
  options: Omit<EventAuthorizationOptions, 'location' | 'key'> = {},
  param = 'id'
) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const raw = req.params[param];
    const resourceId = Number.parseInt(raw, 10);
    if (!Number.isInteger(resourceId) || resourceId <= 0) {
      reject(res, 400, 'Valid resource id is required');
      return;
    }

    try {
      const result = await getDB().query(`SELECT event_id FROM ${resource} WHERE id = $1`, [resourceId]);
      if (result.rows.length === 0) {
        reject(res, 404, 'Event resource not found');
        return;
      }
      await authorizeEventId(req, res, next, Number(result.rows[0].event_id), options);
    } catch (error) {
      console.error('Event resource authorization error:', error);
      reject(res, 500, 'Failed to authorize event resource');
    }
  };
}
