import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'accreditation_system',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const createTables = async () => {
  const client = await pool.connect();
  
  try {
    // Enable UUID extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        password_hash TEXT NOT NULL,
        device_id VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('admin', 'scanner', 'user')),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Events establish multi-event tenancy. Every access level, area,
    // access assignment and scan log is scoped to exactly one event.
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

    // Event membership: a user may belong to (and sync data for) multiple
    // events over time. This is separate from access_assignments, which grants
    // area-level access within an event a user already belongs to.
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_members (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        role_in_event VARCHAR(50) DEFAULT 'attendee',
        is_active BOOLEAN DEFAULT true,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(event_id, user_id)
      );
    `);

    // Access levels table (scoped per event; names unique within an event)
    await client.query(`
      CREATE TABLE IF NOT EXISTS access_levels (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        priority INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(event_id, name)
      );
    `);

    // Areas table (scoped per event; names unique within an event)
    await client.query(`
      CREATE TABLE IF NOT EXISTS areas (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        requires_scan BOOLEAN DEFAULT true,
        is_active BOOLEAN DEFAULT true,
        UNIQUE(event_id, name)
      );
    `);

    // Access assignments table (many-to-many between users, access_levels, and areas)
    await client.query(`
      CREATE TABLE IF NOT EXISTS access_assignments (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        access_level_id INTEGER REFERENCES access_levels(id) ON DELETE CASCADE,
        area_id INTEGER REFERENCES areas(id) ON DELETE CASCADE,
        valid_from TIMESTAMP DEFAULT NOW(),
        valid_until TIMESTAMP DEFAULT NOW() + INTERVAL '1 year',
        is_active BOOLEAN DEFAULT true,
        UNIQUE(user_id, area_id, event_id)
      );
    `);

    // Scan logs table. device_scan_id is a client-generated UUID used to
    // de-duplicate uploads from offline scanner devices (Postgres allows
    // multiple NULLs under a UNIQUE constraint, so older clients that don't
    // send one are unaffected).
    await client.query(`
      CREATE TABLE IF NOT EXISTS scan_logs (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        area_id INTEGER REFERENCES areas(id) ON DELETE CASCADE,
        scanner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        access_granted BOOLEAN NOT NULL,
        failure_reason TEXT,
        scanned_at TIMESTAMP DEFAULT NOW(),
        received_at TIMESTAMPTZ DEFAULT NOW(),
        device_info JSONB,
        device_scan_id VARCHAR(100) UNIQUE
      );
    `);

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
      );
    `);

    // Device push tokens support Android FCM and opt-in iOS APNs delivery.
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        token TEXT NOT NULL,
        platform VARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios')),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(token)
      );
    `);

    // Real-time sync monitoring: last-seen heartbeat per physical device.
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

    // Incident reports (suspicious activity / technical issues) filed from the scanner app.
    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        reporter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        area_id INTEGER REFERENCES areas(id) ON DELETE SET NULL,
        category VARCHAR(50) NOT NULL DEFAULT 'other',
        description TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
        client_record_id VARCHAR(100) UNIQUE,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
    `);

    // Emergency / manual overrides: a scanner granting or denying access
    // outside the normal signed-QR flow, with a mandatory reason.
    await client.query(`
      CREATE TABLE IF NOT EXISTS emergency_overrides (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        area_id INTEGER REFERENCES areas(id) ON DELETE CASCADE NOT NULL,
        scanner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        access_granted BOOLEAN NOT NULL DEFAULT true,
        reason TEXT NOT NULL,
        client_record_id VARCHAR(100) UNIQUE,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        reviewed_at TIMESTAMP,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // Create indexes for better performance
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_event_members_user_id ON event_members(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_levels_event_id ON access_levels(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_areas_event_id ON areas(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_assignments_user_id ON access_assignments(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_assignments_area_id ON access_assignments(area_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_assignments_event_id ON access_assignments(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_scan_logs_user_id ON scan_logs(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_scan_logs_event_id ON scan_logs(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_tokens_event_id ON device_tokens(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_credentials_event_user ON device_credentials(event_id, user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_device_sync_status_event_id ON device_sync_status(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_incidents_event_id ON incidents(event_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_emergency_overrides_event_id ON emergency_overrides(event_id);');

    // Seed a default event so a brand-new database always has somewhere for
    // access levels/areas to live, matching the fallback used by the migration
    // script for databases created before multi-event support.
    await client.query(`
      INSERT INTO events (name, slug, description, is_active)
      VALUES ('Default Event', 'default-event', 'Auto-created default event', true)
      ON CONFLICT (slug) DO NOTHING;
    `);

    console.log('✅ Database tables created successfully');
  } catch (error) {
    console.error('❌ Error creating database tables:', error);
    throw error;
  } finally {
    client.release();
  }
};

const main = async () => {
  try {
    await createTables();
    console.log('🎉 Database setup completed successfully');
  } catch (error) {
    console.error('💥 Database setup failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  main();
}

export { createTables };
