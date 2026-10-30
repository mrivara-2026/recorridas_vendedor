'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const seed = require('./seed');

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

-- ===== Versión 2: semana armada por el administrador, tipos de comercio, ventas y alertas =====
CREATE TABLE IF NOT EXISTS barrios (
  nombre TEXT PRIMARY KEY COLLATE NOCASE,
  ciudad TEXT NOT NULL DEFAULT 'Montevideo',
  linderos TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS opciones (
  id INTEGER PRIMARY KEY,
  lista TEXT NOT NULL,
  valor TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS semana_items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  semana TEXT NOT NULL,
  fecha TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  motivo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, semana, client_id)
);
CREATE TABLE IF NOT EXISTS semanas (
  user_id INTEGER NOT NULL REFERENCES users(id),
  semana TEXT NOT NULL,
  publicada_at TEXT,
  PRIMARY KEY (user_id, semana)
);
CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  documento TEXT NOT NULL,
  numero TEXT NOT NULL DEFAULT '',
  cliente TEXT NOT NULL,
  sucursal TEXT NOT NULL,
  packs REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS ventas_cargas (
  id INTEGER PRIMARY KEY,
  archivo TEXT NOT NULL,
  desde TEXT, hasta TEXT,
  filas INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL,
  texto TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  created_at TEXT NOT NULL,
  vista_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ventas_suc ON ventas(sucursal, fecha);
CREATE INDEX IF NOT EXISTS idx_semana ON semana_items(user_id, semana, fecha);
`);

// Columnas nuevas en tablas existentes: se agregan una sola vez y no tocan los datos cargados.
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('clients', 'tipo', "TEXT NOT NULL DEFAULT ''");            // serrana | cliente | prospecto
addColumn('clients', 'cadena', "TEXT NOT NULL DEFAULT ''");          // Grupo Disco | Tienda Inglesa | Otra
addColumn('clients', 'ciudad', "TEXT NOT NULL DEFAULT 'Montevideo'");
addColumn('clients', 'visitas_anio', 'INTEGER');
addColumn('clients', 'volver_meses', 'INTEGER');                     // prospectos; 0 = no volver
addColumn('clients', 'volver_fecha', 'TEXT');
addColumn('clients', 'codigo_ventas', "TEXT NOT NULL DEFAULT ''");
addColumn('clients', 'contacto', "TEXT NOT NULL DEFAULT ''");
addColumn('clients', 'telefono', "TEXT NOT NULL DEFAULT ''");
addColumn('clients', 'observaciones', "TEXT NOT NULL DEFAULT ''");
addColumn('clients', 'geo', "TEXT NOT NULL DEFAULT 'ok'");           // ok | pendiente | aprox | fallo
addColumn('clients', 'convertido_at', 'TEXT');
addColumn('plan_items', 'semana_item_id', 'INTEGER');
addColumn('plan_items', 'urgencia', 'INTEGER NOT NULL DEFAULT 0');
addColumn('plan_items', 'nota', "TEXT NOT NULL DEFAULT ''");
addColumn('visits', 'motivo_no', "TEXT NOT NULL DEFAULT ''");
addColumn('visits', 'estandar', "TEXT NOT NULL DEFAULT ''");
addColumn('visits', 'volver_meses', 'INTEGER');
addColumn('visits', 'convertido', 'INTEGER NOT NULL DEFAULT 0');

// Comercios cargados con la versión anterior: MAN = Serrana, BEC = Cliente BEC.
db.exec(`UPDATE clients SET tipo = CASE empresa WHEN 'MAN' THEN 'serrana' ELSE 'cliente' END WHERE tipo = ''`);
db.exec(`UPDATE clients SET visitas_anio = CASE tipo WHEN 'serrana' THEN 3 ELSE 2 END WHERE visitas_anio IS NULL AND tipo <> 'prospecto'`);
db.exec(`UPDATE clients SET geo = 'pendiente' WHERE lat IS NULL AND geo = 'ok'`);

if (!db.prepare('SELECT COUNT(*) AS n FROM barrios').get().n) {
  const ins = db.prepare('INSERT INTO barrios (nombre, ciudad, linderos) VALUES (?,?,?)');
  db.transaction(() => {
    for (const [b, l] of Object.entries(seed.BARRIOS)) ins.run(b, seed.COSTA.includes(b) ? 'Ciudad de la Costa' : 'Montevideo', l.join(', '));
  })();
}
if (!db.prepare('SELECT COUNT(*) AS n FROM opciones').get().n) {
  const ins = db.prepare('INSERT INTO opciones (lista, valor, orden) VALUES (?,?,?)');
  db.transaction(() => {
    for (const [lista, vals] of Object.entries(seed.LISTAS)) vals.forEach((v, i) => ins.run(lista, v, i));
  })();
}

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
