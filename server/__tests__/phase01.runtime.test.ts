import express from 'express';
import request from 'supertest';
import { connectDB, disconnectDB, getDB } from '../config/database';
import { connectRedis, disconnectRedis, getCache, setCache } from '../config/redis';
import syncRouter from '../routes/sync';
import incidentsRouter from '../routes/incidents';

const runtimeDescribe = process.env.RUN_PHASE01_RUNTIME === 'true' ? describe : describe.skip;

runtimeDescribe('Phase 1 PostgreSQL and Redis contracts', () => {
  let eventA: number;
  let eventB: number;
  let scannerId: number;
  let attendeeId: number;
  let areaA: number;
  let areaB: number;
  let clientSuffix: string;

  beforeAll(async () => {
    await connectDB();
    await connectRedis();
    const db = getDB();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    clientSuffix = suffix;
    const events = await db.query(
      `INSERT INTO events (name, slug, starts_at, ends_at, is_active)
       VALUES ($1, $2, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', true),
              ($3, $4, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', true)
       RETURNING id`,
      [`Runtime A ${suffix}`, `runtime-a-${suffix}`, `Runtime B ${suffix}`, `runtime-b-${suffix}`]
    );
    [eventA, eventB] = events.rows.map((row) => Number(row.id));

    const users = await db.query(
      `INSERT INTO users (email, name, phone, password_hash, role, is_active)
       VALUES ($1, 'Runtime Scanner', '1111111111', 'not-used', 'scanner', true),
              ($2, 'Runtime Attendee', '2222222222', 'not-used', 'user', true)
       RETURNING id`,
      [`runtime-scanner-${suffix}@example.com`, `runtime-attendee-${suffix}@example.com`]
    );
    [scannerId, attendeeId] = users.rows.map((row) => Number(row.id));
    await db.query(
      `INSERT INTO event_members (event_id, user_id, role_in_event, is_active)
       VALUES ($1, $2, 'scanner', true), ($1, $3, 'attendee', true)`,
      [eventA, scannerId, attendeeId]
    );

    const areas = await db.query(
      `INSERT INTO areas (event_id, name, is_active)
       VALUES ($1, $3, true), ($1, $4, true), ($2, $5, true)
       RETURNING id, event_id`,
      [eventA, eventB, `Arena ${suffix}`, `Lounge ${suffix}`, `Other ${suffix}`]
    );
    areaA = Number(areas.rows.find((row) => Number(row.event_id) === eventA).id);
    areaB = Number(areas.rows.find((row) => Number(row.event_id) === eventB).id);
    const secondAreaA = Number(areas.rows.filter((row) => Number(row.event_id) === eventA)[1].id);

    const levels = await db.query(
      `INSERT INTO access_levels (event_id, name, priority, is_active)
       VALUES ($1, $2, 1, true), ($1, $3, 5, true)
       RETURNING id, priority`,
      [eventA, `General ${suffix}`, `VIP ${suffix}`]
    );
    levels.rows.sort((left, right) => Number(left.priority) - Number(right.priority));
    await db.query(
      `INSERT INTO access_assignments
         (event_id, user_id, access_level_id, area_id, valid_from, valid_until, is_active)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', true),
              ($1, $2, $5, $6, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', true)`,
      [eventA, attendeeId, levels.rows[0].id, areaA, levels.rows[1].id, secondAreaA]
    );
  }, 30_000);

  afterAll(async () => {
    await disconnectRedis();
    await disconnectDB();
  });

  function app() {
    const value = express();
    value.use(express.json());
    value.use((req: any, _res, next) => {
      req.user = { id: scannerId, email: 'runtime-scanner@example.com', role: 'scanner' };
      next();
    });
    value.use('/api/sync', syncRouter);
    value.use('/api/incidents', incidentsRouter);
    return value;
  }

  it('has the migrated QR and queue storage and applies the migration idempotently', async () => {
    const tables = await getDB().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('device_credentials', 'incidents', 'emergency_overrides')`
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'device_credentials', 'emergency_overrides', 'incidents',
    ]);
    const columns = await getDB().query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'scan_logs' AND column_name = 'received_at'`
    );
    expect(columns.rows).toHaveLength(1);
  });

  it('denies another event and returns one lossless multi-assignment projection', async () => {
    const denied = await request(app()).get(`/api/sync/users-database?event_id=${eventB}`);
    expect(denied.status).toBe(403);

    const allowed = await request(app()).get(`/api/sync/users-database?event_id=${eventA}`);
    expect(allowed.status).toBe(200);
    const attendee = allowed.body.data.users.find((user: any) => user.id === attendeeId);
    expect(attendee.assignments).toHaveLength(2);
    expect(new Set(attendee.assignments.map((assignment: any) => assignment.access_priority))).toEqual(new Set([1, 5]));
  });

  it('returns per-record results and de-duplicates a retry', async () => {
    const occurredAt = new Date(Date.now() - 60_000).toISOString();
    const acceptedId = `runtime-scan-accepted-${clientSuffix}`;
    const rejectedId = `runtime-scan-rejected-${clientSuffix}`;
    const first = await request(app()).post('/api/sync/scan-logs').send({
      event_id: eventA,
      device_id: 'runtime-device',
      logs: [
        { client_record_id: acceptedId, event_id: eventA, user_id: attendeeId, area_id: areaA, access_granted: true, scanned_at: occurredAt },
        { client_record_id: rejectedId, event_id: eventA, user_id: attendeeId, area_id: areaB, access_granted: true, scanned_at: occurredAt },
      ],
    });
    expect(first.body.data.results.map((item: any) => item.status)).toEqual(['accepted', 'rejected']);

    const retry = await request(app()).post('/api/sync/scan-logs').send({
      event_id: eventA,
      device_id: 'runtime-device',
      logs: [{ client_record_id: acceptedId, event_id: eventA, user_id: attendeeId, area_id: areaA, access_granted: true, scanned_at: occurredAt }],
    });
    expect(retry.body.data.results[0].status).toBe('duplicate');
  });

  it('preserves incident occurrence time separately from receipt time', async () => {
    const occurredAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const clientRecordId = `runtime-incident-${clientSuffix}`;
    const response = await request(app()).post('/api/incidents').send({
      event_id: eventA,
      area_id: areaA,
      category: 'runtime',
      description: 'Runtime timestamp validation',
      client_record_id: clientRecordId,
      occurred_at: occurredAt,
    });
    expect(response.status).toBe(201);
    const row = await getDB().query(
      'SELECT occurred_at, received_at FROM incidents WHERE client_record_id = $1',
      [clientRecordId]
    );
    expect(new Date(row.rows[0].occurred_at).toISOString()).toBe(occurredAt);
    expect(new Date(row.rows[0].received_at).getTime()).toBeGreaterThan(new Date(occurredAt).getTime());
  });

  it('uses Redis when present and fails open after disconnect', async () => {
    await setCache('phase01:runtime', 'ok', 60);
    expect(await getCache('phase01:runtime')).toBe('ok');
    await disconnectRedis();
    expect(await getCache('phase01:runtime')).toBeNull();
  });
});
