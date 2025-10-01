// server.js
//
// Simple admin panel API for app_config etc.
// Runs on Cloud Run, connects to Postgres via Cloud SQL socket or host.
//
// Requires environment variables:
//   DB_USER, DB_PASS, DB_HOST, DB_PORT, ALLOWED_DBS

const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Read env vars
const dbUser = process.env.DB_USER || 'postgres';
const dbPass = process.env.DB_PASS;
const dbHost = process.env.DB_HOST || '127.0.0.1'; // socket path or IP
const dbPort = process.env.DB_PORT || 5432;
const allowedDbs = (process.env.ALLOWED_DBS || '').split(',').map(s => s.trim());

// Default to the first allowed DB if no header is passed
function getDbName(req) {
  const dbName = req.header('X-DB-Name') || allowedDbs[0];
  if (!allowedDbs.includes(dbName)) {
    throw new Error(`DB ${dbName} not allowed`);
  }
  return dbName;
}

// Connection pool factory per DB
const pools = new Map();
function getPool(dbName) {
  if (!pools.has(dbName)) {
    pools.set(
      dbName,
      new Pool({
        user: dbUser,
        password: dbPass,
        host: dbHost,
        port: dbPort,
        database: dbName,
      })
    );
  }
  return pools.get(dbName);
}

// --- Routes ---

// Fetch all config rows
app.get('/api/app-config', async (req, res) => {
  try {
    const dbName = getDbName(req);
    const pool = getPool(dbName);
    const { rows } = await pool.query(
      'SELECT config_key, config_value, description, updated_at FROM app_config ORDER BY config_key'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Upsert a config key/value
app.post('/api/app-config', async (req, res) => {
  try {
    const dbName = getDbName(req);
    const pool = getPool(dbName);

    const { config_key, config_value, description } = req.body;
    if (!config_key) {
      return res.status(400).json({ error: 'config_key required' });
    }

    const query = `
      INSERT INTO app_config (config_key, config_value, description, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (config_key)
      DO UPDATE SET config_value = EXCLUDED.config_value,
                    description = EXCLUDED.description,
                    updated_at = now()
      RETURNING *;
    `;

    const { rows } = await pool.query(query, [
      config_key,
      config_value || null,
      description || null,
    ]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Admin panel API is running');
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Admin panel listening on port ${PORT}`);
});
