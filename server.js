'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

const { db, DATA_DIR } = require('./lib/db');
const geo = require('./lib/geo');
const T = require('./lib/time');
const X = require('./lib/excel');
const V = require('./lib/ventas');
const { LISTA_NOMBRES } = require('./lib/seed');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'geolocation=(self), camera=(self)');
  next();
});

const PHOTO_DIR = path.join(DATA_DIR, 'fotos');
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});
const uploadSheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------- Sesiones ----------
const COOKIE = 'rec_sesion';
const SESSION_DAYS = 30;

function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = T.nowISO();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?,?,?,?)').run(token, userId, now, now);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/' });
}

function currentUser(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.role, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen).getTime() > SESSION_DAYS * 86400000) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  if (Date.now() - new Date(row.last_seen).getTime() > 3600000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(T.nowISO(), token);
  return { id: row.id, username: row.username, role: row.role };
}

function auth(...roles) {
  return (req, res, next) => {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: 'Tenés que ingresar de nuevo.' });
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'No tenés permiso para esto.' });
    req.user = u;
    next();
  };
}

const failures = new Map();
function tooMany(key) {
  const f = failures.get(key);
  return f && f.count >= 8 && Date.now() - f.first < 15 * 60000;
}
function fail(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const key = username.toLowerCase() + '|' + req.ip;
  if (tooMany(key)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(password, u.pass_hash)) {
    fail(key);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  failures.delete(key);
  createSession(res, req, u.id);
  res.json({ username: u.username, role: u.role });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) => res.json(req.user));

app.post('/api/password', auth(), (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.pass_hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  if (String(next || '').length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 10), u.id);
  const token = req.cookies[COOKIE];
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, token || '');
  res.json({ ok: true });
});

function num(v) { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; }
// El vendedor siempre se ve a sí mismo; el administrador elige al vendedor (por defecto, el primero).
function vendedorId(req) {
  if (req.user.role !== 'admin') return req.user.id;
  return Number(req.query.usuario || req.body?.usuario) || db.prepare(`SELECT id FROM users WHERE role='vendedor' ORDER BY id LIMIT 1`).get()?.id || req.user.id;
}

// ---------- Barrios y listas ----------
function barriosMap() {
  const m = new Map();
  for (const b of db.prepare('SELECT * FROM barrios').all()) m.set(X.norm(b.nombre), { ...b, linderos: b.linderos.split(',').map((s) => s.trim()).filter(Boolean) });
  return m;
}

function listas() {
  const out = {};
  for (const k of Object.keys(LISTA_NOMBRES)) out[k] = [];
  for (const r of db.prepare('SELECT lista, valor FROM opciones ORDER BY lista, orden, id').all()) (out[r.lista] || (out[r.lista] = [])).push(r.valor);
  return out;
}

function guardarBarrios(list) {
  db.transaction(() => {
    db.prepare('DELETE FROM barrios').run();
    const ins = db.prepare('INSERT OR REPLACE INTO barrios (nombre, ciudad, linderos) VALUES (?,?,?)');
    for (const b of list) ins.run(String(b.nombre).trim(), b.ciudad === 'Ciudad de la Costa' ? 'Ciudad de la Costa' : 'Montevideo', (b.linderos || []).map((s) => String(s).trim()).filter(Boolean).join(', '));
  })();
}

function guardarListas(obj) {
  db.transaction(() => {
    for (const [k, vals] of Object.entries(obj)) {
      if (!LISTA_NOMBRES[k] || !Array.isArray(vals)) continue;
      db.prepare('DELETE FROM opciones WHERE lista = ?').run(k);
      const ins = db.prepare('INSERT INTO opciones (lista, valor, orden) VALUES (?,?,?)');
      vals.map((v) => String(v).trim()).filter(Boolean).forEach((v, i) => ins.run(k, v, i));
    }
  })();
}

app.get('/api/barrios', auth(), (req, res) => res.json(db.prepare('SELECT * FROM barrios ORDER BY ciudad DESC, nombre').all()));
app.put('/api/barrios', auth('admin'), (req, res) => {
  const list = (Array.isArray(req.body) ? req.body : []).filter((b) => b && String(b.nombre || '').trim());
  if (!list.length) return res.status(400).json({ error: 'La lista de barrios no puede quedar vacía.' });
  guardarBarrios(list.map((b) => ({ ...b, linderos: Array.isArray(b.linderos) ? b.linderos : String(b.linderos || '').split(',') })));
  res.json({ ok: true });
});
app.get('/api/listas', auth(), (req, res) => res.json({ listas: listas(), nombres: LISTA_NOMBRES }));
app.put('/api/listas', auth('admin'), (req, res) => { guardarListas(req.body || {}); res.json({ ok: true, listas: listas() }); });

