import { Pool } from 'pg';
import { QueueRecordResult } from '../types';

export const MAX_SCAN_UPLOAD_BATCH_SIZE = 500;

interface PreparedScanRecord {
  index: number;
  client_record_id: string;
  user_id: number | null;
  area_id: number;
  access_granted: boolean;
  failure_reason: string | null;
  scanned_at: string;
  device_info: Record<string, unknown>;
}

interface BatchOptions {
  eventId: number;
  scannerUserId: number | null;
  deviceId: unknown;
  logs: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejected(clientRecordId: string, error: string): QueueRecordResult {
  return { client_record_id: clientRecordId, status: 'rejected', error };
}

function prepareRecord(
  value: unknown,
  index: number,
  eventId: number,
  deviceId: unknown
): PreparedScanRecord | QueueRecordResult {
  if (!isRecord(value)) return rejected('', 'Invalid scan record');

  const clientRecordId = String(value.client_record_id || value.device_scan_id || '').trim();
  if (!clientRecordId) return rejected('', 'client_record_id is required');
  if (clientRecordId.length > 100) return rejected(clientRecordId, 'client_record_id must not exceed 100 characters');

  if (Number(value.event_id) !== eventId) {
    return rejected(clientRecordId, 'Queued record event_id does not match the authorized event');
  }

  const areaId = Number(value.area_id);
  if (!Number.isInteger(areaId) || areaId <= 0) return rejected(clientRecordId, 'area_id must be a positive integer');

  const rawUserId = value.user_id;
  const userId = rawUserId === null || rawUserId === undefined ? null : Number(rawUserId);
  if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
    return rejected(clientRecordId, 'user_id must be a positive integer when provided');
  }

  const rawGranted = value.access_granted;
  if (rawGranted !== true && rawGranted !== false && rawGranted !== 1 && rawGranted !== 0) {
    return rejected(clientRecordId, 'access_granted must be a boolean');
  }

  const scannedAt = new Date(String(value.scanned_at || ''));
  if (Number.isNaN(scannedAt.getTime())) return rejected(clientRecordId, 'scanned_at must be a valid timestamp');

  if (value.failure_reason !== undefined && value.failure_reason !== null && typeof value.failure_reason !== 'string') {
    return rejected(clientRecordId, 'failure_reason must be a string when provided');
  }

  const sourceDeviceInfo = isRecord(value.device_info) ? value.device_info : {};

  return {
    index,
    client_record_id: clientRecordId,
    user_id: userId,
    area_id: areaId,
    access_granted: rawGranted === true || rawGranted === 1,
    failure_reason: typeof value.failure_reason === 'string' ? value.failure_reason : null,
    scanned_at: scannedAt.toISOString(),
    device_info: { device_id: deviceId ?? null, ...sourceDeviceInfo },
  };
}

export async function persistScanLogBatch(
  db: Pick<Pool, 'query'>,
  options: BatchOptions
): Promise<QueueRecordResult[]> {
  const results: Array<QueueRecordResult | undefined> = new Array(options.logs.length);
  const occurrences: PreparedScanRecord[] = [];
  const uniqueRecords = new Map<string, PreparedScanRecord>();

  options.logs.forEach((log, index) => {
    const prepared = prepareRecord(log, index, options.eventId, options.deviceId);
    if ('status' in prepared) {
      results[index] = prepared;
      return;
    }

    occurrences.push(prepared);
    if (!uniqueRecords.has(prepared.client_record_id)) {
      uniqueRecords.set(prepared.client_record_id, prepared);
    }
  });

  if (uniqueRecords.size === 0) return results as QueueRecordResult[];

  const candidates = Array.from(uniqueRecords.values());
  const insertedById = new Map<string, number>();
  const persistedById = new Map<string, number>();

  try {
    const inserted = await db.query(
      `WITH input AS (
         SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS record(
           client_record_id VARCHAR(100),
           user_id INTEGER,
           area_id INTEGER,
           access_granted BOOLEAN,
           failure_reason TEXT,
           scanned_at TIMESTAMPTZ,
           device_info JSONB
         )
       )
       INSERT INTO scan_logs (
         event_id, user_id, area_id, scanner_user_id, access_granted,
         failure_reason, scanned_at, device_info, device_scan_id
       )
       SELECT $2, input.user_id, input.area_id, $3, input.access_granted,
              input.failure_reason, input.scanned_at, input.device_info, input.client_record_id
       FROM input
       WHERE EXISTS (
         SELECT 1 FROM areas WHERE areas.id = input.area_id AND areas.event_id = $2
       )
       AND (
         input.user_id IS NULL OR EXISTS (SELECT 1 FROM users WHERE users.id = input.user_id)
       )
       ON CONFLICT (device_scan_id) DO NOTHING
       RETURNING id, device_scan_id`,
      [JSON.stringify(candidates), options.eventId, options.scannerUserId]
    );

    inserted.rows.forEach((row: { id: number; device_scan_id: string }) => {
      insertedById.set(row.device_scan_id, row.id);
    });

    const persisted = await db.query(
      'SELECT id, device_scan_id FROM scan_logs WHERE device_scan_id = ANY($1::varchar[])',
      [candidates.map((record) => record.client_record_id)]
    );
    persisted.rows.forEach((row: { id: number; device_scan_id: string }) => {
      persistedById.set(row.device_scan_id, row.id);
    });

    const firstOccurrence = new Set<string>();
    occurrences.forEach((record) => {
      const insertedId = insertedById.get(record.client_record_id);
      const persistedId = persistedById.get(record.client_record_id);
      const isFirst = !firstOccurrence.has(record.client_record_id);
      firstOccurrence.add(record.client_record_id);

      if (insertedId !== undefined && isFirst) {
        results[record.index] = {
          client_record_id: record.client_record_id,
          status: 'accepted',
          server_id: insertedId,
        };
      } else if (persistedId !== undefined) {
        results[record.index] = {
          client_record_id: record.client_record_id,
          status: 'duplicate',
          server_id: persistedId,
        };
      } else {
        results[record.index] = rejected(
          record.client_record_id,
          'Record references a user or area outside the authorized event'
        );
      }
    });
  } catch (error) {
    console.error('Error inserting scan log batch:', error);
    occurrences.forEach((record) => {
      results[record.index] = {
        client_record_id: record.client_record_id,
        status: 'retryable_error',
        error: 'Temporary persistence failure',
      };
    });
  }

  return results as QueueRecordResult[];
}
