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

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
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
const uploadSheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// ---------- Estado mensual de cada sucursal ----------
function clientStatuses() {
  const ms = T.monthStartUTC();
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT MAX(v.arrived_at) FROM visits v WHERE v.client_id = c.id AND v.result = 'si' AND v.arrived_at >= @ms) AS visited_at,
      (SELECT MAX(v.arrived_at) FROM visits v WHERE v.client_id = c.id) AS last_visit_at,
      (SELECT v.result FROM visits v WHERE v.client_id = c.id ORDER BY v.arrived_at DESC LIMIT 1) AS last_result,
      (SELECT pi.status FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.client_id = c.id AND pi.status <> 'pending' ORDER BY p.started_at DESC, pi.id DESC LIMIT 1) AS last_item_status
    FROM clients c WHERE c.active = 1 ORDER BY c.zona COLLATE NOCASE, c.nombre COLLATE NOCASE`).all({ ms });
  return rows.map((c) => {
    let status = 'pendiente';
    if (c.visited_at) status = 'visitada';
    else if (c.last_item_status === 'no' || c.last_item_status === 'skipped') status = 'postergada';
    return { ...c, status };
  });
}

function publicClient(c) {
  return { id: c.id, empresa: c.empresa, nombre: c.nombre, direccion: c.direccion, zona: c.zona, horario: c.horario, link: c.link, lat: c.lat, lng: c.lng };
}

// ---------- Clientes ----------
app.get('/api/clients', auth(), (req, res) => {
  const st = clientStatuses();
  res.json(st.map((c) => ({ ...publicClient(c), status: c.status, visited_at: c.visited_at, last_visit_at: c.last_visit_at })));
});

const FIELDS = ['empresa', 'nombre', 'direccion', 'zona', 'horario', 'link'];

function findDuplicate(rec, exceptId) {
  const all = db.prepare('SELECT * FROM clients WHERE active = 1 AND id <> ?').all(exceptId || 0);
  return all.find((c) => (c.lat != null && rec.lat != null && geo.meters(c, rec) <= 15) ||
    (X.norm(c.nombre) === X.norm(rec.nombre) && X.norm(rec.direccion) !== '' && X.norm(c.direccion) === X.norm(rec.direccion)));
}

app.post('/api/clients', auth(), async (req, res) => {
  const b = req.body || {};
  const rec = {
    empresa: String(b.empresa || '').toUpperCase().trim(), nombre: String(b.nombre || '').trim(), direccion: String(b.direccion || '').trim(),
    zona: String(b.zona || '').trim(), horario: X.cleanHorario(b.horario), link: String(b.link || '').trim()
  };
  if (!['BEC', 'MAN'].includes(rec.empresa)) return res.status(400).json({ error: 'Empresa debe ser BEC o MAN.' });
  if (!rec.nombre) return res.status(400).json({ error: 'Falta el nombre.' });
  if (!rec.zona) return res.status(400).json({ error: 'Falta la zona.' });
  if (!rec.link) return res.status(400).json({ error: 'Falta el link de Google Maps.' });
  const c = await geo.resolveLink(rec.link);
  if (!c) return res.status(400).json({ error: 'No se pudo leer la ubicación del link de Maps. Copiá el link desde Maps → Compartir.' });
  Object.assign(rec, c);
  const dup = findDuplicate(rec);
  if (dup) return res.status(409).json({ error: `Esta sucursal ya está cargada como "${dup.nombre}" (${dup.zona}).`, id: dup.id });
  const now = T.nowISO();
  const info = db.prepare(`INSERT INTO clients (empresa,nombre,direccion,zona,horario,link,lat,lng,active,created_at,updated_at) VALUES (@empresa,@nombre,@direccion,@zona,@horario,@link,@lat,@lng,1,@now,@now)`).run({ ...rec, now });
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/clients/:id', auth(), async (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(id);
  if (!cur) return res.status(404).json({ error: 'No existe esa sucursal.' });
  const upd = { ...cur };
  for (const f of FIELDS) if (req.body && f in req.body) upd[f] = String(req.body[f] ?? '').trim();
  upd.empresa = upd.empresa.toUpperCase();
  upd.horario = X.cleanHorario(upd.horario);
  if (!['BEC', 'MAN'].includes(upd.empresa)) return res.status(400).json({ error: 'Empresa debe ser BEC o MAN.' });
  if (!upd.nombre) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
  if (!upd.zona) return res.status(400).json({ error: 'La zona no puede quedar vacía.' });
  if (upd.link !== cur.link) {
    const c = await geo.resolveLink(upd.link);
    if (!c) return res.status(400).json({ error: 'No se pudo leer la ubicación del link de Maps.' });
    upd.lat = c.lat; upd.lng = c.lng;
  }
  const dup = findDuplicate(upd, id);
  if (dup) return res.status(409).json({ error: `Quedaría igual a "${dup.nombre}" (${dup.zona}), que ya está cargada.` });
  db.prepare(`UPDATE clients SET empresa=@empresa,nombre=@nombre,direccion=@direccion,zona=@zona,horario=@horario,link=@link,lat=@lat,lng=@lng,updated_at=@now WHERE id=@id`).run({ ...upd, now: T.nowISO(), id });
  res.json({ ok: true, client: publicClient(upd) });
});

app.delete('/api/clients/:id', auth(), (req, res) => {
  const info = db.prepare('UPDATE clients SET active = 0, updated_at = ? WHERE id = ? AND active = 1').run(T.nowISO(), Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'No existe esa sucursal.' });
  res.json({ ok: true });
});

// Importación de Excel en dos pasos: vista previa y confirmación.
const pendingImports = new Map();
app.post('/api/clients/import/preview', auth(), uploadSheet.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Elegí un archivo .xlsx o .csv.' });
  let rows;
  try {
    rows = await X.readRows(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(400).json({ error: e.message && e.message.length < 200 ? e.message : 'No se pudo leer el archivo. Usá la plantilla en formato .xlsx.' });
  }
  if (!rows.length) return res.status(400).json({ error: 'El archivo no tiene filas con datos.' });
  const existing = db.prepare('SELECT * FROM clients').all();
  const result = await X.analyze(rows, existing);
  const token = crypto.randomBytes(16).toString('hex');
  pendingImports.set(token, { userId: req.user.id, at: Date.now(), result, file: req.file.originalname });
  for (const [k, v] of pendingImports) if (Date.now() - v.at > 30 * 60000) pendingImports.delete(k);
  const brief = (r) => ({ fila: r.fila, empresa: r.empresa, nombre: r.nombre, direccion: r.direccion, zona: r.zona, cambios: r.cambios, parecido: r.parecido, reactivar: r.reactivar });
  res.json({
    token, archivo: req.file.originalname,
    nuevas: result.nuevas.map(brief), actualizadas: result.actualizadas.map(brief), sinCambios: result.sinCambios.length,
    posibles: result.posibles.map(brief), errores: result.errores, repetidasArchivo: result.repetidasArchivo
  });
});

app.post('/api/clients/import/confirm', auth(), (req, res) => {
  const { token, incluirPosibles } = req.body || {};
  const p = pendingImports.get(token);
  if (!p || p.userId !== req.user.id) return res.status(400).json({ error: 'La vista previa venció. Subí el archivo de nuevo.' });
  pendingImports.delete(token);
  const include = new Set((incluirPosibles || []).map(Number));
  const now = T.nowISO();
  const ins = db.prepare(`INSERT INTO clients (empresa,nombre,direccion,zona,horario,link,lat,lng,active,created_at,updated_at) VALUES (@empresa,@nombre,@direccion,@zona,@horario,@link,@lat,@lng,1,@now,@now)`);
  const up = db.prepare(`UPDATE clients SET empresa=@empresa,nombre=@nombre,direccion=@direccion,zona=@zona,horario=@horario,link=@link,lat=@lat,lng=@lng,active=1,updated_at=@now WHERE id=@id`);
  let agregadas = 0, actualizadas = 0;
  db.transaction(() => {
    for (const r of p.result.nuevas) { ins.run({ ...r, now }); agregadas++; }
    for (const r of p.result.posibles) if (include.has(r.fila)) { ins.run({ ...r, now }); agregadas++; }
    for (const r of p.result.actualizadas) { up.run({ ...r, now }); actualizadas++; }
  })();
  res.json({ agregadas, actualizadas });
});

app.get('/api/clients/template', auth(), async (req, res) => {
  const wb = await X.templateWorkbook();
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="plantilla_clientes_recorridas.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// ---------- Zonas ----------
app.get('/api/zones', auth(), (req, res) => {
  const st = clientStatuses();
  const zones = {};
  for (const c of st) {
    const z = zones[c.zona] || (zones[c.zona] = { zona: c.zona, total: 0, visitadas: 0, postergadas: 0, pendientes: 0 });
    z.total++;
    if (c.status === 'visitada') z.visitadas++; else if (c.status === 'postergada') z.postergadas++; else z.pendientes++;
  }
  res.json({
    mes: T.currentMonth(),
    zonas: Object.values(zones).sort((a, b) => a.zona.localeCompare(b.zona, 'es')),
    sucursales: st.map((c) => ({ ...publicClient(c), status: c.status, visited_at: c.visited_at, last_visit_at: c.last_visit_at, last_result: c.last_result }))
  });
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
  const plans = db.prepare('SELECT id, started_at FROM plans WHERE started_at >= ?').all(since);
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
  items.forEach((c, i) => { m += est[c.empresa]?.min || 20; if (i > 0) m += Math.max(5, Math.round(geo.km(items[i - 1], c) * 1.3 / 30 * 60) + 4); });
  return m;
}

// ---------- App del vendedor ----------
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
  const items = db.prepare(`SELECT pi.id AS item_id, pi.position, pi.carried, pi.status, c.*,
      v.id AS visit_id, v.arrived_at, v.saved_at, v.comment, v.photo_file, v.photo_at, v.lat AS v_lat, v.lng AS v_lng
    FROM plan_items pi JOIN clients c ON c.id = pi.client_id LEFT JOIN visits v ON v.plan_item_id = pi.id
    WHERE pi.plan_id = ? ORDER BY pi.position`).all(plan.id);
  return {
    plan: { id: plan.id, zona: plan.zona, started_at: plan.started_at, start_lat: plan.start_lat, start_lng: plan.start_lng },
    items: items.map((r) => ({
      item_id: r.item_id, position: r.position, carried: !!r.carried, status: r.status,
      client: publicClient(r),
      visit: r.visit_id ? {
        id: r.visit_id, arrived_at: r.arrived_at, saved_at: r.saved_at, comment: r.comment, lat: r.v_lat, lng: r.v_lng,
        has_photo: !!r.photo_file, photo_at: r.photo_at, photo_url: r.photo_file ? `/api/photos/${r.photo_file}` : null
      } : null
    })),
    rutas: mapsRouteLinks(items.filter((r) => r.status === 'pending'), { lat: plan.start_lat, lng: plan.start_lng })
  };
}

function openPlan(userId) {
  return db.prepare('SELECT * FROM plans WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(userId);
}

function num(v) { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; }

app.get('/api/plan/current', auth('vendedor', 'admin'), (req, res) => res.json(planPayload(openPlan(req.user.id))));

app.get('/api/plan/options', auth('vendedor', 'admin'), (req, res) => {
  const st = clientStatuses();
  const zones = {};
  for (const c of st) {
    const z = zones[c.zona] || (zones[c.zona] = { zona: c.zona, total: 0, visitadas: 0, postergadas: 0, disponibles: 0 });
    z.total++;
    if (c.status === 'visitada') z.visitadas++;
    else { z.disponibles++; if (c.status === 'postergada') z.postergadas++; }
  }
  const est = estimates();
  res.json({ zonas: Object.values(zones).sort((a, b) => a.zona.localeCompare(b.zona, 'es')), estimaciones: est });
});

app.post('/api/plan/preview', auth('vendedor', 'admin'), (req, res) => {
  const { zona } = req.body || {};
  const n = Math.max(1, Math.min(30, Number(req.body?.n) || 1));
  const start = { lat: num(req.body?.lat), lng: num(req.body?.lng) };
  const cands = clientStatuses().filter((c) => c.zona === zona && c.status !== 'visitada').map((c) => ({ ...c, postponed: c.status === 'postergada' }));
  const chosen = geo.suggest(cands, n, start.lat != null ? start : null);
  res.json({ minutos: estimateMinutes(chosen, estimates()), cantidad: chosen.length });
});

app.post('/api/plan', auth('vendedor', 'admin'), (req, res) => {
  const { zona } = req.body || {};
  const n = Math.max(1, Math.min(30, Number(req.body?.n) || 1));
  const start = { lat: num(req.body?.lat), lng: num(req.body?.lng), acc: num(req.body?.acc) };
  const now = T.nowISO();
  // Si había una jornada abierta, se cierra sola y lo no visitado vuelve a sugerirse.
  const prev = openPlan(req.user.id);
  const cands = clientStatuses().filter((c) => c.zona === zona && c.status !== 'visitada').map((c) => ({ ...c, postponed: c.status === 'postergada' }));
  if (!cands.length) return res.status(400).json({ error: 'No quedan sucursales por visitar en esa zona este mes.' });
  const chosen = geo.suggest(cands, n, start.lat != null ? start : null);
  if (!chosen.length) return res.status(400).json({ error: 'Las sucursales de esa zona no tienen ubicación válida.' });
  let planId;
  db.transaction(() => {
    if (prev) {
      db.prepare(`UPDATE plans SET ended_at = ?, end_mode = 'auto' WHERE id = ?`).run(now, prev.id);
      db.prepare(`UPDATE plan_items SET status = 'skipped' WHERE plan_id = ? AND status = 'pending'`).run(prev.id);
    }
    planId = db.prepare(`INSERT INTO plans (user_id, zona, n_requested, started_at, start_lat, start_lng, start_acc) VALUES (?,?,?,?,?,?,?)`)
      .run(req.user.id, zona, n, now, start.lat, start.lng, start.acc).lastInsertRowid;
    const ins = db.prepare('INSERT INTO plan_items (plan_id, client_id, position, carried) VALUES (?,?,?,?)');
    chosen.forEach((c, i) => ins.run(planId, c.id, i + 1, c.postponed ? 1 : 0));
  })();
  res.json(planPayload(db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)));
});

app.post('/api/plan/end', auth('vendedor', 'admin'), (req, res) => {
  const plan = openPlan(req.user.id);
  if (!plan) return res.status(400).json({ error: 'No hay una jornada abierta.' });
  const now = T.nowISO();
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE plan_id = ? AND status = 'pending'`).get(plan.id).n;
  db.transaction(() => {
    db.prepare(`UPDATE plans SET ended_at = ?, end_lat = ?, end_lng = ?, end_acc = ?, end_mode = 'manual' WHERE id = ?`)
      .run(now, num(req.body?.lat), num(req.body?.lng), num(req.body?.acc), plan.id);
    db.prepare(`UPDATE plan_items SET status = 'skipped' WHERE plan_id = ? AND status = 'pending'`).run(plan.id);
  })();
  res.json({ ok: true, ended_at: now, devueltas: pending, zona: plan.zona });
});