// ---------- Estado de cada comercio ----------
// proxima: fecha desde la que le toca otra visita (null = le toca ya; 'nunca' = prospecto que no quiere que volvamos).
function estados(ref = T.today()) {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT MAX(v.arrived_at) FROM visits v WHERE v.client_id = c.id AND v.result = 'si') AS last_si,
      (SELECT MAX(v.arrived_at) FROM visits v WHERE v.client_id = c.id) AS last_visit_at,
      (SELECT v.result FROM visits v WHERE v.client_id = c.id ORDER BY v.arrived_at DESC LIMIT 1) AS last_result,
      (SELECT pi.status FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.client_id = c.id AND pi.status <> 'pending' ORDER BY p.started_at DESC, pi.id DESC LIMIT 1) AS last_item_status
    FROM clients c WHERE c.active = 1 ORDER BY c.zona COLLATE NOCASE, c.nombre COLLATE NOCASE`).all();
  const ventas = V.analizar(db);
  return rows.map((c) => {
    const lastSi = c.last_si ? T.localDate(c.last_si) : null;
    let proxima = null;
    if (c.tipo === 'prospecto') proxima = c.volver_meses === 0 ? 'nunca' : (c.volver_fecha || null);
    else if (lastSi) proxima = T.addDays(lastSi, Math.round(365 / Math.max(1, c.visitas_anio || 2)));
    const pendiente = c.last_item_status === 'no' || c.last_item_status === 'skipped';
    const v = c.codigo_ventas ? ventas.sucursales[c.codigo_ventas] : null;
    const caida = !!(v && v.prioridad && (!lastSi || T.daysBetween(lastSi, ref) >= 30));
    return { ...c, last_si_fecha: lastSi, proxima, pendiente, caida, caida_motivo: v?.prioridad ? v.motivo : '' };
  });
}

function publicClient(c) {
  return {
    id: c.id, tipo: c.tipo, empresa: c.empresa, cadena: c.cadena, nombre: c.nombre, direccion: c.direccion, zona: c.zona, ciudad: c.ciudad,
    horario: c.horario, link: c.link, lat: c.lat, lng: c.lng, geo: c.geo, visitas_anio: c.visitas_anio, volver_meses: c.volver_meses,
    volver_fecha: c.volver_fecha, codigo_ventas: c.codigo_ventas, contacto: c.contacto, telefono: c.telefono, observaciones: c.observaciones,
    convertido_at: c.convertido_at
  };
}

function motivoDe(c) {
  if (c.caida) return { prio: 0, texto: `Caída de ventas: ${c.caida_motivo}` };
  if (c.pendiente) return { prio: 1, texto: c.last_result === 'no' ? 'Quedó en NO la última vez' : 'Quedó sin visitar la última vez' };
  if (c.proxima == null) return { prio: 2, texto: c.tipo === 'prospecto' ? 'Prospecto sin visitar' : 'Nunca visitado' };
  if (c.tipo === 'prospecto') return { prio: 3, texto: `Volver: pidió en ${c.volver_meses} ${c.volver_meses === 1 ? 'mes' : 'meses'}` };
  return { prio: 3, texto: `Le toca: ${c.visitas_anio} por año` };
}

function leToca(c, hasta) {
  if (c.caida || c.pendiente) return true;
  if (c.proxima === 'nunca') return false;
  return c.proxima == null || c.proxima <= hasta;
}

// ---------- Comercios ----------
app.get('/api/clients', auth(), (req, res) => {
  res.json(estados().map((c) => ({ ...publicClient(c), last_visit_at: c.last_visit_at, last_result: c.last_result, proxima: c.proxima, pendiente: c.pendiente, caida: c.caida, caida_motivo: c.caida_motivo })));
});

function findDuplicate(rec, exceptId) {
  return db.prepare('SELECT * FROM clients WHERE active = 1 AND id <> ?').all(exceptId || 0).find((c) => X.sameClient(c, rec));
}

const INS_CLIENT = `INSERT INTO clients (tipo,empresa,cadena,nombre,direccion,zona,ciudad,horario,link,lat,lng,geo,visitas_anio,volver_meses,volver_fecha,codigo_ventas,contacto,telefono,observaciones,active,created_at,updated_at)
  VALUES (@tipo,@empresa,@cadena,@nombre,@direccion,@zona,@ciudad,@horario,@link,@lat,@lng,@geo,@visitas_anio,@volver_meses,@volver_fecha,@codigo_ventas,@contacto,@telefono,@observaciones,1,@now,@now)`;
const UPD_CLIENT = `UPDATE clients SET tipo=@tipo,empresa=@empresa,cadena=@cadena,nombre=@nombre,direccion=@direccion,zona=@zona,ciudad=@ciudad,horario=@horario,link=@link,lat=@lat,lng=@lng,geo=@geo,
  visitas_anio=@visitas_anio,volver_meses=@volver_meses,volver_fecha=@volver_fecha,codigo_ventas=@codigo_ventas,contacto=@contacto,telefono=@telefono,observaciones=@observaciones,active=1,updated_at=@now WHERE id=@id`;

function volverFecha(meses) { return meses ? T.addMonths(T.today(), meses) : null; }

async function crearComercio(body) {
  const { rec, problems } = await X.normalizar({ ...body, link: body.link || '' }, barriosMap());
  if (problems) { const e = new Error(problems.join(' · ')); e.status = 400; throw e; }
  const dup = findDuplicate(rec);
  if (dup) { const e = new Error(`Este comercio ya está cargado como "${dup.nombre}" (${dup.zona}).`); e.status = 409; e.id = dup.id; throw e; }
  const info = db.prepare(INS_CLIENT).run({ ...rec, volver_fecha: null, now: T.nowISO() });
  if (!db.prepare('SELECT 1 FROM barrios WHERE nombre = ?').get(rec.zona)) db.prepare('INSERT INTO barrios (nombre, ciudad, linderos) VALUES (?,?,?)').run(rec.zona, rec.ciudad, '');
  despertarGeo();
  return info.lastInsertRowid;
}

app.post('/api/clients', auth(), async (req, res) => {
  try { res.json({ id: await crearComercio(req.body || {}) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, id: e.id }); }
});

app.patch('/api/clients/:id', auth(), async (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(id);
  if (!cur) return res.status(404).json({ error: 'No existe ese comercio.' });
  const body = req.body || {};
  const input = { ...cur, tipo: X.TIPO_NOMBRE[cur.tipo], ...body };
  if (!('link' in body)) input.link = '';
  const { rec, problems } = await X.normalizar(input, barriosMap());
  if (problems) return res.status(400).json({ error: problems.join(' · ') });
  if (!('link' in body)) {
    rec.link = cur.link;
    const movio = X.norm(rec.direccion) !== X.norm(cur.direccion) || X.norm(rec.zona) !== X.norm(cur.zona) || rec.ciudad !== cur.ciudad;
    if (movio && !cur.link) { rec.lat = null; rec.lng = null; rec.geo = 'pendiente'; } else { rec.lat = cur.lat; rec.lng = cur.lng; rec.geo = cur.geo; }
  } else if (!rec.link) { rec.lat = null; rec.lng = null; rec.geo = 'pendiente'; }
  const dup = findDuplicate(rec, id);
  if (dup) return res.status(409).json({ error: `Quedaría igual a "${dup.nombre}" (${dup.zona}), que ya está cargado.` });
  const volver_fecha = rec.tipo !== 'prospecto' ? null : (rec.volver_meses !== cur.volver_meses ? volverFecha(rec.volver_meses) : cur.volver_fecha);
  db.prepare(UPD_CLIENT).run({ ...rec, volver_fecha, id, now: T.nowISO() });
  if (cur.tipo === 'prospecto' && rec.tipo === 'cliente') db.prepare('UPDATE clients SET convertido_at = ? WHERE id = ?').run(T.nowISO(), id);
  if (rec.geo === 'pendiente') despertarGeo();
  res.json({ ok: true, client: publicClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(id)) });
});

function convertir(id) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(id);
  if (!c) return null;
  if (c.tipo !== 'prospecto') return c;
  const now = T.nowISO();
  db.prepare(`UPDATE clients SET tipo='cliente', empresa='BEC', visitas_anio=COALESCE(visitas_anio, 2), volver_meses=NULL, volver_fecha=NULL, convertido_at=?, updated_at=? WHERE id=?`).run(now, now, id);
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

app.post('/api/clients/:id/convertir', auth(), (req, res) => {
  const c = convertir(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'No existe ese comercio.' });
  res.json({ ok: true, client: publicClient(c) });
});

app.delete('/api/clients/:id', auth('admin'), (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('UPDATE clients SET active = 0, updated_at = ? WHERE id = ? AND active = 1').run(T.nowISO(), id);
  if (!info.changes) return res.status(404).json({ error: 'No existe ese comercio.' });
  db.prepare(`DELETE FROM semana_items WHERE client_id = ? AND fecha >= ?`).run(id, T.today());
  res.json({ ok: true });
});

// Importación de Excel en dos pasos: vista previa y confirmación.
const pendingImports = new Map();
app.post('/api/clients/import/preview', auth(), uploadSheet.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Elegí un archivo .xlsx o .csv.' });
  let data;
  try { data = await X.readComercios(req.file.buffer, req.file.originalname); }
  catch (e) { return res.status(400).json({ error: e.message && e.message.length < 300 ? e.message : 'No se pudo leer el archivo. Usá la plantilla en formato .xlsx.' }); }
  if (!data.rows.length) return res.status(400).json({ error: 'El archivo no tiene filas con comercios.' });
  const admin = req.user.role === 'admin';
  let bm = barriosMap();
  if (data.barrios && admin) { bm = new Map(); for (const b of data.barrios) bm.set(X.norm(b.nombre), b); }
  const existing = db.prepare('SELECT * FROM clients').all();
  const result = await X.analyze(data.rows, existing, bm);
  const nuevosBarrios = [...new Set([...result.nuevas, ...result.actualizadas, ...result.posibles].map((r) => r.zona).filter((z) => !bm.has(X.norm(z))))];
  const token = crypto.randomBytes(16).toString('hex');
  pendingImports.set(token, { userId: req.user.id, at: Date.now(), result, barrios: admin ? data.barrios : null, listas: admin ? data.listas : null, nuevosBarrios });
  for (const [k, v] of pendingImports) if (Date.now() - v.at > 30 * 60000) pendingImports.delete(k);
  const brief = (r) => ({ fila: r.fila, tipo: r.tipo, nombre: r.nombre, direccion: r.direccion, zona: r.zona, cambios: r.cambios, parecido: r.parecido, reactivar: r.reactivar });
  res.json({
    token, archivo: req.file.originalname,
    nuevas: result.nuevas.map(brief), actualizadas: result.actualizadas.map(brief), sinCambios: result.sinCambios.length,
    posibles: result.posibles.map(brief), errores: result.errores, repetidasArchivo: result.repetidasArchivo,
    barrios: admin && data.barrios ? data.barrios.length : 0, listas: admin && data.listas ? Object.keys(data.listas).length : 0, nuevosBarrios
  });
});

app.post('/api/clients/import/confirm', auth(), (req, res) => {
  const { token, incluirPosibles } = req.body || {};
  const p = pendingImports.get(token);
  if (!p || p.userId !== req.user.id) return res.status(400).json({ error: 'La vista previa venció. Subí el archivo de nuevo.' });
  pendingImports.delete(token);
  const include = new Set((incluirPosibles || []).map(Number));
  const now = T.nowISO();
  const ins = db.prepare(INS_CLIENT), up = db.prepare(UPD_CLIENT);
  let agregadas = 0, actualizadas = 0;
  db.transaction(() => {
    if (p.barrios) guardarBarrios(p.barrios);
    for (const z of p.nuevosBarrios) db.prepare('INSERT OR IGNORE INTO barrios (nombre, ciudad, linderos) VALUES (?,?,?)').run(z, 'Montevideo', '');
    if (p.listas) guardarListas(p.listas);
    for (const r of p.result.nuevas) { ins.run({ ...r, volver_fecha: volverFecha(r.volver_meses), now }); agregadas++; }
    for (const r of p.result.posibles) if (include.has(r.fila)) { ins.run({ ...r, volver_fecha: volverFecha(r.volver_meses), now }); agregadas++; }
    for (const r of p.result.actualizadas) {
      const cur = db.prepare('SELECT volver_meses, volver_fecha FROM clients WHERE id = ?').get(r.id);
      up.run({ ...r, volver_fecha: r.tipo !== 'prospecto' ? null : (cur.volver_meses === r.volver_meses ? cur.volver_fecha : volverFecha(r.volver_meses)), now });
      actualizadas++;
    }
  })();
  despertarGeo();
  res.json({ agregadas, actualizadas, barrios: p.barrios ? p.barrios.length : 0 });
});

// ---------- Ventas Serrana ----------
app.post('/api/ventas/import', auth('admin'), uploadSheet.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Elegí la planilla de ventas (.xlsx).' });
  let data;
  try { data = await X.readVentas(req.file.buffer, req.file.originalname); }
  catch (e) { return res.status(400).json({ error: e.message && e.message.length < 300 ? e.message : 'No se pudo leer el archivo.' }); }
  if (!data.rows.length) return res.status(400).json({ error: 'La planilla no tiene filas de ventas válidas (SFAC o SNCRED).' });
  let desde = data.rows[0].fecha, hasta = data.rows[0].fecha;
  for (const r of data.rows) { if (r.fecha < desde) desde = r.fecha; if (r.fecha > hasta) hasta = r.fecha; }
  const primeraCarga = !db.prepare('SELECT 1 FROM ventas_cargas LIMIT 1').get();
  const antes = new Set(Object.values(V.analizar(db).sucursales).filter((s) => s.prioridad).map((s) => s.sucursal));
  db.transaction(() => {
    db.prepare('DELETE FROM ventas WHERE fecha >= ? AND fecha <= ?').run(desde, hasta);
    const ins = db.prepare('INSERT INTO ventas (fecha, documento, numero, cliente, sucursal, packs) VALUES (@fecha,@documento,@numero,@cliente,@sucursal,@packs)');
    for (const r of data.rows) ins.run(r);
    db.prepare('INSERT INTO ventas_cargas (archivo, desde, hasta, filas, created_at) VALUES (?,?,?,?,?)').run(req.file.originalname, desde, hasta, data.rows.length, T.nowISO());
  })();
  V.invalidar();
  const an = V.analizar(db);
  const insA = db.prepare(`INSERT INTO alertas (tipo, texto, client_id, created_at) VALUES ('caida', ?, ?, ?)`);
  // En la primera carga no se generan alertas: las prioridades se ven en la pestaña Ventas y en las sugerencias.
  for (const s of Object.values(an.sucursales).filter((x) => !primeraCarga && x.prioridad && !antes.has(x.sucursal))) {
    const c = db.prepare('SELECT id, nombre FROM clients WHERE codigo_ventas = ? AND active = 1').get(s.sucursal);
    if (c) insA.run(`${c.nombre} entró en caída de ventas: ${s.motivo}`, c.id, T.nowISO());
  }
  res.json({ filas: data.rows.length, invalidas: data.invalidas, desde, hasta, prioridad: Object.values(an.sucursales).filter((s) => s.prioridad).length });
});

app.get('/api/ventas', auth('admin'), (req, res) => {
  const an = V.analizar(db);
  const byCode = new Map(db.prepare(`SELECT id, nombre, zona, codigo_ventas FROM clients WHERE active = 1 AND codigo_ventas <> ''`).all().map((c) => [c.codigo_ventas, c]));
  const sucursales = Object.values(an.sucursales).map((s) => ({ ...s, comercio: byCode.get(s.sucursal) || null }))
    .sort((a, b) => (b.prioridad - a.prioridad) || (!!b.comercio - !!a.comercio) || ((a.variacion ?? 9) - (b.variacion ?? 9)));
  const sinCodigo = db.prepare(`SELECT id, nombre, zona FROM clients WHERE active = 1 AND tipo = 'serrana' AND cadena = 'Grupo Disco' AND codigo_ventas = ''`).all();
  res.json({ ref: an.ref, cargas: db.prepare('SELECT * FROM ventas_cargas ORDER BY id DESC LIMIT 5').all(), sucursales, sinCodigo });
});

// ---------- Semana del vendedor ----------
function semanaDe(q) { return T.mondayOf(T.isYmd(q) ? q : T.today()); }

function semanaPayload(userId, semana) {
  const items = db.prepare(`SELECT c.*, si.id AS item_id, si.fecha, si.motivo, si.client_id,
      (SELECT pi.status FROM plan_items pi WHERE pi.semana_item_id = si.id AND pi.status IN ('si','no') ORDER BY pi.id DESC LIMIT 1) AS hecho
    FROM semana_items si JOIN clients c ON c.id = si.client_id WHERE si.user_id = ? AND si.semana = ? ORDER BY si.fecha, c.zona, c.nombre`).all(userId, semana);
  const pub = db.prepare('SELECT publicada_at FROM semanas WHERE user_id = ? AND semana = ?').get(userId, semana);
  const hoy = T.today();
  const dias = [0, 1, 2, 3, 4, 5].map((i) => T.addDays(semana, i)).map((fecha) => {
    const del = geo.ordenar(items.filter((r) => r.fecha === fecha));
    return {
      fecha, nombre: T.dayName(fecha), barrios: [...new Set(del.map((r) => r.zona))],
      items: del.map((r) => ({
        id: r.item_id, fecha: r.fecha, motivo: r.motivo, client: publicClient({ ...r, id: r.client_id }),
        estado: r.hecho || (fecha < hoy ? 'sin_visitar' : 'pendiente')
      }))
    };
  });
  return { semana, publicada_at: pub?.publicada_at || null, dias, total: items.length, hechas: items.filter((r) => r.hecho === 'si').length };
}

app.get('/api/semana', auth(), (req, res) => {
  const p = semanaPayload(vendedorId(req), semanaDe(req.query.semana));
  if (req.user.role !== 'admin' && !p.publicada_at) return res.json({ ...p, dias: p.dias.map((d) => ({ ...d, items: [], barrios: [] })), total: 0, hechas: 0, sinPublicar: true });
  res.json(p);
});

app.post('/api/semana/sugerencias', auth('admin'), (req, res) => {
  const userId = vendedorId(req), semana = semanaDe(req.body?.semana);
  const bm = barriosMap();
  const elegidos = (req.body?.barrios || []).map((b) => bm.get(X.norm(b))?.nombre || String(b));
  const esElegido = (z) => elegidos.some((e) => X.norm(e) === X.norm(z));
  const linderos = [...new Set(elegidos.flatMap((b) => bm.get(X.norm(b))?.linderos || []))].filter((b) => !esElegido(b));
  const set = new Set([...elegidos, ...linderos].map(X.norm));
  const ya = new Set(db.prepare('SELECT client_id FROM semana_items WHERE user_id = ? AND semana = ?').all(userId, semana).map((r) => r.client_id));
  const hasta = T.addDays(semana, 5);
  const lista = estados(semana).filter((c) => set.has(X.norm(c.zona)) && !ya.has(c.id) && leToca(c, hasta))
    .map((c) => ({ client: publicClient(c), m: motivoDe(c), lindero: !esElegido(c.zona) }))
    .sort((a, b) => (a.m.prio - b.m.prio) || (a.lindero - b.lindero) || a.client.zona.localeCompare(b.client.zona, 'es') || a.client.nombre.localeCompare(b.client.nombre, 'es'));
  res.json({ semana, elegidos, linderos, sugeridos: lista.map((s) => ({ client: s.client, motivo: s.m.texto, prioridad: s.m.prio, lindero: s.lindero })) });
});

app.post('/api/semana/items', auth('admin'), (req, res) => {
  const userId = vendedorId(req), semana = semanaDe(req.body?.semana);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const dias = new Set([0, 1, 2, 3, 4, 5].map((i) => T.addDays(semana, i)));
  let n = 0;
  const up = db.prepare(`INSERT INTO semana_items (user_id, semana, fecha, client_id, motivo, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id, semana, client_id) DO UPDATE SET fecha = excluded.fecha, motivo = CASE WHEN excluded.motivo <> '' THEN excluded.motivo ELSE semana_items.motivo END`);
  db.transaction(() => {
    for (const it of items) {
      if (!dias.has(it.fecha)) continue;
      const c = db.prepare('SELECT id FROM clients WHERE id = ? AND active = 1').get(Number(it.client_id));
      if (!c) continue;
      up.run(userId, semana, it.fecha, c.id, String(it.motivo || '').slice(0, 200), T.nowISO()); n++;
    }
  })();
  res.json({ guardados: n, ...semanaPayload(userId, semana) });
});

app.patch('/api/semana/items/:id', auth('admin'), (req, res) => {
  const it = db.prepare('SELECT * FROM semana_items WHERE id = ?').get(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No existe esa visita.' });
  const fecha = req.body?.fecha;
  if (!T.isYmd(fecha) || T.mondayOf(fecha) !== it.semana || T.daysBetween(it.semana, fecha) > 5) return res.status(400).json({ error: 'El día tiene que ser de la misma semana.' });
  db.prepare('UPDATE semana_items SET fecha = ? WHERE id = ?').run(fecha, it.id);
  res.json(semanaPayload(it.user_id, it.semana));
});

app.delete('/api/semana/items/:id', auth('admin'), (req, res) => {
  const it = db.prepare('SELECT * FROM semana_items WHERE id = ?').get(Number(req.params.id));
  if (!it) return res.status(404).json({ error: 'No existe esa visita.' });
  db.prepare('UPDATE plan_items SET semana_item_id = NULL WHERE semana_item_id = ?').run(it.id);
  db.prepare('DELETE FROM semana_items WHERE id = ?').run(it.id);
  res.json(semanaPayload(it.user_id, it.semana));
});

app.post('/api/semana/publicar', auth('admin'), (req, res) => {
  const userId = vendedorId(req), semana = semanaDe(req.body?.semana);
  const pub = req.body?.publicar === false ? null : T.nowISO();
  db.prepare(`INSERT INTO semanas (user_id, semana, publicada_at) VALUES (?,?,?) ON CONFLICT(user_id, semana) DO UPDATE SET publicada_at = excluded.publicada_at`).run(userId, semana, pub);
  res.json(semanaPayload(userId, semana));
});

// ---------- Jornada del vendedor ----------
function mapsRouteLinks(items, start) {
  const pts = items.filter((c) => c.lat != null).map((c) => `${c.lat},${c.lng}`);
  const links = [];
  for (let i = 0; i < pts.length; i += 9) {
    const chunk = pts.slice(i, i + 9);
    const origin = i === 0 && start && start.lat != null ? `${start.lat},${start.lng}` : (i > 0 ? pts[i - 1] : '');
    const all = origin ? [origin, ...chunk] : chunk;
    links.push({ desde: i + 1, hasta: i + chunk.length, url: 'https://www.google.com/maps/dir/' + all.join('/') });
  }
  return links;
}

function planPayload(plan) {
  if (!plan) return { plan: null };
  const items = db.prepare(`SELECT c.*, pi.id AS item_id, pi.position, pi.carried, pi.status, pi.urgencia, pi.nota, si.motivo AS motivo,
      v.id AS visit_id, v.arrived_at, v.saved_at, v.comment, v.estandar, v.motivo_no, v.volver_meses AS v_volver, v.convertido, v.photo_file, v.photo_at, v.lat AS v_lat, v.lng AS v_lng
    FROM plan_items pi JOIN clients c ON c.id = pi.client_id LEFT JOIN visits v ON v.plan_item_id = pi.id LEFT JOIN semana_items si ON si.id = pi.semana_item_id
    WHERE pi.plan_id = ? ORDER BY pi.position`).all(plan.id);
  return {
    plan: { id: plan.id, zona: plan.zona, started_at: plan.started_at, start_lat: plan.start_lat, start_lng: plan.start_lng },
    items: items.map((r) => ({
      item_id: r.item_id, position: r.position, carried: !!r.carried, status: r.status, urgencia: !!r.urgencia, nota: r.nota, motivo: r.motivo || '',
      client: publicClient(r),
      visit: r.visit_id ? {
        id: r.visit_id, arrived_at: r.arrived_at, saved_at: r.saved_at, comment: r.comment, estandar: r.estandar ? r.estandar.split(' · ') : [],
        motivo_no: r.motivo_no, volver_meses: r.v_volver, convertido: !!r.convertido, lat: r.v_lat, lng: r.v_lng,
        has_photo: !!r.photo_file, photo_at: r.photo_at, photo_url: r.photo_file ? `/api/photos/${r.photo_file}` : null
      } : null
    })),
    rutas: mapsRouteLinks(items.filter((r) => r.status === 'pending'), { lat: plan.start_lat, lng: plan.start_lng })
  };
}

function openPlan(userId) {
  return db.prepare('SELECT * FROM plans WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(userId);
}

// Visitas asignadas para hoy (semana publicada) que todavía no tienen SÍ/NO.
function asignadasHoy(userId) {
  const hoy = T.today();
  const pub = db.prepare('SELECT publicada_at FROM semanas WHERE user_id = ? AND semana = ?').get(userId, T.mondayOf(hoy));
  if (!pub?.publicada_at) return [];
  return db.prepare(`SELECT c.*, si.id AS semana_item_id, si.motivo FROM semana_items si JOIN clients c ON c.id = si.client_id
    WHERE si.user_id = ? AND si.fecha = ? AND c.active = 1
      AND NOT EXISTS (SELECT 1 FROM plan_items pi WHERE pi.semana_item_id = si.id AND pi.status IN ('si','no'))`).all(userId, hoy);
}

function cerrarPlan(plan, now, mode, pos) {
  db.prepare(`UPDATE plans SET ended_at = ?, end_lat = ?, end_lng = ?, end_acc = ?, end_mode = ? WHERE id = ?`)
    .run(now, pos?.lat ?? null, pos?.lng ?? null, pos?.acc ?? null, mode, plan.id);
  db.prepare(`UPDATE plan_items SET status = 'skipped' WHERE plan_id = ? AND status = 'pending'`).run(plan.id);
}

function nuevoPlan(userId, zona, items, start, n) {
  const now = T.nowISO();
  let planId;
  db.transaction(() => {
    const prev = openPlan(userId);
    if (prev) cerrarPlan(prev, now, 'auto', null);
    planId = db.prepare(`INSERT INTO plans (user_id, zona, n_requested, started_at, start_lat, start_lng, start_acc) VALUES (?,?,?,?,?,?,?)`)
      .run(userId, zona, n ?? items.length, now, start.lat, start.lng, start.acc).lastInsertRowid;
    const ins = db.prepare('INSERT INTO plan_items (plan_id, client_id, position, carried, semana_item_id) VALUES (?,?,?,?,?)');
    items.forEach((c, i) => ins.run(planId, c.id, i + 1, c.postponed ? 1 : 0, c.semana_item_id || null));
  })();
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
}

app.get('/api/plan/current', auth('vendedor', 'admin'), (req, res) => {
  const plan = openPlan(req.user.id);
  res.json({ ...planPayload(plan), asignadas: plan ? [] : geo.ordenar(asignadasHoy(req.user.id)).map((c) => ({ client: publicClient(c), motivo: c.motivo })) });
});

// Iniciar jornada con las visitas asignadas para hoy, ordenadas desde donde está el vendedor.
app.post('/api/plan/iniciar', auth('vendedor', 'admin'), (req, res) => {
  const start = { lat: num(req.body?.lat), lng: num(req.body?.lng), acc: num(req.body?.acc) };
  const items = geo.ordenar(asignadasHoy(req.user.id), start.lat != null ? start : null);
  const zona = [...new Set(items.map((c) => c.zona))].join(', ') || 'Sin visitas asignadas';
  res.json(planPayload(nuevoPlan(req.user.id, zona, items, start)));
});

// Sin visitas asignadas: el vendedor elige un barrio y el sistema arma la recorrida con lo que le toca.
function disponiblesEn(zona) {
  const hoy = T.today();
  return estados().filter((c) => X.norm(c.zona) === X.norm(zona) && leToca(c, hoy)).map((c) => ({ ...c, postponed: c.pendiente || c.caida }));
}

app.get('/api/plan/options', auth('vendedor', 'admin'), (req, res) => {
  const hoy = T.today();
  const zones = {};
  for (const c of estados()) {
    const z = zones[c.zona] || (zones[c.zona] = { zona: c.zona, total: 0, disponibles: 0, postergadas: 0, caidas: 0 });
    z.total++;
    if (leToca(c, hoy)) { z.disponibles++; if (c.pendiente) z.postergadas++; if (c.caida) z.caidas++; }
  }
  res.json({ zonas: Object.values(zones).sort((a, b) => a.zona.localeCompare(b.zona, 'es')), estimaciones: estimates() });
});

app.post('/api/plan/preview', auth('vendedor', 'admin'), (req, res) => {
  const n = Math.max(1, Math.min(30, Number(req.body?.n) || 1));
  const cands = disponiblesEn(req.body?.zona);
  const chosen = elegir(cands, n, { lat: num(req.body?.lat), lng: num(req.body?.lng) });
  res.json({ minutos: estimateMinutes(chosen, estimates()), cantidad: chosen.length });
});

function elegir(cands, n, start) {
  const conUbic = cands.filter((c) => c.lat != null);
  const s = start && start.lat != null ? start : null;
  const chosen = geo.suggest(conUbic, n, s);
  if (chosen.length < n) chosen.push(...cands.filter((c) => c.lat == null).slice(0, n - chosen.length));
  return chosen;
}

app.post('/api/plan', auth('vendedor', 'admin'), (req, res) => {
  const { zona } = req.body || {};
  const n = Math.max(1, Math.min(30, Number(req.body?.n) || 1));
  const start = { lat: num(req.body?.lat), lng: num(req.body?.lng), acc: num(req.body?.acc) };
  const cands = disponiblesEn(zona);
  if (!cands.length) return res.status(400).json({ error: 'No hay comercios a los que les toque visita en ese barrio.' });
  res.json(planPayload(nuevoPlan(req.user.id, zona, elegir(cands, n, start), start, n)));
});

// Agregar una visita fuera de plan: una urgencia o un comercio encontrado en el camino.
app.post('/api/plan/agregar', auth('vendedor', 'admin'), async (req, res) => {
  const b = req.body || {};
  let clientId = Number(b.client_id) || null;
  try {
    if (!clientId && b.nuevo) clientId = Number(await crearComercio({ ...b.nuevo, tipo: b.nuevo.tipo || 'Prospecto BEC' }));
  } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  const c = clientId && db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(clientId);
  if (!c) return res.status(400).json({ error: 'Elegí un comercio o cargá uno nuevo.' });
  let plan = openPlan(req.user.id);
  if (!plan) {
    const start = { lat: num(b.lat), lng: num(b.lng), acc: num(b.acc) };
    const asign = geo.ordenar(asignadasHoy(req.user.id), start.lat != null ? start : null);
    plan = nuevoPlan(req.user.id, [...new Set([...asign.map((x) => x.zona), c.zona])].join(', '), asign, start);
  }
  if (db.prepare(`SELECT 1 FROM plan_items WHERE plan_id = ? AND client_id = ? AND status = 'pending'`).get(plan.id, c.id)) return res.status(409).json({ error: `${c.nombre} ya está en la recorrida de hoy.` });
  const nota = String(b.nota || '').trim().slice(0, 300);
  const urgencia = b.urgencia !== false;
  const pos = (db.prepare('SELECT MAX(position) AS m FROM plan_items WHERE plan_id = ?').get(plan.id).m || 0) + 1;
  db.transaction(() => {
    db.prepare('INSERT INTO plan_items (plan_id, client_id, position, urgencia, nota) VALUES (?,?,?,?,?)').run(plan.id, c.id, pos, urgencia ? 1 : 0, nota);
    if (urgencia) db.prepare(`INSERT INTO alertas (tipo, texto, client_id, created_at) VALUES ('urgencia', ?, ?, ?)`)
      .run(`${req.user.username} agregó una urgencia: ${c.nombre} (${c.zona})${nota ? ` · ${nota}` : ''}`, c.id, T.nowISO());
  })();
  res.json(planPayload(plan));
});

app.post('/api/plan/end', auth('vendedor', 'admin'), (req, res) => {
  const plan = openPlan(req.user.id);
  if (!plan) return res.status(400).json({ error: 'No hay una jornada abierta.' });
  const now = T.nowISO();
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE plan_id = ? AND status = 'pending'`).get(plan.id).n;
  db.transaction(() => cerrarPlan(plan, now, 'manual', { lat: num(req.body?.lat), lng: num(req.body?.lng), acc: num(req.body?.acc) }))();
  res.json({ ok: true, ended_at: now, devueltas: pending, zona: plan.zona });
});

