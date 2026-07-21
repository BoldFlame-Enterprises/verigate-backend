import { createDatabaseConfig } from '../database';
import { isCorsOriginAllowed } from '../cors';
import { createRedisConfig } from '../redis';

describe('deployment configuration', () => {
  it('uses a hosted connection URI with verified TLS and a conservative pool', () => {
    const config = createDatabaseConfig({
      DATABASE_URL: 'postgresql://user:password@db.example.com:5432/postgres',
    });

    expect(config).toMatchObject({
      connectionString: 'postgresql://user:password@db.example.com:5432/postgres',
      max: 5,
      connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: true },
    });
    expect(config).not.toHaveProperty('host');
  });

  it('keeps local discrete settings and allows TLS to be disabled', () => {
    const config = createDatabaseConfig({
      DB_HOST: 'localhost',
      DB_PORT: '5433',
      DB_NAME: 'verigate',
      DB_USER: 'developer',
      DB_PASSWORD: 'secret',
      DB_SSL: 'false',
    });

    expect(config).toMatchObject({
      host: 'localhost',
      port: 5433,
      database: 'verigate',
      user: 'developer',
      password: 'secret',
      max: 20,
      ssl: false,
    });
  });

  it('decodes a supplied CA certificate and honors explicit pool settings', () => {
    const certificate = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----';
    const config = createDatabaseConfig({
      DATABASE_URL: 'postgresql://user:password@db.example.com/postgres',
      DB_POOL_MAX: '3',
      DB_SSL_CA_BASE64: Buffer.from(certificate).toString('base64'),
    });

    expect(config.max).toBe(3);
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: certificate });
  });

  it('uses one hosted Redis URI or the local discrete fallback', () => {
    expect(createRedisConfig({ REDIS_URL: 'rediss://user:secret@cache.example.com:6379' })).toEqual({
      url: 'rediss://user:secret@cache.example.com:6379',
    });
    expect(createRedisConfig({
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6380',
      REDIS_PASSWORD: 'secret',
    })).toEqual({
      socket: { host: 'localhost', port: 6380 },
      password: 'secret',
    });
  });

  it('allows exact configured origins and rejects unconfigured production origins', () => {
    const env = {
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://verigate.example.com, https://admin.example.com',
    };

    expect(isCorsOriginAllowed('https://verigate.example.com', env)).toBe(true);
    expect(isCorsOriginAllowed('https://verigate.example.com.evil.test', env)).toBe(false);
    expect(isCorsOriginAllowed('http://localhost:5173', env)).toBe(false);
    expect(isCorsOriginAllowed(undefined, env)).toBe(true);
  });

  it('allows only real localhost origins during development', () => {
    expect(isCorsOriginAllowed('http://localhost:5173', { NODE_ENV: 'development' })).toBe(true);
    expect(isCorsOriginAllowed('http://127.0.0.1:5173', { NODE_ENV: 'test' })).toBe(true);
    expect(isCorsOriginAllowed('https://localhost.evil.test', { NODE_ENV: 'development' })).toBe(false);
  });
});