function ownItem(req, itemId) {
  return db.prepare(`SELECT pi.*, p.user_id, p.ended_at FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.id = ?`).get(itemId);
}

app.post('/api/visits', auth('vendedor', 'admin'), (req, res) => {
  const itemId = Number(req.body?.item_id);
  const result = req.body?.result;
  if (!['si', 'no'].includes(result)) return res.status(400).json({ error: 'Resultado inválido.' });
  const item = ownItem(req, itemId);
  if (!item || item.user_id !== req.user.id) return res.status(404).json({ error: 'No existe esa parada.' });
  if (item.ended_at) return res.status(400).json({ error: 'Esa jornada ya está cerrada.' });
  const existing = db.prepare('SELECT * FROM visits WHERE plan_item_id = ?').get(itemId);
  db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE visits SET result = ? WHERE id = ?').run(result, existing.id);
    } else {
      db.prepare(`INSERT INTO visits (plan_item_id, plan_id, client_id, user_id, result, arrived_at, lat, lng, acc) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(itemId, item.plan_id, item.client_id, req.user.id, result, T.nowISO(), num(req.body?.lat), num(req.body?.lng), num(req.body?.acc));
    }
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
  if (v.result === 'si' && !v.photo_file) return res.status(400).json({ error: 'Falta la foto para guardar una visita SÍ.' });
  const comment = String(req.body?.comment ?? v.comment ?? '').slice(0, 2000);
  db.prepare('UPDATE visits SET comment = ?, saved_at = ? WHERE id = ?').run(comment, T.nowISO(), v.id);
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

// ---------- Visitas (base) ----------
function visitRows(q, role) {
  const where = ['1=1'];
  const p = {};
  if (q.mes && /^\d{4}-\d{2}$/.test(q.mes)) { const [a, b] = T.monthRangeUTC(q.mes); where.push('v.arrived_at >= @a AND v.arrived_at < @b'); p.a = a; p.b = b; }
  if (q.zona) { where.push('c.zona = @zona'); p.zona = q.zona; }
  if (q.resultado === 'si' || q.resultado === 'no') { where.push('v.result = @res'); p.res = q.resultado; }
  const rows = db.prepare(`SELECT v.*, c.empresa, c.nombre, c.direccion, c.zona, c.lat AS c_lat, c.lng AS c_lng, u.username
    FROM visits v JOIN clients c ON c.id = v.client_id JOIN users u ON u.id = v.user_id
    WHERE ${where.join(' AND ')} ORDER BY v.arrived_at DESC LIMIT 5000`).all(p);
  return rows.map((r) => {
    const base = {
      id: r.id, fecha: T.localDateTime(r.arrived_at), arrived_at: r.arrived_at, zona: r.zona, empresa: r.empresa, sucursal: r.nombre, direccion: r.direccion,
      resultado: r.result === 'si' ? 'SÍ' : 'NO', comentario: r.comment, vendedor: r.username,
      foto: r.photo_file ? `/api/photos/${r.photo_file}` : null
    };
    if (role !== 'admin') return base;
    return {
      ...base,
      lat: r.lat, lng: r.lng, precision_m: r.acc != null ? Math.round(r.acc) : null,
      distancia_m: geo.meters({ lat: r.lat, lng: r.lng }, { lat: r.c_lat, lng: r.c_lng }),
      salida: T.localTime(r.saved_at), minutos: T.minutesBetween(r.arrived_at, r.saved_at),
      foto_hora: T.localTime(r.photo_at), foto_lat: r.photo_lat, foto_lng: r.photo_lng,
      foto_distancia_m: geo.meters({ lat: r.photo_lat, lng: r.photo_lng }, { lat: r.c_lat, lng: r.c_lng })
    };
  });
}

app.get('/api/visits', auth(), (req, res) => res.json(visitRows(req.query, req.user.role)));

app.get('/api/visits/export', auth(), async (req, res) => {
  const rows = visitRows(req.query, req.user.role);
  const admin = req.user.role === 'admin';
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Visitas');
  const cols = [
    ['Fecha y hora', 'fecha', 17], ['Zona', 'zona', 14], ['Empresa', 'empresa', 9], ['Sucursal', 'sucursal', 32], ['Dirección', 'direccion', 26],
    ['¿Visita?', 'resultado', 9], ['Comentarios', 'comentario', 40], ['Vendedor', 'vendedor', 12]
  ];
  if (admin) cols.push(['Salida', 'salida', 8], ['Minutos en el local', 'minutos', 10], ['Latitud', 'lat', 11], ['Longitud', 'lng', 11],
    ['Distancia a la sucursal (m)', 'distancia_m', 12], ['Hora foto', 'foto_hora', 9], ['Distancia foto a la sucursal (m)', 'foto_distancia_m', 14]);
  cols.push(['Foto', 'foto', 16]);
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  const base = `${req.protocol}://${req.get('host')}`;
  for (const r of rows) {
    const row = ws.addRow({ ...r, foto: r.foto ? 'Ver foto' : '' });
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

app.get('/api/control', auth('admin'), (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : T.today();
  const userId = Number(req.query.usuario) || db.prepare(`SELECT id FROM users WHERE role='vendedor' ORDER BY id LIMIT 1`).get()?.id;
  const plans = db.prepare(`SELECT * FROM plans WHERE user_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at`)
    .all(userId, T.dayStartUTC(date), T.dayEndUTC(date));
  const events = [], alerts = [];
  let visitMin = 0, travelMin = 0, idleMin = 0, photosOk = 0, photosTotal = 0, nVisits = 0;
  const points = [];
  for (const p of plans) {
    events.push({ tipo: 'inicio', hora: T.localTime(p.started_at), titulo: `Inicio de jornada · ${p.zona}`, detalle: `Armó la recorrida de ${p.n_requested} visitas`, lat: p.start_lat, lng: p.start_lng });
    if (p.start_lat != null) points.push({ lat: p.start_lat, lng: p.start_lng, tipo: 'inicio' });
    else alerts.push(`No se registró la ubicación al iniciar la jornada (${T.localTime(p.started_at)}).`);
    const vs = db.prepare(`SELECT v.*, c.nombre, c.empresa, c.lat AS c_lat, c.lng AS c_lng FROM visits v JOIN clients c ON c.id = v.client_id WHERE v.plan_id = ? ORDER BY v.arrived_at`).all(p.id);
    let prevEnd = p.started_at;
    for (const v of vs) {
      const gap = T.minutesBetween(prevEnd, v.arrived_at);
      if (gap != null && gap > 0) { travelMin += gap; events.push({ tipo: 'traslado', hora: T.localTime(prevEnd), titulo: 'Traslado', detalle: `${gap} min` }); }
      const dur = T.minutesBetween(v.arrived_at, v.saved_at);
      if (dur != null) visitMin += dur;
      nVisits++;
      const dist = geo.meters({ lat: v.lat, lng: v.lng }, { lat: v.c_lat, lng: v.c_lng });
      const photoDist = geo.meters({ lat: v.photo_lat, lng: v.photo_lng }, { lat: v.c_lat, lng: v.c_lng });
      if (v.photo_file) { photosTotal++; if (photoDist != null && photoDist <= 300) photosOk++; }
      if (photoDist != null && photoDist > 300) alerts.push(`${v.nombre}: la foto se sacó a ${fmtDist(photoDist)} de la sucursal (${T.localTime(v.photo_at)}).`);
      if (v.photo_file && photoDist == null) alerts.push(`${v.nombre}: la foto no tiene ubicación registrada.`);
      if (dist != null && dist > 300) alerts.push(`${v.nombre}: marcó la visita a ${fmtDist(dist)} de la sucursal.`);
      if (dist == null) alerts.push(`${v.nombre}: la visita no tiene ubicación registrada.`);
      if (!v.saved_at) alerts.push(`${v.nombre}: marcó ${v.result === 'si' ? 'SÍ' : 'NO'} pero no guardó la visita.`);
      events.push({
        tipo: 'visita', hora: T.localTime(v.arrived_at), titulo: v.nombre, empresa: v.empresa, resultado: v.result === 'si' ? 'SÍ' : 'NO',
        detalle: `Llegada ${T.localTime(v.arrived_at)}${v.saved_at ? ` · salida ${T.localTime(v.saved_at)} · ${dur} min en el local` : ' · sin guardar'}${v.comment ? ` · “${v.comment}”` : ''}`,
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
      if (p.end_mode === 'auto') alerts.push(`No tocó “Terminar jornada”: se cerró sola al armar otra recorrida (${T.localTime(p.ended_at)}). No hay ubicación de cierre.`);
      else if (p.end_lat == null) alerts.push('Terminó la jornada sin ubicación registrada.');
      events.push({ tipo: 'fin', hora: T.localTime(p.ended_at), titulo: 'Fin de jornada', detalle: p.end_mode === 'auto' ? 'Cierre automático (no tocó “Terminar jornada”)' : `Tocó “Terminar jornada”${vs.length && idle > 0 ? ` · ${fmtMin(idle)} desde la última visita` : ''}`, lat: p.end_lat, lng: p.end_lng });
      if (p.end_lat != null) points.push({ lat: p.end_lat, lng: p.end_lng, tipo: 'fin' });
    } else {
      events.push({ tipo: 'abierta', hora: '', titulo: 'Jornada en curso', detalle: 'Todavía no tocó “Terminar jornada”.' });
    }
  }
  const first = plans[0]?.started_at, last = plans.length ? (plans[plans.length - 1].ended_at || null) : null;
  res.json({
    fecha: date, usuario: userId,
    resumen: plans.length ? {
      inicio: T.localTime(first), fin: last ? T.localTime(last) : null,
      jornada_min: last ? T.minutesBetween(first, last) : T.minutesBetween(first, T.nowISO()),
      visitas: nVisits, visitas_min: visitMin, traslados_min: travelMin, sin_actividad_min: idleMin,
      fotos_ok: photosOk, fotos_total: photosTotal
    } : null,
    eventos: events, alertas: alerts, puntos: points, estimaciones: estimates()
  });
});

function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${m} m`; }
function fmtMin(m) { const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; }

// ---------- Páginas ----------
const PUB = path.join(__dirname, 'public');
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
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
if (require.main === module) app.listen(PORT, () => console.log(`Recorridas funcionando en http://localhost:${PORT}`));
module.exports = app;