// ---------- Estimaciones de tiempo ----------
function estimates() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = db.prepare(`SELECT c.empresa, v.arrived_at, v.saved_at FROM visits v JOIN clients c ON c.id = v.client_id WHERE v.result='si' AND v.saved_at IS NOT NULL AND v.arrived_at >= ?`).all(since);
  const out = { BEC: { min: 15, n: 0 }, MAN: { min: 30, n: 0 }, traslado: { min: 12, n: 0 } };
  for (const emp of ['BEC', 'MAN']) {
    const d = rows.filter((r) => r.empresa === emp).map((r) => T.minutesBetween(r.arrived_at, r.saved_at)).filter((m) => m >= 1 && m <= 240);
    if (d.length) out[emp] = { min: Math.round(d.reduce((a, b) => a + b, 0) / d.length), n: d.length };
  }
  const plans = db.prepare('SELECT id FROM plans WHERE started_at >= ?').all(since);
  const gaps = [];
  for (const p of plans) {
    const vs = db.prepare('SELECT arrived_at, saved_at FROM visits WHERE plan_id = ? ORDER BY arrived_at').all(p.id);
    for (let i = 1; i < vs.length; i++) {
      const g = T.minutesBetween(vs[i - 1].saved_at || vs[i - 1].arrived_at, vs[i].arrived_at);
      if (g >= 1 && g <= 120) gaps.push(g);
    }
  }
  if (gaps.length) out.traslado = { min: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), n: gaps.length };
  return out;
}

