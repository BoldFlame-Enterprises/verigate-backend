import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import { createDatabaseConfig } from '../config/database';

dotenv.config();

const pool = new Pool(createDatabaseConfig());

async function addColumn(client: PoolClient, table: string, definition: string): Promise<void> {
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${definition}`);
}

async function ensureTimestamptz(client: PoolClient, table: string, column: string): Promise<void> {
  const result = await client.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (result.rows[0]?.data_type === 'timestamp without time zone') {
    await client.query(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TIMESTAMPTZ
       USING ${column} AT TIME ZONE 'UTC'`
    );
  }
}

export async function migrateCredentialQueueContracts(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_credentials (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        public_key TEXT NOT NULL,
        credential_version VARCHAR(128) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(event_id, user_id, device_id)
      )
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_device_credentials_event_user ON device_credentials(event_id, user_id)'
    );

    await addColumn(client, 'scan_logs', 'received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    await addColumn(client, 'incidents', 'client_record_id VARCHAR(100)');
    await addColumn(client, 'incidents', 'occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    await addColumn(client, 'incidents', 'received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    await addColumn(client, 'emergency_overrides', 'client_record_id VARCHAR(100)');
    await addColumn(client, 'emergency_overrides', 'occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    await addColumn(client, 'emergency_overrides', 'received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    for (const [table, column] of [
      ['scan_logs', 'received_at'],
      ['incidents', 'occurred_at'],
      ['incidents', 'received_at'],
      ['emergency_overrides', 'occurred_at'],
      ['emergency_overrides', 'received_at'],
    ]) {
      await ensureTimestamptz(client, table, column);
    }
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS incidents_client_record_id_key ON incidents(client_record_id) WHERE client_record_id IS NOT NULL'
    );
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS overrides_client_record_id_key ON emergency_overrides(client_record_id) WHERE client_record_id IS NOT NULL'
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await migrateCredentialQueueContracts(client);
    console.log('Credential and queue contract migration completed');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Credential and queue contract migration failed:', error);
    process.exit(1);
  });
}
