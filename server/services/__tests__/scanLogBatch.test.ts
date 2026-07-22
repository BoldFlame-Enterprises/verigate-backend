import { Pool } from 'pg';
import { MAX_SCAN_UPLOAD_BATCH_SIZE, persistScanLogBatch } from '../scanLogBatch';

function record(clientRecordId: string, overrides: Record<string, unknown> = {}) {
  return {
    client_record_id: clientRecordId,
    event_id: 5,
    user_id: 1,
    area_id: 2,
    access_granted: true,
    scanned_at: '2026-07-22T01:00:00.000Z',
    ...overrides,
  };
}

describe('scan log batch persistence', () => {
  it('supports bounded batches large enough for device queue uploads', () => {
    expect(MAX_SCAN_UPLOAD_BATCH_SIZE).toBe(500);
  });

  it('persists a batch in two queries and preserves accepted and duplicate acknowledgements', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 101, device_scan_id: 'scan-new' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 101, device_scan_id: 'scan-new' },
          { id: 88, device_scan_id: 'scan-existing' },
        ],
      });

    const results = await persistScanLogBatch({ query } as unknown as Pick<Pool, 'query'>, {
      eventId: 5,
      scannerUserId: 9,
      deviceId: 'device-1',
      logs: [record('scan-new'), record('scan-existing')],
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('jsonb_to_recordset');
    expect(JSON.parse(query.mock.calls[0][1][0])).toHaveLength(2);
    expect(results.map((item) => item.status)).toEqual(['accepted', 'duplicate']);
    expect(results.map((item) => item.server_id)).toEqual([101, 88]);
  });

  it('inserts one copy when a batch repeats the same client record id', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 101, device_scan_id: 'scan-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 101, device_scan_id: 'scan-1' }] });

    const results = await persistScanLogBatch({ query } as unknown as Pick<Pool, 'query'>, {
      eventId: 5,
      scannerUserId: 9,
      deviceId: 'device-1',
      logs: [record('scan-1'), record('scan-1')],
    });

    const payload = JSON.parse(query.mock.calls[0][1][0]);
    expect(payload).toHaveLength(1);
    expect(results.map((item) => item.status)).toEqual(['accepted', 'duplicate']);
  });

  it('rejects malformed records before querying PostgreSQL', async () => {
    const query = jest.fn();

    const results = await persistScanLogBatch({ query } as unknown as Pick<Pool, 'query'>, {
      eventId: 5,
      scannerUserId: 9,
      deviceId: 'device-1',
      logs: [record('', {}), record('wrong-event', { event_id: 6 }), record('bad-area', { area_id: 0 })],
    });

    expect(query).not.toHaveBeenCalled();
    expect(results.map((item) => item.status)).toEqual(['rejected', 'rejected', 'rejected']);
  });

  it('returns retryable acknowledgements for valid records when the batch query fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('database unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const results = await persistScanLogBatch({ query } as unknown as Pick<Pool, 'query'>, {
      eventId: 5,
      scannerUserId: 9,
      deviceId: 'device-1',
      logs: [record('scan-1'), record('scan-2')],
    });

    expect(results.map((item) => item.status)).toEqual(['retryable_error', 'retryable_error']);
    consoleError.mockRestore();
  });
});
