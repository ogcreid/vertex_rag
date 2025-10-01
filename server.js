// server.js
//
// Admin panel (vanilla JS + Express API)
// - Serves static UI from /public
// - Connects to Postgres (Cloud SQL socket or TCP)
// - Tenant is chosen via X-DB-Name header (validated against ALLOWED_DBS)
//
// Required env:
//   INSTANCE_CONNECTION_NAME  (e.g. "proj:region:instance")  [preferred on Cloud Run]
//   or DB_HOST / DB_PORT      (for TCP connections)
//   DB_USER, DB_PASS
//   ALLOWED_DBS               comma-separated (e.g. "tenant1,tenant2")
// Optional env:
//   DB_SSL=true               (enables TLS for TCP connections)
//   SOURCE_COMMIT             (shown in /api/version)

const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', true);
app.use(express.json());

// ---- Env & connection config ----
const INSTANCE_CONNECTION_NAME = process.env.INSTANCE_CONNECTION_NAME || '';
const DB_USER  = process.env.DB_USER || 'postgres';
const DB_PASS  = process.env.DB_PASS || '';
const DB_HOST  = process.env.DB_HOST || '127.0.0.1';
const DB_PORT  = Number(process.env.DB_PORT || 5432);
const DB_SSL   = String(process.env.DB_SSL || '').toLowerCase() === 'true';

// allowlist of db names (required for safety)
const ALLOWED_DBS = (process.env.ALLOWED_DBS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (ALLOWED_DBS.length === 0) {
  console.warn('[WARN] ALLOWED_DBS is empty. Set it to a comma-separated list of permitted databases.');
}

// Build pg config per db
function buildPgConfig(dbname) {
  const base = {
    user: DB_USER,
    password: DB_PASS,
    database: dbname,
  };

  if (INSTANCE_CONNECTION_NAME) {
    // Cloud SQL Unix domain socket (recommended on Cloud Run)
    return { ...base, host: `/cloudsql/${INSTANCE_CONNECTION_NAME}` };
  }

  // TCP fallback (e.g., local dev, or a proxy)
  const cfg = { ...base, host: DB_HOST, port: DB_PORT };
  if (DB_SSL) cfg.ssl = { rejectUnauthorized: false };
  return cfg;
}

// Validate/resolve db name from header (or default to the first allowlisted db)
function getDbName(req) {
  const header = req.header('X-DB-Name');
  const dbname = header || ALLOWED_DBS[0];
  if (!dbname) throw new Error('No database specified and ALLOWED_DBS is empty.');
  if (!ALLOWED_DBS.includes(dbname)) {
    throw new Error(`Database "${dbname}" is not in ALLOWED_DBS.`);
  }
  return dbname;
}

// Connection pool per db
const pools = new Map();
function getPool(dbname) {
  if (!pools.has(dbname)) {
    pools.set(dbname, new Pool(buildPgConfig(dbname)));
  }
  return pools.get(dbname);
}

// ---- Static UI ----
app.use(express.static(path.join(__dirname, 'public')));

// ---- Meta/health ----
app.get('/api/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/api/version', (_req, res) => {
  res.json({
    k_service: process.env.K_SERVICE || null,
    k_revision: process.env.K_REVISION || null,
    commit: process.env.SOURCE_COMMIT || null
  });
});

// ---- API: App Config ----

// GET all config rows
app.get('/api/app-config', async (req, res, next) => {
  try {
    const db = getDbName(req);
    const pool = getPool(db);
    const { rows } = await pool.query(
      `SELECT config_key, config_value, description, updated_at
         FROM app_config
        ORDER BY config_key;`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// UPSERT a config key/value
app.post('/api/app-config', async (req, res, next) => {
  try {
    const db = getDbName(req);
    const pool = getPool(db);

    const { config_key, config_value, description } = req.body || {};
    if (!config_key || typeof config_key !== 'string') {
      return res.status(400).json({ error: 'config_key (string) is required' });
    }

    const sql = `
      INSERT INTO app_config (config_key, config_value, description, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (config_key)
      DO UPDATE SET config_value = EXCLUDED.config_value,
                    description = EXCLUDED.description,
                    updated_at = now()
      RETURNING config_key, config_value, description, updated_at;
    `;
    const { rows } = await pool.query(sql, [
      config_key,
      config_value ?? null,
      description ?? null,
    ]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ---- SPA fallback (Express 5-safe) ----
// Return index.html for anything not matched above
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Error handler ----
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  const msg = err?.message || 'Internal Server Error';
  res.status(400).json({ error: msg });
});

// ---- Start server ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Admin panel listening on :${PORT}`);
});