function estimateMinutes(items, est) {
  let m = 0;
  items.forEach((c, i) => {
    m += est[c.empresa]?.min || 20;
    if (i > 0) m += items[i - 1].lat != null && c.lat != null ? Math.max(5, Math.round(geo.km(items[i - 1], c) * 1.3 / 30 * 60) + 4) : est.traslado.min;
  });
  return m;
}

// ---------- Visitas ----------
function ownItem(itemId) {
  return db.prepare(`SELECT pi.*, p.user_id, p.ended_at FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.id = ?`).get(itemId);
}

app.post('/api/visits', auth('vendedor', 'admin'), (req, res) => {
  const itemId = Number(req.body?.item_id);
  const result = req.body?.result;
  if (!['si', 'no'].includes(result)) return res.status(400).json({ error: 'Resultado inválido.' });
  const item = ownItem(itemId);
  if (!item || item.user_id !== req.user.id) return res.status(404).json({ error: 'No existe esa parada.' });
  if (item.ended_at) return res.status(400).json({ error: 'Esa jornada ya está cerrada.' });
  const existing = db.prepare('SELECT * FROM visits WHERE plan_item_id = ?').get(itemId);
  db.transaction(() => {
    if (existing) db.prepare('UPDATE visits SET result = ? WHERE id = ?').run(result, existing.id);
    else db.prepare(`INSERT INTO visits (plan_item_id, plan_id, client_id, user_id, result, arrived_at, lat, lng, acc) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(itemId, item.plan_id, item.client_id, req.user.id, result, T.nowISO(), num(req.body?.lat), num(req.body?.lng), num(req.body?.acc));
    db.prepare('UPDATE plan_items SET status = ? WHERE id = ?').run(result, itemId);
  })();
  res.json(db.prepare('SELECT id, result, arrived_at, lat, lng FROM visits WHERE plan_item_id = ?').get(itemId));
});

function ownVisit(req, id) {
  const v = db.prepare(`SELECT v.*, p.ended_at FROM visits v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?`).get(id);
  if (!v || v.user_id !== req.user.id) return null;
  return v;
}

app.post('/api/visits/:id/photo', auth('vendedor', 'admin'), uploadPhoto.single('foto'), (req, res) => {
  const v = ownVisit(req, Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'No existe esa visita.' });
  if (v.ended_at) return res.status(400).json({ error: 'Esa jornada ya está cerrada.' });
  if (!req.file) return res.status(400).json({ error: 'No llegó ninguna foto.' });
  const name = `v${v.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), req.file.buffer);
  if (v.photo_file) fs.rm(path.join(PHOTO_DIR, path.basename(v.photo_file)), () => {});
  const now = T.nowISO();
  db.prepare('UPDATE visits SET photo_file = ?, photo_at = ?, photo_lat = ?, photo_lng = ?, photo_acc = ? WHERE id = ?')
    .run(name, now, num(req.body?.lat), num(req.body?.lng), num(req.body?.acc), v.id);
  res.json({ ok: true, photo_at: now });
});

app.patch('/api/visits/:id', auth('vendedor', 'admin'), (req, res) => {
  const v = ownVisit(req, Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'No existe esa visita.' });
  if (v.ended_at) return res.status(400).json({ error: 'Esa jornada ya está cerrada.' });
  const b = req.body || {};
  const motivo = String(b.motivo_no ?? v.motivo_no ?? '').trim().slice(0, 200);
  if (v.result === 'si' && !v.photo_file) return res.status(400).json({ error: 'Falta la foto para guardar una visita SÍ.' });
  if (v.result === 'no' && !motivo) return res.status(400).json({ error: 'Elegí el motivo por el que no se hizo la visita.' });
  const comment = String(b.comment ?? v.comment ?? '').slice(0, 2000);
  const estandar = (Array.isArray(b.estandar) ? b.estandar : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12).join(' · ');
  const volver = b.volver_meses === '' || b.volver_meses == null ? null : Math.max(0, Math.min(36, parseInt(b.volver_meses, 10) || 0));
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(v.client_id);
  const convertido = !!b.convertido && c.tipo === 'prospecto' && v.result === 'si';
  db.transaction(() => {
    db.prepare('UPDATE visits SET comment = ?, estandar = ?, motivo_no = ?, volver_meses = ?, convertido = ?, saved_at = ? WHERE id = ?')
      .run(comment, estandar, v.result === 'no' ? motivo : '', volver, convertido ? 1 : 0, T.nowISO(), v.id);
    if (c.tipo === 'prospecto' && v.result === 'si') {
      if (convertido) convertir(c.id);
      else {
        const meses = volver != null ? volver : (c.volver_meses ?? 3);
        db.prepare('UPDATE clients SET volver_meses = ?, volver_fecha = ?, updated_at = ? WHERE id = ?').run(meses, volverFecha(meses), T.nowISO(), c.id);
      }
    }
  })();
  res.json({ ok: true });
});

app.get('/api/photos/:file', auth(), (req, res) => {
  const name = path.basename(req.params.file);
  const row = db.prepare('SELECT v.user_id FROM visits v WHERE v.photo_file = ?').get(name);
  if (!row) return res.status(404).end();
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(PHOTO_DIR, name));
});

