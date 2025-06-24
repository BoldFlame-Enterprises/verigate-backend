import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;

const config: PoolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'accreditation_system',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

export async function connectDB(): Promise<void> {
  try {
    pool = new Pool(config);
    
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
