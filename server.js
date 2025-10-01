// server.js
// Plain Node.js + Express admin panel backend
// - Serves static files
// - Tenant-aware DB access via X-DB-Name
// - App Config endpoints (GET/PUT)
// - Sitemap Sources endpoint
// - Ready for Cloud Run + Cloud SQL (Postgres)

const path = require('path');
const express = require('express');
const { Pool } = require('pg');

// ------------ Env & constants ------------
const PORT = process.env.PORT || 8080;

// ALLOWED_DBS is a comma-separated allowlist of database names.
// Example: ALLOWED_DBS="tenant1,tenant2"
const ALLOWED_DBS = (process.env.ALLOWED_DBS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Cloud SQL connection:
// - Local dev: use Cloud SQL Auth Proxy on localhost:5432
// - Cloud Run: use Unix socket path /cloudsql/PROJECT:REGION:INSTANCE
const INSTANCE_CONNECTION_NAME = process.env.INSTANCE_CONNECTION_NAME || ''; // "project:region:instance"
const DB_USER = process.env.DB_USER || '';
const DB_PASS = process.env.DB_PASS || '';
const DB_HOST_LOCAL = process.env.DB_HOST || '127.0.0.1';
const DB_PORT_LOCAL = Number(process.env.DB_PORT || 5432);

// ------------ Small helpers ------------
function requireDbName(req) {
  const db = req.header('X-DB-Name') || '';
  if (!db) throw new Error('X-DB-Name header required');
  if (ALLOWED_DBS.length && !ALLOWED_DBS.includes(db)) {
    throw new Error(`dbname '${db}' is not allowed (update ALLOWED_DBS)`);
  }
  return db;
}

// Cache one Pool per dbname (avoid reconnect churn)
const pools = new Map();
function poolFor(dbname) {
  if (pools.has(dbname)) return pools.get(dbname);

  // Choose host based on environment
  const isCloudRun = Boolean(INSTANCE_CONNECTION_NAME);
  const host = isCloudRun
    ? `/cloudsql/${INSTANCE_CONNECTION_NAME}` // Unix socket dir
    : DB_HOST_LOCAL;

  const cfg = {
    host,
    port: isCloudRun ? undefined : DB_PORT_LOCAL, // port not used for Unix socket
    user: DB_USER,
    password: DB_PASS,
    database: dbname,
    max: 5,
    idleTimeoutMillis: 10_000,
    // SSL not required when using the proxy or Unix socket
  };

  const pool = new Pool(cfg);
  pools.set(dbname, pool);
  return pool;
}

async function withClient(dbname, fn) {
  const pool = poolFor(dbname);
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ------------ App setup ------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health & version
app.get('/api/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/api/version', (_req, res) => res.json({ version: '0.0.1' }));

// Demo endpoint (sanity check)
app.get('/api/hello', (req, res) => {
  res.json({
    message: 'API works',
    dbnameHeader: req.header('X-DB-Name') || null,
  });
});

// ------------ App Config endpoints ------------
// Table assumed:
//   CREATE TABLE IF NOT EXISTS app_config(
//     id INT PRIMARY KEY DEFAULT 1,
//     language_exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
//     defaults            JSONB NOT NULL DEFAULT '{}'::jsonb,
//     updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
//   );

app.get('/api/app-config', async (req, res) => {
  try {
    const dbname = requireDbName(req);
    const row = await withClient(dbname, async (client) => {
      const { rows } = await client.query(
        `SELECT id, language_exclusions, defaults, updated_at
           FROM app_config
           WHERE id = 1`
      );
      return rows[0] || null;
    });
    res.json(row || {});
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.put('/api/app-config', async (req, res) => {
  try {
    const dbname = requireDbName(req);
    const patch = req.body || {};
    const lang = patch.language_exclusions ?? null; // null = keep existing
    const defs = patch.defaults ?? null;

    await withClient(dbname, async (client) => {
      // idempotent upsert/merge for row id=1
      await client.query(
        `
        INSERT INTO app_config (id, language_exclusions, defaults, updated_at)
        VALUES (
          1,
          COALESCE($1::jsonb, '[]'::jsonb),
          COALESCE($2::jsonb, '{}'::jsonb),
          now()
        )
        ON CONFLICT (id) DO UPDATE
          SET language_exclusions = COALESCE(EXCLUDED.language_exclusions, app_config.language_exclusions),
              defaults            = COALESCE(EXCLUDED.defaults,            app_config.defaults),
              updated_at          = now();
        `,
        [lang, defs]
      );
    });

    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ------------ Sitemap Sources endpoints ------------
// NOTE: uses your existing columns: id, index_url, include_pattern, is_active, description
app.get('/api/sources', async (req, res) => {
  try {
    const dbname = requireDbName(req);
    const rows = await withClient(dbname, async (client) => {
      const { rows } = await client.query(
        `SELECT id, index_url, include_pattern, is_active, description
           FROM sitemap_sources
          ORDER BY id ASC`
      );
      return rows;
    });
    res.json(rows || []);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ------------ SPA fallback (Express 5-safe) ------------
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------ Start server & graceful shutdown ------------
const server = app.listen(PORT, () => {
  console.log(`Admin panel listening on :${PORT}`);
});

function shutdown(sig) {
  console.log(`\n${sig} received, closing server…`);
  server.close(async () => {
    // Close all pools
    await Promise.all(
      [...pools.values()].map((p) => p.end().catch(() => {}))
    );
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));