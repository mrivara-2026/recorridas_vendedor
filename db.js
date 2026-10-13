'use strict';
// Base de datos: PostgreSQL (Supabase) si existe DATABASE_URL; si no, SQLite en un archivo local.
// Todas las consultas usan la misma sintaxis: parámetros con ? o @nombre.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PG = !!process.env.DATABASE_URL;

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY, empresa TEXT NOT NULL, nombre TEXT NOT NULL, direccion TEXT NOT NULL DEFAULT '', zona TEXT NOT NULL DEFAULT '', horario TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', codigo TEXT NOT NULL DEFAULT '', geo_fuente TEXT NOT NULL DEFAULT 'link', lat REAL, lng REAL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), zona TEXT NOT NULL, n_requested INTEGER NOT NULL, started_at TEXT NOT NULL, start_lat REAL, start_lng REAL, start_acc REAL, ended_at TEXT, end_lat REAL, end_lng REAL, end_acc REAL, end_mode TEXT);
CREATE TABLE IF NOT EXISTS plan_items (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE, client_id INTEGER NOT NULL REFERENCES clients(id), position INTEGER NOT NULL, carried INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS ventas (codigo TEXT PRIMARY KEY, cadena TEXT NOT NULL, nombre TEXT NOT NULL DEFAULT '', ultima_venta TEXT, facturas INTEGER NOT NULL DEFAULT 0, actualizado TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS geocache (q TEXT PRIMARY KEY, lat REAL, lng REAL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, plan_item_id INTEGER NOT NULL UNIQUE REFERENCES plan_items(id) ON DELETE CASCADE, plan_id INTEGER NOT NULL REFERENCES plans(id), client_id INTEGER NOT NULL REFERENCES clients(id), user_id INTEGER NOT NULL REFERENCES users(id), result TEXT NOT NULL, arrived_at TEXT NOT NULL, lat REAL, lng REAL, acc REAL, saved_at TEXT, comment TEXT NOT NULL DEFAULT '', photo_file TEXT, photo_at TEXT, photo_lat REAL, photo_lng REAL, photo_acc REAL);`;

const SCHEMA_PG = SCHEMA_SQLITE
  .replace(/id INTEGER PRIMARY KEY/g, 'id SERIAL PRIMARY KEY')
  .replace(/ REAL/g, ' DOUBLE PRECISION');

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_clients_zona ON clients(zona);
CREATE INDEX IF NOT EXISTS idx_items_client ON plan_items(client_id);
CREATE INDEX IF NOT EXISTS idx_items_plan ON plan_items(plan_id);
CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id, arrived_at);
CREATE INDEX IF NOT EXISTS idx_visits_plan ON visits(plan_id);
CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, started_at);`;

// Convierte ? y @nombre a $1, $2… para PostgreSQL
function toPg(sql, params) {
  const values = [];
  if (Array.isArray(params)) {
    let i = 0;
    return { text: sql.replace(/\?/g, () => { values.push(params[i++]); return '$' + values.length; }), values };
  }
  const map = {};
  const text = sql.replace(/@([a-zA-Z_]\w*)/g, (_, k) => {
    if (!(k in map)) { values.push(params[k]); map[k] = values.length; }
    return '$' + map[k];
  });
  return { text, values };
}

function norm(params) { return params === undefined ? [] : params; }

let api;

if (PG) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint → número
  const url = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL || 5),
    ssl: /localhost|127\.0\.0\.1/.test(url) && !/sslmode=require/.test(url) ? false : { rejectUnauthorized: false }
  });
  const mk = (client) => ({
    async all(sql, p) { const q = toPg(sql, norm(p)); return (await client.query(q.text, q.values)).rows; },
    async get(sql, p) { const q = toPg(sql, norm(p)); return (await client.query(q.text, q.values)).rows[0]; },
    async run(sql, p) {
      let s = sql;
      if (/^\s*INSERT\s+INTO\s+(users|clients|plans|plan_items|visits)\b/i.test(s) && !/RETURNING/i.test(s)) s += ' RETURNING id';
      const q = toPg(s, norm(p));
      const r = await client.query(q.text, q.values);
      return { changes: r.rowCount, id: r.rows[0]?.id };
    }
  });
  api = {
    kind: 'postgres',
    ...mk(pool),
    async tx(fn) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(mk(c)); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    async init() {
      await pool.query(SCHEMA_PG);
      await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS codigo TEXT NOT NULL DEFAULT ''");
      await pool.query("ALTER TABLE clients ADD COLUMN IF NOT EXISTS geo_fuente TEXT NOT NULL DEFAULT 'link'");
      await pool.query(INDEXES);
    }
  };
} else {
  const Database = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, 'recorridas.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const conv = (p) => (Array.isArray(p) ? p : [p]);
  const one = {
    async all(sql, p) { return db.prepare(sql).all(...conv(norm(p))); },
    async get(sql, p) { return db.prepare(sql).get(...conv(norm(p))); },
    async run(sql, p) { const r = db.prepare(sql).run(...conv(norm(p))); return { changes: r.changes, id: Number(r.lastInsertRowid) }; }
  };
  let chain = Promise.resolve();
  api = {
    kind: 'sqlite',
    ...one,
    // Transacciones en serie: SQLite es un solo archivo y las consultas son síncronas
    tx(fn) {
      const run = chain.then(async () => {
        db.exec('BEGIN');
        try { const r = await fn(one); db.exec('COMMIT'); return r; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      });
      chain = run.catch(() => {});
      return run;
    },
    async init() {
      db.exec(SCHEMA_SQLITE);
      const cols = db.prepare('PRAGMA table_info(clients)').all().map((c) => c.name);
      if (!cols.includes('codigo')) db.exec("ALTER TABLE clients ADD COLUMN codigo TEXT NOT NULL DEFAULT ''");
      if (!cols.includes('geo_fuente')) db.exec("ALTER TABLE clients ADD COLUMN geo_fuente TEXT NOT NULL DEFAULT 'link'");
      db.exec(INDEXES);
    }
  };
}

async function ensureUser(username, password, role) {
  const exists = await api.get('SELECT id FROM users WHERE lower(username) = lower(?)', [username]);
  if (exists) return;
  await api.run('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?,?,?,?)',
    [username, bcrypt.hashSync(password, 10), role, new Date().toISOString()]);
}

// Crea las tablas y, en el primer arranque, los usuarios iniciales con las contraseñas de
// las variables ADMIN_PASS y VENDOR_PASS (no hay contraseñas escritas en el código).
async function init() {
  await api.init();
  const { n } = await api.get('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM users');
  if (n > 0) return;
  if (!process.env.ADMIN_PASS || !process.env.VENDOR_PASS) {
    throw new Error('Primer arranque: faltan las variables ADMIN_PASS y VENDOR_PASS para crear los usuarios iniciales.');
  }
  await ensureUser(process.env.ADMIN_USER || 'plateroadmin', process.env.ADMIN_PASS, 'admin');
  await ensureUser(process.env.VENDOR_USER || 'msayago', process.env.VENDOR_PASS, 'vendedor');
}

module.exports = { db: api, DATA_DIR, init, ensureUser, toPg };