function visitRows(q, role, userId) {
  const where = ['1=1'];
  const p = {};
  if (role !== 'admin') { where.push('v.user_id = @uid'); p.uid = userId; }
  if (q.mes && /^\d{4}-\d{2}$/.test(q.mes)) { const [a, b] = T.monthRangeUTC(q.mes); where.push('v.arrived_at >= @a AND v.arrived_at < @b'); p.a = a; p.b = b; }
  if (q.zona) { where.push('c.zona = @zona'); p.zona = q.zona; }
  if (q.tipo) { where.push('c.tipo = @tipo'); p.tipo = q.tipo; }
  if (q.resultado === 'si' || q.resultado === 'no') { where.push('v.result = @res'); p.res = q.resultado; }
  const rows = db.prepare(`SELECT v.*, c.tipo, c.empresa, c.nombre, c.direccion, c.zona, c.geo, c.lat AS c_lat, c.lng AS c_lng, u.username, pi.urgencia
    FROM visits v JOIN clients c ON c.id = v.client_id JOIN users u ON u.id = v.user_id JOIN plan_items pi ON pi.id = v.plan_item_id
    WHERE ${where.join(' AND ')} ORDER BY v.arrived_at DESC LIMIT 5000`).all(p);
  return rows.map((r) => {
    const ok = r.geo === 'ok';
    return {
      id: r.id, fecha: T.localDateTime(r.arrived_at), arrived_at: r.arrived_at, zona: r.zona, tipo: r.tipo, tipo_nombre: X.TIPO_NOMBRE[r.tipo] || '', empresa: r.empresa,
      sucursal: r.nombre, direccion: r.direccion, resultado: r.result === 'si' ? 'SÍ' : 'NO', motivo_no: r.motivo_no, estandar: r.estandar, comentario: r.comment,
      urgencia: !!r.urgencia, convertido: !!r.convertido, vendedor: r.username, foto: r.photo_file ? `/api/photos/${r.photo_file}` : null,
      lat: r.lat, lng: r.lng, precision_m: r.acc != null ? Math.round(r.acc) : null,
      distancia_m: ok ? geo.meters({ lat: r.lat, lng: r.lng }, { lat: r.c_lat, lng: r.c_lng }) : null,
      salida: T.localTime(r.saved_at), minutos: T.minutesBetween(r.arrived_at, r.saved_at),
      foto_hora: T.localTime(r.photo_at)
    };
  });
}

