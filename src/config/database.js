require('dotenv').config();
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

// Validação de variáveis de ambiente
if (!process.env.DATABASE_URL) {
  console.error('ERRO CRÍTICO: DATABASE_URL não definida nas variáveis de ambiente!');
  process.exit(1);
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERRO CRÍTICO: SUPABASE_SERVICE_ROLE_KEY não definida no arquivo .env!');
  console.error('Obtenha essa chave em: Project Settings > API > service_role (secret)');
  process.exit(1);
}

// PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Extrair URL do Supabase do DATABASE_URL se não estiver definida
let supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl && process.env.DATABASE_URL) {
  const match = process.env.DATABASE_URL.match(/postgres\.([^@:]+)/);
  if (match && match[1]) {
    supabaseUrl = `https://${match[1]}.supabase.co`;
  }
}

if (!supabaseUrl) {
  console.error('ERRO: SUPABASE_URL não definida e não pôde ser extraída do DATABASE_URL');
}

// Supabase Client
const supabase = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Database Initialization
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS configs (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        moderator TEXT,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        data JSONB NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        hidden_for TEXT[] DEFAULT '{}',
        deletion_requested_by TEXT[] DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_id TEXT NOT NULL,
        reported_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        image_url TEXT,
        status TEXT DEFAULT 'pending',
        deleted_at TIMESTAMPTZ,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS dashboard_access (
        user_id TEXT PRIMARY KEY,
        is_admin BOOLEAN DEFAULT FALSE,
        granted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sweepstakes (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        start_time TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMPTZ NOT NULL,
        result_time TIMESTAMPTZ,
        max_participants INTEGER,
        winners_count INTEGER DEFAULT 1,
        status TEXT DEFAULT 'active',
        winners JSONB DEFAULT '[]',
        config JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS sweepstakes_participants (
        id SERIAL PRIMARY KEY,
        sweepstake_id INTEGER REFERENCES sweepstakes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        registered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(sweepstake_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS bug_reports (
        id SERIAL PRIMARY KEY,
        reporter_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        allow_contact BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'pending',
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      -- Migration for existing tables
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='status') THEN
          ALTER TABLE reports ADD COLUMN status TEXT DEFAULT 'pending';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='deleted_at') THEN
          ALTER TABLE reports ADD COLUMN deleted_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='logs' AND column_name='type') THEN
          ALTER TABLE logs ADD COLUMN type TEXT DEFAULT 'Administrativa';
        ELSE
          UPDATE logs SET type = 'Administrativa' WHERE type = 'Admin' OR type = 'Administrador';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='storage_path') THEN
          ALTER TABLE reports ADD COLUMN storage_path TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='rejected_at') THEN
          ALTER TABLE reports ADD COLUMN rejected_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='logs' AND column_name='duration') THEN
          ALTER TABLE logs ADD COLUMN duration TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='created_by') THEN
          ALTER TABLE templates ADD COLUMN created_by TEXT;
          UPDATE templates SET created_by = 'legacy' WHERE created_by IS NULL;
          ALTER TABLE templates ALTER COLUMN created_by SET NOT NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='created_by_username') THEN
          ALTER TABLE templates ADD COLUMN created_by_username TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='created_at') THEN
          ALTER TABLE templates ADD COLUMN created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
          UPDATE templates SET created_at = NOW() WHERE created_at IS NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='updated_at') THEN
          ALTER TABLE templates ADD COLUMN updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
          UPDATE templates SET updated_at = NOW() WHERE updated_at IS NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='templates' AND column_name='deleted_at') THEN
          ALTER TABLE templates ADD COLUMN deleted_at TIMESTAMPTZ;
        END IF;
      END $$;
    `);

    // Ensure storage bucket exists
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find(b => b.name === 'reports')) {
      await supabase.storage.createBucket('reports', { public: true });
    }

  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  supabase,
  initDb
};