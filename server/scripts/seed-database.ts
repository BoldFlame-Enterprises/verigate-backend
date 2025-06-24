import { Pool } from 'pg';
import argon2 from 'argon2';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'accreditation_system',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const seedData = async () => {
  const client = await pool.connect();
  
  try {
    console.log('🌱 Starting database seeding...');

    // Clear existing data
    await client.query('DELETE FROM access_assignments');
    await client.query('DELETE FROM scan_logs');
    await client.query('DELETE FROM users WHERE email LIKE \'%@test.com\'');
    await client.query('DELETE FROM access_levels');
    await client.query('DELETE FROM areas');

    // Seed Access Levels
    console.log('📝 Seeding access levels...');
    const accessLevels = [
      { name: 'General', description: 'General access to public areas', priority: 1 },
      { name: 'VIP', description: 'VIP access to premium areas', priority: 5 },
      { name: 'Staff', description: 'Staff access to work areas', priority: 3 },
      { name: 'Security', description: 'Security personnel access', priority: 4 },
      { name: 'Management', description: 'Management level access', priority: 6 }
    ];

    for (const level of accessLevels) {
      await client.query(
        'INSERT INTO access_levels (name, description, priority) VALUES ($1, $2, $3)',
        [level.name, level.description, level.priority]
      );
    }

    // Seed Areas
    console.log('🏟️ Seeding areas...');
    const areas = [
      { name: 'Main Arena', description: 'Main sports arena', requires_scan: true },
      { name: 'VIP Lounge', description: 'Exclusive VIP area', requires_scan: true },
      { name: 'Staff Area', description: 'Staff only area', requires_scan: true },
      { name: 'Security Zone', description: 'Security control room', requires_scan: true },
      { name: 'General Entrance', description: 'Main entrance', requires_scan: true },
      { name: 'Parking', description: 'Parking area', requires_scan: false },
      { name: 'Food Court', description: 'Food and beverages', requires_scan: false }
    ];

    for (const area of areas) {
      await client.query(
        'INSERT INTO areas (name, description, requires_scan) VALUES ($1, $2, $3)',
        [area.name, area.description, area.requires_scan]
      );
    }

    // Seed Test Users
    console.log('👥 Seeding test users...');
    const testUsers = [
      {
        email: 'admin@test.com',
        name: 'Admin User',
        phone: '+1234567890',
        password: 'password123',
        role: 'admin'
      },
      {
        email: 'scanner@test.com',
        name: 'Scanner Volunteer',
        phone: '+1234567891',
        password: 'password123',
        role: 'scanner'
      },
      {
        email: 'vip@test.com',
        name: 'VIP Guest',
        phone: '+1234567892',
        password: 'password123',
        role: 'user'
      },
      {
        email: 'staff@test.com',
        name: 'Staff Member',
        phone: '+1234567893',
        password: 'password123',
        role: 'user'
      },
      {
        email: 'general@test.com',
        name: 'General User',
        phone: '+1234567894',
        password: 'password123',
        role: 'user'
      }
    ];

    for (const user of testUsers) {
      const hashedPassword = await argon2.hash(user.password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16,
        timeCost: 3,
        parallelism: 1,
      });

      await client.query(
        `INSERT INTO users (email, name, phone, password_hash, role, is_active, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())`,
        [user.email, user.name, user.phone, hashedPassword, user.role]
      );
    }

    // Seed Access Assignments
    console.log('🔐 Seeding access assignments...');
    const assignments = [
      // VIP User - VIP access to VIP areas
      { userEmail: 'vip@test.com', accessLevel: 'VIP', areas: ['Main Arena', 'VIP Lounge', 'General Entrance', 'Food Court'] },
      // Staff - Staff access to work areas
      { userEmail: 'staff@test.com', accessLevel: 'Staff', areas: ['Main Arena', 'Staff Area', 'General Entrance', 'Food Court'] },
      // General User - General access only
      { userEmail: 'general@test.com', accessLevel: 'General', areas: ['Main Arena', 'General Entrance', 'Food Court'] },
      // Scanner - Staff access for work
      { userEmail: 'scanner@test.com', accessLevel: 'Staff', areas: ['Main Arena', 'Staff Area', 'General Entrance', 'Food Court'] }
    ];

    for (const assignment of assignments) {
      // Get user ID
      const userResult = await client.query('SELECT id FROM users WHERE email = $1', [assignment.userEmail]);
      const userId = userResult.rows[0]?.id;

      // Get access level ID
      const levelResult = await client.query('SELECT id FROM access_levels WHERE name = $1', [assignment.accessLevel]);
      const levelId = levelResult.rows[0]?.id;

      if (userId && levelId) {
        for (const areaName of assignment.areas) {
          // Get area ID
          const areaResult = await client.query('SELECT id FROM areas WHERE name = $1', [areaName]);
          const areaId = areaResult.rows[0]?.id;

          if (areaId) {
            await client.query(
              `INSERT INTO access_assignments (user_id, access_level_id, area_id, valid_from, valid_until, is_active) 
               VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 year', true)`,
              [userId, levelId, areaId]
            );
          }
        }
      }
    }

    console.log('✅ Database seeding completed successfully!');
    console.log('\n📋 Test Users Created:');
    console.log('👤 admin@test.com / password123 (Admin)');
    console.log('👤 scanner@test.com / password123 (Scanner)');
    console.log('👤 vip@test.com / password123 (VIP User)');
    console.log('👤 staff@test.com / password123 (Staff User)');
    console.log('👤 general@test.com / password123 (General User)');
    console.log('\n🏟️ Areas Created:');
    console.log('• Main Arena, VIP Lounge, Staff Area, Security Zone');
    console.log('• General Entrance, Parking, Food Court');
    console.log('\n🔐 Access Levels:');
    console.log('• General, VIP, Staff, Security, Management');

  } catch (error) {
    console.error('❌ Error seeding database:', error);
    throw error;
  } finally {
    client.release();
  }
};

const main = async () => {
  try {
    await seedData();
  } catch (error) {
    console.error('💥 Database seeding failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  main();
}

export { seedData };
