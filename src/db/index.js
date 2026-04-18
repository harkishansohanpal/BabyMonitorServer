const { Pool } = require('pg');
const logger   = require('../utils/logger');

let pool;

function initDb() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.on('error', err => logger.error('PostgreSQL pool error', err));
  logger.info('PostgreSQL pool created');
  return pool;
}

function getDb() {
  if (!pool) throw new Error('Database not initialised — call initDb() first');
  return pool;
}

module.exports = { initDb, getDb };
