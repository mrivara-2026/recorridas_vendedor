'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'fotos'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'recorridas.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','vendedor')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  empresa TEXT NOT NULL CHECK (empresa IN ('BEC','MAN')),
  nombre TEXT NOT NULL,
  direccion TEXT NOT NULL DEFAULT '',
  zona TEXT NOT NULL DEFAULT '',
  horario TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  lat REAL, lng REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  zona TEXT NOT NULL,
  n_requested INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  start_lat REAL, start_lng REAL, start_acc REAL,
  ended_at TEXT,
  end_lat REAL, end_lng REAL, end_acc REAL,
  end_mode TEXT
);
CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  position INTEGER NOT NULL,
  carried INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','si','no','skipped'))
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  plan_item_id INTEGER NOT NULL UNIQUE REFERENCES plan_items(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('si','no')),
  arrived_at TEXT NOT NULL,
  lat REAL, lng REAL, acc REAL,
  saved_at TEXT,
  comment TEXT NOT NULL DEFAULT '',
  photo_file TEXT,
  photo_at TEXT,
  photo_lat REAL, photo_lng REAL, photo_acc REAL
);
CREATE INDEX IF NOT EXISTS idx_clients_zona ON clients(zona);
CREATE INDEX IF NOT EXISTS idx_items_client ON plan_items(client_id);
CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id, arrived_at);
CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, started_at);
`);

function ensureUser(username, password, role) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return;
  db.prepare('INSERT INTO users (username, pass_hash, role, created_at) VALUES (?,?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), role, new Date().toISOString());
}

// Usuarios iniciales: se crean en el primer arranque con las contraseñas de las variables de entorno
// ADMIN_PASS y VENDOR_PASS (no hay contraseñas escritas en el código). Después se cambian desde el sistema.
function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  if (!process.env.ADMIN_PASS || !process.env.VENDOR_PASS) {
    console.error('Primer arranque: faltan las variables ADMIN_PASS y VENDOR_PASS para crear los usuarios iniciales.');
    process.exit(1);
  }
  ensureUser(process.env.ADMIN_USER || 'plateroadmin', process.env.ADMIN_PASS, 'admin');
  ensureUser(process.env.VENDOR_USER || 'msayago', process.env.VENDOR_PASS, 'vendedor');
}
seedUsers();

module.exports = { db, DATA_DIR, ensureUser };
