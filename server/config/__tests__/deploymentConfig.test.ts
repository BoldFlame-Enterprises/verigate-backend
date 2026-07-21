import { createDatabaseConfig } from '../database';

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
});
