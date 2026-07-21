import { NextFunction, Response } from 'express';
import { getDB } from '../../config/database';
import { authorizeEventId, requireEventAccess } from '../eventAuthorization';
import { AuthRequest } from '../../types';

jest.mock('../../config/database', () => ({ getDB: jest.fn() }));

const mockedGetDB = getDB as jest.MockedFunction<typeof getDB>;

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  } as unknown as Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
}

describe('event authorization', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows a global administrator without a membership lookup', async () => {
    const req = { user: { id: 1, email: 'admin@test.com', role: 'admin' } } as AuthRequest;
    const res = response();
    const next = jest.fn() as NextFunction;

    await authorizeEventId(req, res, next, 9);

    expect(mockedGetDB).not.toHaveBeenCalled();
    expect(req.event).toEqual({ id: 9, role: 'admin', isGlobalAdmin: true });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects an authenticated non-member', async () => {
    mockedGetDB.mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [] }) } as any);
    const req = { user: { id: 2, email: 'user@test.com', role: 'user' } } as AuthRequest;
    const res = response();

    await authorizeEventId(req, res, jest.fn(), 9);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Active event membership required' });
  });

  it('attaches active membership context', async () => {
    mockedGetDB.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [{ role_in_event: 'attendee' }] }),
    } as any);
    const req = { user: { id: 2, email: 'user@test.com', role: 'user' } } as AuthRequest;
    const res = response();
    const next = jest.fn();

    await authorizeEventId(req, res, next, 9);

    expect(req.event).toEqual({ id: 9, role: 'attendee', isGlobalAdmin: false });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed event ids before querying', async () => {
    const middleware = requireEventAccess({ location: 'query' });
    const req = {
      user: { id: 2, email: 'user@test.com', role: 'user' },
      query: { event_id: 'not-a-number' },
    } as unknown as AuthRequest;
    const res = response();

    await middleware(req, res, jest.fn());

    expect(mockedGetDB).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
