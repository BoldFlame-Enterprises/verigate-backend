import { Router, Request, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { getDB } from '../config/database';
import { requireAdmin, requireScannerOrAdmin } from '../middleware/auth';
import {
  AuthRequest,
  APIResponse,
  QUEUE_ACK_CONTRACT_VERSION,
  QueueRecordAcknowledgement,
} from '../types';
import { requireEventAccess } from '../middleware/eventAuthorization';

const router = Router();

function clientRecordIdFrom(req: Request): string | undefined {
  const value = req.body?.client_record_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function acknowledgement<T>(
  req: Request,
  status: QueueRecordAcknowledgement<T>['status'],
  extra: Omit<QueueRecordAcknowledgement<T>, 'contract_version' | 'client_record_id' | 'status'> = {}
): QueueRecordAcknowledgement<T> {
  const clientRecordId = clientRecordIdFrom(req);
  return {
    contract_version: QUEUE_ACK_CONTRACT_VERSION,
    ...(clientRecordId ? { client_record_id: clientRecordId } : {}),
    status,
    ...extra,
  };
}

// --- Incident reports (suspicious activity / technical issues) ---

router.post('/',
  requireScannerOrAdmin,
  [
    body('event_id').isInt(),
    body('description').isString().trim().notEmpty(),
    body('category').optional().isString(),
    body('area_id').optional().isInt(),
    body('client_record_id').isString().trim().isLength({ min: 8, max: 100 }),
    body('occurred_at').isISO8601()
  ],
  requireEventAccess({ location: 'body', principalRoles: ['scanner'] }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          data: acknowledgement(req, 'rejected', { validation_errors: errors.array() }),
        } as APIResponse);
        return;
      }

      const {
        event_id,
        description,
        category = 'other',
        area_id = null,
        client_record_id,
        occurred_at,
      } = req.body;
      const db = getDB();
      const result = await db.query(
        `INSERT INTO incidents
           (event_id, reporter_user_id, area_id, category, description, status,
            client_record_id, occurred_at, received_at)
         SELECT $1, $2, $3, $4, $5, 'open', $6, $7, NOW()
         WHERE $3::integer IS NULL
            OR EXISTS (SELECT 1 FROM areas WHERE id = $3 AND event_id = $1)
         ON CONFLICT (client_record_id) DO NOTHING
         RETURNING id, event_id, reporter_user_id, area_id, category, description,
                   status, client_record_id, occurred_at, received_at, created_at`,
        [event_id, req.user?.id || null, area_id, category, description, client_record_id, occurred_at]
      );

      if (result.rows.length > 0) {
        res.status(201).json({
          success: true,
          data: acknowledgement(req, 'accepted', { record: result.rows[0] }),
        } as APIResponse);
        return;
      }
      const duplicate = await db.query(
        'SELECT id, client_record_id, occurred_at, received_at FROM incidents WHERE client_record_id = $1',
        [client_record_id]
      );
      if (duplicate.rows.length > 0) {
        res.json({
          success: true,
          data: acknowledgement(req, 'duplicate', { record: duplicate.rows[0] }),
        } as APIResponse);
        return;
      }
      res.status(400).json({
        success: false,
        error: 'area_id does not belong to the authorized event',
        data: acknowledgement(req, 'rejected'),
      } as APIResponse);
    } catch (error) {
      console.error('Error creating incident report:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create incident report',
        data: acknowledgement(req, 'retryable_error'),
      } as APIResponse);
    }
  }
);

router.get('/',
  requireAdmin,
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
        `SELECT i.id, i.event_id, i.reporter_user_id, u.name as reporter_name, i.area_id, a.name as area_name,
                i.category, i.description, i.status, i.client_record_id,
                i.occurred_at, i.received_at, i.created_at, i.resolved_at
         FROM incidents i
         LEFT JOIN users u ON u.id = i.reporter_user_id
         LEFT JOIN areas a ON a.id = i.area_id
         WHERE i.event_id = $1
         ORDER BY i.occurred_at DESC`,
        [eventId]
      );
      res.json({ success: true, data: result.rows } as APIResponse);
    } catch (error) {
      console.error('Error listing incidents:', error);
      res.status(500).json({ success: false, error: 'Failed to list incidents' } as APIResponse);
    }
  }
);

router.put('/:id/status',
  requireAdmin,
  [body('status').isIn(['open', 'reviewing', 'resolved', 'dismissed'])],
  async (req: Request, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({ success: false, error: 'Validation failed', data: errors.array() } as APIResponse);
        return;
      }

      const id = parseInt(req.params.id, 10);
      const { status } = req.body;
      const db = getDB();
      const result = await db.query(
        `UPDATE incidents SET status = $1, resolved_at = CASE WHEN $1 IN ('resolved','dismissed') THEN NOW() ELSE resolved_at END
         WHERE id = $2
         RETURNING id, status, resolved_at`,
        [status, id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Incident not found' } as APIResponse);
        return;
      }

      res.json({ success: true, data: result.rows[0] } as APIResponse);
    } catch (error) {
      console.error('Error updating incident status:', error);
      res.status(500).json({ success: false, error: 'Failed to update incident status' } as APIResponse);
    }
  }
);