app.get('/api/visits', auth(), (req, res) => res.json(visitRows(req.query, req.user.role, req.user.id)));

app.get('/api/visits/export', auth(), async (req, res) => {
  const rows = visitRows(req.query, req.user.role, req.user.id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Visitas');
  const cols = [
    ['Fecha y hora', 'fecha', 17], ['Barrio', 'zona', 16], ['Tipo', 'tipo_nombre', 14], ['Comercio', 'sucursal', 32], ['Dirección', 'direccion', 26],
    ['¿Visitó?', 'resultado', 9], ['Motivo del NO', 'motivo_no', 22], ['Comentarios estándar', 'estandar', 36], ['Comentario libre', 'comentario', 40],
    ['Urgencia', 'urgencia_txt', 9], ['Pasó a cliente', 'convertido_txt', 12], ['Vendedor', 'vendedor', 12],
    ['Salida', 'salida', 8], ['Minutos en el local', 'minutos', 10], ['Latitud', 'lat', 11], ['Longitud', 'lng', 11], ['Distancia al comercio (m)', 'distancia_m', 12],
    ['Hora foto', 'foto_hora', 9], ['Foto', 'foto', 16]
  ];
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  const base = `${req.protocol}://${req.get('host')}`;
  for (const r of rows) {
    const row = ws.addRow({ ...r, urgencia_txt: r.urgencia ? 'Sí' : '', convertido_txt: r.convertido ? 'Sí' : '', foto: r.foto ? 'Ver foto' : '' });
    if (r.foto) row.getCell('foto').value = { text: 'Ver foto', hyperlink: base + r.foto };
  }
  ws.getRow(1).font = { name: 'Arial', bold: true };
  ws.eachRow((row, i) => { if (i > 1) row.font = { name: 'Arial' }; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="visitas_${req.query.mes || 'todas'}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------- Control de jornada (solo administrador) ----------
app.get('/api/users', auth('admin'), (req, res) => {
  res.json(db.prepare(`SELECT id, username, role FROM users ORDER BY role DESC, username`).all());
});

app.get('/api/estimates', auth('admin'), (req, res) => res.json(estimates()));

function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${m} m`; }
function fmtMin(m) { const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; }

function controlDia(userId, date) {
  const plans = db.prepare(`SELECT * FROM plans WHERE user_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at`)
    .all(userId, T.dayStartUTC(date), T.dayEndUTC(date));
  const events = [], alerts = [];
  let visitMin = 0, travelMin = 0, idleMin = 0, photosOk = 0, photosTotal = 0, nVisits = 0;
  const points = [];
  for (const p of plans) {
    events.push({ tipo: 'inicio', hora: T.localTime(p.started_at), titulo: `Inicio de jornada · ${p.zona}`, detalle: `${p.n_requested} ${p.n_requested === 1 ? 'visita' : 'visitas'} en la recorrida`, lat: p.start_lat, lng: p.start_lng });
    if (p.start_lat != null) points.push({ lat: p.start_lat, lng: p.start_lng, tipo: 'inicio' });
    else alerts.push(`No se registró la ubicación al iniciar la jornada (${T.localTime(p.started_at)}).`);
    const vs = db.prepare(`SELECT v.*, c.nombre, c.empresa, c.tipo, c.geo, c.lat AS c_lat, c.lng AS c_lng, pi.urgencia FROM visits v JOIN clients c ON c.id = v.client_id JOIN plan_items pi ON pi.id = v.plan_item_id WHERE v.plan_id = ? ORDER BY v.arrived_at`).all(p.id);
    let prevEnd = p.started_at;
    for (const v of vs) {
      const gap = T.minutesBetween(prevEnd, v.arrived_at);
      if (gap != null && gap > 0) { travelMin += gap; events.push({ tipo: 'traslado', hora: T.localTime(prevEnd), titulo: 'Traslado', detalle: `${gap} min` }); }
      const dur = T.minutesBetween(v.arrived_at, v.saved_at);
      if (dur != null) visitMin += dur;
      nVisits++;
      const ok = v.geo === 'ok';
      const dist = ok ? geo.meters({ lat: v.lat, lng: v.lng }, { lat: v.c_lat, lng: v.c_lng }) : null;
      const photoDist = ok ? geo.meters({ lat: v.photo_lat, lng: v.photo_lng }, { lat: v.c_lat, lng: v.c_lng }) : null;
      if (v.photo_file) { photosTotal++; if (!ok || (photoDist != null && photoDist <= 300)) photosOk++; }
      if (photoDist != null && photoDist > 300) alerts.push(`${v.nombre}: la foto se sacó a ${fmtDist(photoDist)} del comercio (${T.localTime(v.photo_at)}).`);
      if (v.photo_file && v.photo_lat == null) alerts.push(`${v.nombre}: la foto no tiene ubicación registrada.`);
      if (dist != null && dist > 300) alerts.push(`${v.nombre}: marcó la visita a ${fmtDist(dist)} del comercio.`);
      if (v.lat == null) alerts.push(`${v.nombre}: la visita no tiene ubicación registrada.`);
      if (!v.saved_at) alerts.push(`${v.nombre}: marcó ${v.result === 'si' ? 'SÍ' : 'NO'} pero no guardó la visita.`);
      const coment = [v.motivo_no && `Motivo: ${v.motivo_no}`, v.estandar, v.comment && `“${v.comment}”`].filter(Boolean).join(' · ');
      events.push({
        tipo: 'visita', hora: T.localTime(v.arrived_at), titulo: v.nombre, empresa: v.empresa, tipo_comercio: X.TIPO_NOMBRE[v.tipo], urgencia: !!v.urgencia, resultado: v.result === 'si' ? 'SÍ' : 'NO',
        detalle: `Llegada ${T.localTime(v.arrived_at)}${v.saved_at ? ` · salida ${T.localTime(v.saved_at)} · ${dur} min en el local` : ' · sin guardar'}${coment ? ` · ${coment}` : ''}`,
        lat: v.lat, lng: v.lng, distancia: dist != null ? fmtDist(dist) : null, lejos: dist != null && dist > 300,
        foto: v.photo_file ? `/api/photos/${v.photo_file}` : null, foto_hora: T.localTime(v.photo_at),
        foto_geo: v.photo_lat != null ? `${v.photo_lat.toFixed(5)}, ${v.photo_lng.toFixed(5)}` : null,
        foto_distancia: photoDist != null ? fmtDist(photoDist) : null, foto_lejos: photoDist != null && photoDist > 300
      });
      if (v.lat != null) points.push({ lat: v.lat, lng: v.lng, tipo: 'visita', nombre: v.nombre });
      prevEnd = v.saved_at || v.arrived_at;
    }
    if (p.ended_at) {
      const idle = T.minutesBetween(prevEnd, p.ended_at);
      if (vs.length && idle > 0) idleMin += idle;
      if (vs.length && idle > 60) alerts.push(`${fmtMin(idle)} sin actividad entre la última visita (${T.localTime(prevEnd)}) y el fin de jornada (${T.localTime(p.ended_at)}).`);
      if (p.end_mode === 'auto') alerts.push(`No tocó “Terminar jornada”: se cerró sola al iniciar otra (${T.localTime(p.ended_at)}). No hay ubicación de cierre.`);
      else if (p.end_lat == null) alerts.push('Terminó la jornada sin ubicación registrada.');
      events.push({ tipo: 'fin', hora: T.localTime(p.ended_at), titulo: 'Fin de jornada', detalle: p.end_mode === 'auto' ? 'Cierre automático (no tocó “Terminar jornada”)' : `Tocó “Terminar jornada”${vs.length && idle > 0 ? ` · ${fmtMin(idle)} desde la última visita` : ''}`, lat: p.end_lat, lng: p.end_lng });
      if (p.end_lat != null) points.push({ lat: p.end_lat, lng: p.end_lng, tipo: 'fin' });
    } else {
      events.push({ tipo: 'abierta', hora: '', titulo: 'Jornada en curso', detalle: 'Todavía no tocó “Terminar jornada”.' });
      if (date < T.today()) alerts.push('No tocó “Terminar jornada”: la jornada quedó abierta.');
    }
  }
  const first = plans[0]?.started_at, last = plans.length ? (plans[plans.length - 1].ended_at || null) : null;
  return {
    fecha: date, usuario: userId,
    resumen: plans.length ? {
      inicio: T.localTime(first), fin: last ? T.localTime(last) : null,
      jornada_min: last ? T.minutesBetween(first, last) : T.minutesBetween(first, T.nowISO()),
      visitas: nVisits, visitas_min: visitMin, traslados_min: travelMin, sin_actividad_min: idleMin,
      fotos_ok: photosOk, fotos_total: photosTotal
    } : null,
    eventos: events, alertas: alerts, puntos: points
  };
}

app.get('/api/control', auth('admin'), (req, res) => {
  const date = T.isYmd(req.query.fecha) ? req.query.fecha : T.today();
  res.json({ ...controlDia(vendedorId(req), date), estimaciones: estimates() });
});

// ---------- Dashboard ----------
function resumenPeriodo(userId, desde, hasta) { // fechas locales, `hasta` incluido
  const hoy = T.today();
  const tope = hasta < hoy ? hasta : hoy;
  const plan = db.prepare(`SELECT si.id, EXISTS (SELECT 1 FROM plan_items pi WHERE pi.semana_item_id = si.id AND pi.status = 'si') AS ok
    FROM semana_items si JOIN semanas s ON s.user_id = si.user_id AND s.semana = si.semana AND s.publicada_at IS NOT NULL
    WHERE si.user_id = ? AND si.fecha >= ? AND si.fecha <= ?`).all(userId, desde, tope);
  const a = T.dayStartUTC(desde), b = T.dayEndUTC(hasta);
  const porTipo = { serrana: 0, cliente: 0, prospecto: 0 };
  for (const r of db.prepare(`SELECT c.tipo, COUNT(*) AS n FROM visits v JOIN clients c ON c.id = v.client_id WHERE v.user_id = ? AND v.result = 'si' AND v.arrived_at >= ? AND v.arrived_at < ? GROUP BY c.tipo`).all(userId, a, b)) porTipo[r.tipo] = r.n;
  const minutos = db.prepare('SELECT started_at, ended_at FROM plans WHERE user_id = ? AND started_at >= ? AND started_at < ?').all(userId, a, b)
    .reduce((s, p) => s + Math.max(0, T.minutesBetween(p.started_at, p.ended_at || T.nowISO()) || 0), 0);
  const cumplidas = plan.filter((p) => p.ok).length;
  return {
    planificadas: plan.length, cumplidas, cumplimiento: plan.length ? Math.round(cumplidas / plan.length * 100) : null,
    visitas: porTipo.serrana + porTipo.cliente + porTipo.prospecto, porTipo, minutos,
    convertidos: db.prepare('SELECT COUNT(*) AS n FROM clients WHERE convertido_at >= ? AND convertido_at < ?').get(a, b).n
  };
}

app.get('/api/dashboard', auth(), (req, res) => {
  const userId = vendedorId(req);
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : T.currentMonth();
  const desde = `${mes}-01`, hasta = T.addDays(T.addMonths(desde, 1), -1);
  const semanas = [];
  for (let s = T.mondayOf(desde); s <= hasta; s = T.addDays(s, 7)) {
    const d = s < desde ? desde : s, h = T.addDays(s, 6) > hasta ? hasta : T.addDays(s, 6);
    semanas.push({ semana: s, desde: d, hasta: h, ...resumenPeriodo(userId, d, h) });
  }
  const out = { mes, usuario: userId, total: resumenPeriodo(userId, desde, hasta), semanas };
  if (req.user.role === 'admin') {
    const guardadas = db.prepare(`SELECT * FROM alertas WHERE vista_at IS NULL ORDER BY id DESC LIMIT 100`).all()
      .map((a) => ({ id: a.id, tipo: a.tipo, texto: a.texto, fecha: T.localDateTime(a.created_at) }));
    const jornada = [];
    for (let i = 0; i < 7; i++) {
      const f = T.addDays(T.today(), -i);
      for (const t of controlDia(userId, f).alertas) jornada.push({ tipo: 'jornada', texto: t, fecha: f.split('-').reverse().join('/'), dia: f });
    }
    out.alertas = [...guardadas, ...jornada];
  }
  res.json(out);
});

app.post('/api/alertas/:id/vista', auth('admin'), (req, res) => {
  db.prepare('UPDATE alertas SET vista_at = ? WHERE id = ?').run(T.nowISO(), Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Ubicación de comercios sin link de Maps (de a uno, respetando el límite del servicio) ----------
let geoBusy = false, geoPausa = 0, geoTimer = null;
async function geoPaso() {
  if (geoBusy || Date.now() < geoPausa) return;
  const c = db.prepare(`SELECT * FROM clients WHERE active = 1 AND geo = 'pendiente' ORDER BY id LIMIT 1`).get();
  if (!c) { clearInterval(geoTimer); geoTimer = null; return; }
  geoBusy = true;
  try {
    const r = await geo.geocode(c);
    if (r) db.prepare(`UPDATE clients SET lat = ?, lng = ?, geo = ? WHERE id = ? AND geo = 'pendiente'`).run(r.lat, r.lng, r.geo, c.id);
    else db.prepare(`UPDATE clients SET geo = 'fallo' WHERE id = ? AND geo = 'pendiente'`).run(c.id);
  } catch (e) {
    geoPausa = Date.now() + 60000;
    console.error('No se pudo ubicar', c.nombre, '-', e.message);
  } finally { geoBusy = false; }
}
function despertarGeo() {
  if (!geoTimer && process.env.GEOCODER !== 'off' && require.main === module) geoTimer = setInterval(geoPaso, Number(process.env.GEOCODER_INTERVAL_MS) || 1500);
}

// ---------- Páginas ----------
const PUB = path.join(__dirname, 'public');
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
app.get('/plantillas/:file', auth(), (req, res) => {
  const f = path.basename(req.params.file);
  if (!['Plantilla_Comercios.xlsx', 'Plantilla_Ventas_Serrana.xlsx'].includes(f)) return res.status(404).end();
  res.download(path.join(__dirname, 'plantillas', f));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
function page(file) { return (req, res) => res.sendFile(path.join(PUB, file)); }
app.get('/', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.redirect('/ingresar');
  const mobile = /Mobi|Android|iPhone/i.test(req.get('user-agent') || '');
  res.redirect(u.role === 'vendedor' && mobile ? '/app' : '/panel');
});
app.get('/ingresar', page('login.html'));
app.get('/app', (req, res, next) => (currentUser(req) ? next() : res.redirect('/ingresar?a=app')), page('app.html'));
app.get('/panel', (req, res, next) => (currentUser(req) ? next() : res.redirect('/ingresar')), page('panel.html'));

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo es demasiado grande.' : 'No se pudo subir el archivo.' });
  res.status(500).json({ error: 'Ocurrió un error. Probá de nuevo.' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Recorridas funcionando en http://localhost:${PORT}`));
  despertarGeo();
}
module.exports = app;
