import express from 'express';
import request from 'supertest';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('../../middleware/auth', () => ({
  requireAdmin: (req: any, _res: any, next: any) => { req.user = req.user || { id: 1, email: 'admin@test.com', role: 'admin' }; next(); },
}));
jest.mock('argon2', () => ({
  argon2id: 'argon2id',
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));

import { getDB } from '../../config/database';
import argon2 from 'argon2';
import usersRouter from '../users';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 1, email: 'admin@test.com', role: 'admin' };
    next();
  });
  app.use('/api/users', usersRouter);
  return app;
}

describe('GET /api/users/me', () => {
  it('returns the real DB row for the authenticated user, not just JWT claims', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 1, email: 'admin@test.com', name: 'Admin User', phone: '+1', role: 'admin', is_active: true }],
    });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Admin User');
    expect(res.body.data.phone).toBe('+1');
  });

  it('returns 404 when the user row no longer exists', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/users', () => {
  it('paginates and reports totals correctly', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/users?page=1&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('rejects an invalid role filter', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/users?role=superuser');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/users', () => {
  it('hashes the password and creates the user', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // no existing user
      .mockResolvedValueOnce({ rows: [{ id: 5, email: 'new@test.com', name: 'New User', role: 'user' }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).post('/api/users').send({
      email: 'new@test.com', name: 'New User', phone: '1234567890', password: 'password123',
    });

    expect(res.status).toBe(201);
    expect(argon2.hash).toHaveBeenCalledWith('password123', expect.objectContaining({ type: 'argon2id' }));
    expect(query.mock.calls[1][1]).toContain('hashed-password');
  });

  it('rejects a duplicate email with 409', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).post('/api/users').send({
      email: 'dup@test.com', name: 'Dup User', phone: '1234567890', password: 'password123',
    });

    expect(res.status).toBe(409);
  });
});

describe('PUT /api/users/:id', () => {
  it('rejects an update with no fields', async () => {
    (getDB as jest.Mock).mockReturnValue({ query: jest.fn() });
    const app = buildApp();
    const res = await request(app).put('/api/users/1').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent user', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).put('/api/users/999').send({ name: 'Updated Name' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/users/:id', () => {
  it('soft-deletes by setting is_active false', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 1, is_active: false }] });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).delete('/api/users/1');

    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toContain('is_active = false');
  });
});

describe('POST /api/users/bulk-import', () => {
  it('imports new rows and skips existing emails', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // row 1: not existing
      .mockResolvedValueOnce({ rows: [] }) // row 1 insert
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // row 2: already exists
    (getDB as jest.Mock).mockReturnValue({ query });

    const csv = 'email,name,phone,password\nnew@test.com,New,1234567890,password123\nexisting@test.com,Existing,1234567890,password123';

    const app = buildApp();
    const res = await request(app).post('/api/users/bulk-import').send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(1);
    expect(res.body.data.skipped).toBe(1);
  });

  it('rejects a CSV missing required headers', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/users/bulk-import').send({ csv: 'foo,bar\n1,2' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/users/export/csv', () => {
  it('returns a CSV document', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: 1, email: 'a@test.com', name: 'A', phone: '1', role: 'user', is_active: true, created_at: new Date().toISOString() }],
    });
    (getDB as jest.Mock).mockReturnValue({ query });

    const app = buildApp();
    const res = await request(app).get('/api/users/export/csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('a@test.com');
  });
});