// --- Emergency / manual overrides (mandatory reason, synced from scan app) ---

router.post('/overrides',
  requireScannerOrAdmin,
  [
    body('event_id').isInt(),
    body('area_id').isInt(),
    body('reason').isString().trim().isLength({ min: 3 }),
    body('user_id').optional().isInt(),
    body('access_granted').optional().isBoolean(),
    body('client_record_id').isString().trim().isLength({ min: 8, max: 100 }),
    body('occurred_at').isISO8601()
  ],
  requireEventAccess({ location: 'body', principalRoles: ['scanner'] }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          success: false,
          error: 'Validation failed',
          data: acknowledgement(req, 'rejected', { validation_errors: errors.array() }),
        } as APIResponse);
        return;
      }

      const {
        event_id,
        area_id,
        reason,
        user_id = null,
        access_granted = true,
        client_record_id,
        occurred_at,
      } = req.body;
      const db = getDB();

      const result = await db.query(
        `INSERT INTO emergency_overrides
           (event_id, user_id, area_id, scanner_user_id, access_granted, reason,
            client_record_id, occurred_at, received_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, NOW()
         WHERE EXISTS (SELECT 1 FROM areas WHERE id = $3 AND event_id = $1)
         ON CONFLICT (client_record_id) DO NOTHING
         RETURNING id, event_id, user_id, area_id, scanner_user_id, access_granted,
                   reason, client_record_id, occurred_at, received_at, created_at`,
        [event_id, user_id, area_id, req.user?.id || null, access_granted, reason, client_record_id, occurred_at]
      );

      if (result.rows.length === 0) {
        const duplicate = await db.query(
          'SELECT id, client_record_id, occurred_at, received_at FROM emergency_overrides WHERE client_record_id = $1',
          [client_record_id]
        );
        if (duplicate.rows.length > 0) {
          res.json({
            success: true,
            data: acknowledgement(req, 'duplicate', { record: duplicate.rows[0] }),
          } as APIResponse);
          return;
        }
        res.status(400).json({
          success: false,
          error: 'area_id does not belong to the authorized event',
          data: acknowledgement(req, 'rejected'),
        } as APIResponse);
        return;
      }

      // Also log accepted overrides using the original occurrence time.
      await db.query(
        `INSERT INTO scan_logs (event_id, user_id, area_id, scanner_user_id, access_granted, failure_reason, scanned_at, device_info)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event_id,
          user_id,
          area_id,
          req.user?.id || null,
          access_granted,
          access_granted ? null : `Manual override: ${reason}`,
          occurred_at,
          JSON.stringify({ source: 'manual-override', reason })
        ]
      );

      res.status(201).json({
        success: true,
        data: acknowledgement(req, 'accepted', { record: result.rows[0] }),
      } as APIResponse);
    } catch (error) {
      console.error('Error creating emergency override:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create emergency override',
        data: acknowledgement(req, 'retryable_error'),
      } as APIResponse);
    }
  }
);

router.get('/overrides',
  requireAdmin,
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
        `SELECT eo.id, eo.event_id, eo.user_id, u.name as user_name, eo.area_id, a.name as area_name,
                eo.scanner_user_id, su.name as scanner_name, eo.access_granted, eo.reason,
                eo.client_record_id, eo.occurred_at, eo.received_at,
                eo.created_at, eo.reviewed_at, eo.reviewed_by
         FROM emergency_overrides eo
         LEFT JOIN users u ON u.id = eo.user_id
         LEFT JOIN areas a ON a.id = eo.area_id
         LEFT JOIN users su ON su.id = eo.scanner_user_id
         WHERE eo.event_id = $1
         ORDER BY eo.occurred_at DESC`,
        [eventId]
      );
      res.json({ success: true, data: result.rows } as APIResponse);
    } catch (error) {
      console.error('Error listing emergency overrides:', error);
      res.status(500).json({ success: false, error: 'Failed to list emergency overrides' } as APIResponse);
    }
  }
);

router.put('/overrides/:id/review', requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = getDB();
    const result = await db.query(
      `UPDATE emergency_overrides SET reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2
       RETURNING id, reviewed_at, reviewed_by`,
      [req.user?.id || null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Override not found' } as APIResponse);
      return;
    }

    res.json({ success: true, data: result.rows[0] } as APIResponse);
  } catch (error) {
    console.error('Error reviewing emergency override:', error);
    res.status(500).json({ success: false, error: 'Failed to review emergency override' } as APIResponse);
  }
});

export default router;
