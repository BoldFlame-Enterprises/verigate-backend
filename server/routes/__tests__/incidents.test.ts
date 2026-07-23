import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));

import { getDB } from '../../config/database';
import incidentsRouter from '../incidents';

function buildApp(user?: { id: number; email: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/incidents', incidentsRouter);
  return app;
}

describe('POST /api/incidents', () => {
  it('rejects a plain "user" role (only scanner/admin may report)', async () => {
    const app = buildApp({ id: 1, email: 'attendee@test.com', role: 'user' });
    const res = await request(app).post('/api/incidents').send({ event_id: 1, description: 'Something suspicious' });
    expect(res.status).toBe(403);
  });

  it('creates an incident for a scanner', async () => {
    const occurredAt = new Date().toISOString();
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 1, event_id: 1, reporter_user_id: 2, area_id: null, category: 'other', description: 'Something suspicious', status: 'open', client_record_id: 'incident-001', occurred_at: occurredAt }],
    });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 2, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/incidents').send({
      event_id: 1,
      description: 'Something suspicious',
      client_record_id: 'incident-001',
      occurred_at: occurredAt,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'incident-001',
    });
    expect(res.body.data.status).toBe('accepted');
    expect(res.body.data.record.status).toBe('open');
  });

  it('returns an explicit duplicate acknowledgement', async () => {
    const occurredAt = new Date().toISOString();
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, client_record_id: 'incident-duplicate', occurred_at: occurredAt }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const res = await request(buildApp({ id: 2, email: 'admin@test.com', role: 'admin' }))
      .post('/api/incidents')
      .send({
        event_id: 1,
        description: 'Known incident',
        client_record_id: 'incident-duplicate',
        occurred_at: occurredAt,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'incident-duplicate',
      status: 'duplicate',
    });
  });

  it('returns structured rejected and retryable acknowledgements', async () => {
    const app = buildApp({ id: 2, email: 'admin@test.com', role: 'admin' });
    const rejected = await request(app).post('/api/incidents').send({
      event_id: 1,
      description: '',
      client_record_id: 'incident-rejected',
      occurred_at: new Date().toISOString(),
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'incident-rejected',
      status: 'rejected',
    });

    (getDB as jest.Mock).mockReturnValue({ query: jest.fn().mockRejectedValue(new Error('database unavailable')) });
    const retryable = await request(app).post('/api/incidents').send({
      event_id: 1,
      description: 'Retry this incident',
      client_record_id: 'incident-retryable',
      occurred_at: new Date().toISOString(),
    });
    expect(retryable.status).toBe(500);
    expect(retryable.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'incident-retryable',
      status: 'retryable_error',
    });
  });
});

describe('PUT /api/incidents/:id/status', () => {
  it('rejects an invalid status value', async () => {
    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).put('/api/incidents/1/status').send({ status: 'archived' });
    expect(res.status).toBe(400);
  });

  it('updates status and sets resolved_at for a terminal state', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, status: 'resolved', resolved_at: new Date().toISOString() }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).put('/api/incidents/1/status').send({ status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('resolved');
  });
});

describe('POST /api/incidents/overrides', () => {
  it('rejects a plain "user" role', async () => {
    const app = buildApp({ id: 1, email: 'attendee@test.com', role: 'user' });
    const res = await request(app).post('/api/incidents/overrides').send({
      event_id: 1, area_id: 3, reason: 'Badge damaged, verified in person',
    });
    expect(res.status).toBe(403);
  });

  it('requires a real (non-trivial) reason', async () => {
    const app = buildApp({ id: 2, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/incidents/overrides').send({
      event_id: 1, area_id: 3, reason: 'ok', client_record_id: 'override-001', occurred_at: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('records the override and logs it as a real scan for analytics/reporting', async () => {
    const occurredAt = new Date().toISOString();
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 9, event_id: 1, area_id: 3, access_granted: true, reason: 'Badge damaged, verified in person', client_record_id: 'override-002', occurred_at: occurredAt }] })
      .mockResolvedValueOnce({ rows: [] }); // scan_logs insert
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 2, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).post('/api/incidents/overrides').send({
      event_id: 1,
      area_id: 3,
      reason: 'Badge damaged, verified in person',
      user_id: 7,
      client_record_id: 'override-002',
      occurred_at: occurredAt,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'override-002',
      status: 'accepted',
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO scan_logs');
  });

  it('returns duplicate, rejected, and retryable override acknowledgements', async () => {
    const occurredAt = new Date().toISOString();
    const app = buildApp({ id: 2, email: 'admin@test.com', role: 'admin' });

    const duplicateQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 9, client_record_id: 'override-duplicate', occurred_at: occurredAt }] });
    (getDB as jest.Mock).mockReturnValue({ query: duplicateQuery });
    const duplicate = await request(app).post('/api/incidents/overrides').send({
      event_id: 1,
      area_id: 3,
      reason: 'Known override',
      client_record_id: 'override-duplicate',
      occurred_at: occurredAt,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'override-duplicate',
      status: 'duplicate',
    });

    const rejected = await request(app).post('/api/incidents/overrides').send({
      event_id: 1,
      area_id: 3,
      reason: 'x',
      client_record_id: 'override-rejected',
      occurred_at: occurredAt,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'override-rejected',
      status: 'rejected',
    });

    (getDB as jest.Mock).mockReturnValue({ query: jest.fn().mockRejectedValue(new Error('database unavailable')) });
    const retryable = await request(app).post('/api/incidents/overrides').send({
      event_id: 1,
      area_id: 3,
      reason: 'Retry this override',
      client_record_id: 'override-retryable',
      occurred_at: occurredAt,
    });
    expect(retryable.status).toBe(500);
    expect(retryable.body.data).toMatchObject({
      contract_version: 'queue-ack-v2',
      client_record_id: 'override-retryable',
      status: 'retryable_error',
    });
  });
});

describe('PUT /api/incidents/overrides/:id/review', () => {
  it('returns 404 when the override does not exist', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).put('/api/incidents/overrides/999/review');

    expect(res.status).toBe(404);
  });

  it('marks the override reviewed by the calling admin', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 9, reviewed_at: new Date().toISOString(), reviewed_by: 1 }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp({ id: 1, email: 'admin@test.com', role: 'admin' });
    const res = await request(app).put('/api/incidents/overrides/9/review');

    expect(res.status).toBe(200);
    expect(query.mock.calls[0][1]).toEqual([1, 9]);
  });
});
