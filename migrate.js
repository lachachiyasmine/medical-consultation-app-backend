// Load environment variables
require('dotenv').config();

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Create a PostgreSQL connection pool using DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Neon & most cloud Postgres providers
  },
});

async function runMigration() {
  try {
    console.log('🔄 Starting database migration...');

    // Test the connection
    const client = await pool.connect();
    console.log('✅ Database connection established');
    client.release();

    // Path to the SQL schema file
    const schemaPath = path.join(__dirname, 'database-schema.sql');

    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema file not found: ${schemaPath}`);
    }

    console.log('📄 Reading schema file...');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Execute schema
    console.log('⚙️ Executing database schema...');
    await pool.query(schema);

    console.log('✅ Database migration completed successfully!');
    console.log('📊 Created tables:');
    console.log(' - users');
    console.log(' - specialties');
    console.log(' - doctors');
    console.log(' - doctor_education');
    console.log(' - doctor_certifications');
    console.log(' - doctor_availability');
    console.log(' - doctor_time_slots');
    console.log(' - appointments');
    console.log(' - reviews');
    console.log(' - notifications');
    console.log(' - medical_records');
    console.log(' - payments');

    // Verify tables were created
    const tableCheck = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log(`📋 Total tables created: ${tableCheck.rows.length}`);

    await pool.end();
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:');
    console.error('Error:', error.message);
    if (error.code) {
      console.error('Error Code:', error.code);

      if (error.code === 'ECONNREFUSED') {
        console.error('💡 Make sure your cloud database URL is correct and accessible.');
      } else if (error.code === '3D000') {
        console.error('💡 Database does not exist. Check your Neon dashboard or create it.');
      } else if (error.code === '28P01') {
        console.error('💡 Authentication failed. Please check your Neon credentials.');
      }
    }
    await pool.end();
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.log('\n🛑 Migration interrupted');
  await pool.end();
  process.exit(1);
});
process.on('SIGTERM', async () => {
  console.log('\n🛑 Migration terminated');
  await pool.end();
  process.exit(1);
});

// Run the migration
runMigration();
