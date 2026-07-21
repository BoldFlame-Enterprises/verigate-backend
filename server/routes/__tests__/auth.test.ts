import express from 'express';
import request from 'supertest';
import argon2 from 'argon2';
import authRoutes from '../auth';
import { getDB } from '../../config/database';
import { generateTokens } from '../../middleware/auth';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));
jest.mock('argon2', () => ({ hash: jest.fn(), verify: jest.fn(), argon2id: 2 }));
jest.mock('../../middleware/auth', () => ({
  generateTokens: jest.fn(),
  verifyRefreshToken: jest.fn(),
}));

const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;

describe('public registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (argon2.hash as jest.Mock).mockResolvedValue('hashed');
    (generateTokens as jest.Mock).mockReturnValue({ accessToken: 'access', refreshToken: 'refresh' });
  });

  it.each(['admin', 'scanner'])('never persists caller-selected %s role', async (requestedRole) => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 7,
          email: 'new@example.com',
          name: 'New User',
          phone: '1234567890',
          role: 'user',
          is_active: true,
          created_at: new Date().toISOString(),
        }],
      });
    mockedGetDB.mockReturnValue({ query } as any);
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);

    const response = await request(app).post('/api/auth/register').send({
      email: 'new@example.com',
      name: 'New User',
      phone: '1234567890',
      password: 'password123',
      role: requestedRole,
    });

    expect(response.status).toBe(201);
    expect(query.mock.calls[1][1][4]).toBe('user');
    expect(generateTokens).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }));
    expect(response.body.data.user.role).toBe('user');
  });
});
