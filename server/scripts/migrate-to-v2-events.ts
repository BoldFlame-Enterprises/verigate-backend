import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Phase 2 migration: introduces multi-event tenancy on top of a pre-existing
 * (pre-events) database. Safe to run multiple times (every step is
 * idempotent). All existing access_levels/areas/access_assignments/scan_logs
 * rows are preserved and attached to an auto-created "Default Event".
 *
 * Run with: npm run migrate:events
 */

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'accreditation_system',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function columnExists(client: any, table: string, column: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return result.rows.length > 0;
}

async function constraintExists(client: any, constraintName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [constraintName]
  );
  return result.rows.length > 0;
}

const migrate = async () => {
  const client = await pool.connect();

  try {
    console.log('🚚 Starting Phase 2 (events) migration...');
    await client.query('BEGIN');

    // 1. Create events / event_members / device_tokens tables if missing.
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        starts_at TIMESTAMP,
        ends_at TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS event_members (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role_in_event VARCHAR(50) DEFAULT 'attendee',
        is_active BOOLEAN DEFAULT true,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(event_id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios')),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(token)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS device_sync_status (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        app VARCHAR(20) NOT NULL CHECK (app IN ('pass', 'scan')),
        platform VARCHAR(20),
        last_sync_at TIMESTAMP,
        last_scan_upload_at TIMESTAMP,
        local_db_version BIGINT,
        is_online BOOLEAN DEFAULT true,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        reporter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        area_id INTEGER REFERENCES areas(id) ON DELETE SET NULL,
        category VARCHAR(50) NOT NULL DEFAULT 'other',
        description TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS emergency_overrides (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        area_id INTEGER REFERENCES areas(id) ON DELETE CASCADE,
        scanner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        access_granted BOOLEAN NOT NULL DEFAULT true,
        reason TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        reviewed_at TIMESTAMP,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // 2. Ensure a default event exists to receive pre-existing data.
    const defaultEvent = await client.query(`
      INSERT INTO events (name, slug, description, is_active)
      VALUES ('Default Event', 'default-event', 'Auto-created to hold data that existed before multi-event support', true)
      ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING id;
    `);
    const defaultEventId = defaultEvent.rows[0].id;
    console.log(`   Default event id = ${defaultEventId}`);

    // 3. Add event_id column to each domain table (nullable first), backfill,
    //    then enforce NOT NULL. Idempotent via columnExists checks.
    for (const table of ['access_levels', 'areas', 'access_assignments', 'scan_logs']) {
      const hasColumn = await columnExists(client, table, 'event_id');
      if (!hasColumn) {
        console.log(`   Adding event_id to ${table}...`);
        await client.query(`ALTER TABLE ${table} ADD COLUMN event_id INTEGER REFERENCES events(id) ON DELETE CASCADE`);
      }
      await client.query(`UPDATE ${table} SET event_id = $1 WHERE event_id IS NULL`, [defaultEventId]);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN event_id SET NOT NULL`);
    }

    // 4. Replace old global-uniqueness constraints with per-event ones.
    if (await constraintExists(client, 'access_levels_name_key')) {
      await client.query(`ALTER TABLE access_levels DROP CONSTRAINT access_levels_name_key`);
    }
    if (!(await constraintExists(client, 'access_levels_event_id_name_key'))) {
      await client.query(`ALTER TABLE access_levels ADD CONSTRAINT access_levels_event_id_name_key UNIQUE (event_id, name)`);
    }

    if (await constraintExists(client, 'areas_name_key')) {
      await client.query(`ALTER TABLE areas DROP CONSTRAINT areas_name_key`);
    }
    if (!(await constraintExists(client, 'areas_event_id_name_key'))) {
      await client.query(`ALTER TABLE areas ADD CONSTRAINT areas_event_id_name_key UNIQUE (event_id, name)`);
    }

    if (await constraintExists(client, 'access_assignments_user_id_area_id_key')) {
      await client.query(`ALTER TABLE access_assignments DROP CONSTRAINT access_assignments_user_id_area_id_key`);
    }
    if (!(await constraintExists(client, 'access_assignments_user_id_area_id_event_id_key'))) {
      await client.query(`ALTER TABLE access_assignments ADD CONSTRAINT access_assignments_user_id_area_id_event_id_key UNIQUE (user_id, area_id, event_id)`);
    }

    // 4b. Add device_scan_id for upload de-duplication (fixes the pre-existing
    //     bug where sync.ts referenced a non-existent unique constraint).
    if (!(await columnExists(client, 'scan_logs', 'device_scan_id'))) {
      await client.query(`ALTER TABLE scan_logs ADD COLUMN device_scan_id VARCHAR(100)`);
      await client.query(`ALTER TABLE scan_logs ADD CONSTRAINT scan_logs_device_scan_id_key UNIQUE (device_scan_id)`);
    }

    // 5. Back-fill event_members so every user with an assignment in the
    //    default event is recorded as a member of it.
    await client.query(`
      INSERT INTO event_members (event_id, user_id, role_in_event, is_active)
      SELECT DISTINCT $1, u.id, 'attendee', true
      FROM users u
      ON CONFLICT (event_id, user_id) DO NOTHING
    `, [defaultEventId]);

    // 6. Indexes.
    await client.query('CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_event_members_user_id ON event_members(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_levels_event_id ON access_levels(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_areas_event_id ON areas(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_assignments_event_id ON access_assignments(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_scan_logs_event_id ON scan_logs(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_tokens_event_id ON device_tokens(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_sync_status_event_id ON device_sync_status(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_incidents_event_id ON incidents(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_emergency_overrides_event_id ON emergency_overrides(event_id);');

    await client.query('COMMIT');
    console.log('✅ Phase 2 migration completed successfully. All pre-existing data now belongs to "Default Event".');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed, rolled back:', error);
    throw error;
  } finally {
    client.release();
  }
};

const main = async () => {
  try {
    await migrate();
  } catch (error) {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  main();
}

export { migrate };
