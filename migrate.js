const { Pool } = require('pg');

const p = new Pool({
  connectionString: 'postgresql://baby_monitor_db_user:6mEqoP3DHdned9rPdPdoTiVfO9rTsvAZ@dpg-d7h22hnavr4c73akboh0-a.virginia-postgres.render.com/baby_monitor_db',
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      firebase_uid VARCHAR(128) UNIQUE NOT NULL,
      email        VARCHAR(255) UNIQUE NOT NULL,
      display_name VARCHAR(255),
      photo_url    TEXT,
      role         VARCHAR(32) NOT NULL DEFAULT 'parent',
      last_logout  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'parent';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_logout TIMESTAMPTZ;
  `);
  console.log('✅ users table ready');

  await p.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id          SERIAL PRIMARY KEY,
      room_id     VARCHAR(128) NOT NULL,
      uid         VARCHAR(128) NOT NULL,
      type        VARCHAR(32)  NOT NULL DEFAULT 'cry',
      intensity   VARCHAR(32)  NOT NULL,
      sound_level FLOAT,
      resolved    BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS alerts_room_id_idx ON alerts (room_id);
    CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON alerts (created_at DESC);
  `);
  console.log('✅ alerts table ready');
}

migrate()
  .then(() => console.log('✅ All migrations done'))
  .catch(err => console.error('❌ Migration failed:', err.message))
  .finally(() => p.end());
