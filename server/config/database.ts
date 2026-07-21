import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

export function createDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = env.DATABASE_URL?.trim();
  const sslEnabled = enabled(env.DB_SSL, Boolean(connectionString));
  const ssl = sslEnabled
    ? {
        rejectUnauthorized: enabled(env.DB_SSL_REJECT_UNAUTHORIZED, true),
        ...(env.DB_SSL_CA_BASE64
          ? { ca: Buffer.from(env.DB_SSL_CA_BASE64, 'base64').toString('utf8') }
          : {}),
      }
    : false;

  const shared: PoolConfig = {
    max: positiveInteger(env.DB_POOL_MAX, connectionString ? 5 : 20),
    idleTimeoutMillis: positiveInteger(env.DB_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: positiveInteger(env.DB_CONNECTION_TIMEOUT_MS, 10000),
    ssl,
  };

  if (connectionString) {
    return { ...shared, connectionString };
  }

  return {
    ...shared,
    host: env.DB_HOST || 'localhost',
    port: positiveInteger(env.DB_PORT, 5432),
    database: env.DB_NAME || 'accreditation_system',
    user: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD || '',
  };
}

export async function connectDB(): Promise<void> {
  try {
    pool = new Pool(createDatabaseConfig());
    
    // Test the connection
    const client = await pool.connect();
    console.log('✅ Connected to PostgreSQL database');
    client.release();
  } catch (error) {
    console.error('❌ Failed to connect to PostgreSQL database:', error);
    throw error;
  }
}

export function getDB(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call connectDB() first.');
  }
  return pool;
}

export async function disconnectDB(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('🔌 Disconnected from PostgreSQL database');
  }
}

// Graceful shutdown handler
process.on('SIGINT', async () => {
  await disconnectDB();
});

process.on('SIGTERM', async () => {
  await disconnectDB();
});
