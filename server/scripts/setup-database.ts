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

    // Access levels table
    await client.query(`
      CREATE TABLE IF NOT EXISTS access_levels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        priority INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true
      );
    `);

    // Areas table
    await client.query(`
      CREATE TABLE IF NOT EXISTS areas (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        requires_scan BOOLEAN DEFAULT true,
        is_active BOOLEAN DEFAULT true
      );
    `);

    // Access assignments table (many-to-many between users, access_levels, and areas)
    await client.query(`
      CREATE TABLE IF NOT EXISTS access_assignments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        access_level_id INTEGER REFERENCES access_levels(id) ON DELETE CASCADE,
        area_id INTEGER REFERENCES areas(id) ON DELETE CASCADE,
        valid_from TIMESTAMP DEFAULT NOW(),
        valid_until TIMESTAMP DEFAULT NOW() + INTERVAL '1 year',
        is_active BOOLEAN DEFAULT true,
        UNIQUE(user_id, area_id)
      );
    `);

    // Scan logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS scan_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        area_id INTEGER REFERENCES areas(id) ON DELETE CASCADE,
        scanner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        access_granted BOOLEAN NOT NULL,
        failure_reason TEXT,
        scanned_at TIMESTAMP DEFAULT NOW(),
        device_info JSONB
      );
    `);

    // Create indexes for better performance
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_assignments_user_id ON access_assignments(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_access_assignments_area_id ON access_assignments(area_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_scan_logs_user_id ON scan_logs(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_scan_logs_scanned_at ON scan_logs(scanned_at);');

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
