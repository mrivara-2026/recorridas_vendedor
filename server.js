'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

// Los módulos pueden estar en lib/ o sueltos junto a server.js (como quedan al subirlos a GitHub desde la web)
const fs = require('fs');
const LIB = fs.existsSync(path.join(__dirname, 'lib', 'db.js')) ? './lib/' : './';
const { db, init: initDb } = require(LIB + 'db');
const fotos = require(LIB + 'fotos');
const geo = require(LIB + 'geo');
const T = require(LIB + 'time');
const X = require(LIB + 'excel');
const { ubicarDireccion } = require(LIB + 'geocode');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin'); // el mapa (OpenStreetMap) exige saber desde qué sitio se pide
  res.set('Permissions-Policy', 'geolocation=(self), camera=(self)');
  next();
});

// Las rutas async: cualquier error va al manejador de errores
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
for (const m of ['get', 'post', 'patch', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (route, ...handlers) => (typeof route === 'string' && handlers.length ? orig(route, ...handlers.map((h) => (h.length === 4 ? h : wrap(h)))) : orig(route, ...handlers));
}

const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});
const uploadSheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------- Sesiones ----------
const COOKIE = 'rec_sesion';
const SESSION_DAYS = 30;

async function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = T.nowISO();
  await db.run('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?,?,?,?)', [token, userId, now, now]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/' });
}

async function currentUser(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const row = await db.get('SELECT u.id, u.username, u.role, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', [token]);
  if (!row) return null;
  const age = Date.now() - new Date(row.last_seen).getTime();
  if (age > SESSION_DAYS * 86400000) { await db.run('DELETE FROM sessions WHERE token = ?', [token]); return null; }
  if (age > 3600000) await db.run('UPDATE sessions SET last_seen = ? WHERE token = ?', [T.nowISO(), token]);
  return { id: row.id, username: row.username, role: row.role };
}

function auth(...roles) {
  return async (req, res, next) => {
    try {
      const u = await currentUser(req);
      if (!u) return res.status(401).json({ error: 'Tenés que ingresar de nuevo.' });
      if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'No tenés permiso para esto.' });
      req.user = u;
      next();
    } catch (e) { next(e); }
  };
}

const failures = new Map();
function tooMany(key) { const f = failures.get(key); return f && f.count >= 8 && Date.now() - f.first < 15 * 60000; }
function fail(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(key, { count: 1, first: Date.now() }); else f.count++;
}

// Para el servicio que mantiene despierto el sistema (cron-job.org): toca la base de datos
app.get('/api/salud', async (req, res) => { await db.get('SELECT 1 AS ok'); res.json({ ok: true }); });

app.post('/api/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const key = username.toLowerCase() + '|' + req.ip;
  if (tooMany(key)) return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' });
  const u = await db.get('SELECT * FROM users WHERE lower(username) = lower(?)', [username]);
  if (!u || !bcrypt.compareSync(password, u.pass_hash)) { fail(key); return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' }); }
  failures.delete(key);
  await createSession(res, req, u.id);
  res.json({ username: u.username, role: u.role });
});

app.post('/api/logout', async (req, res) => {
  const token = req.cookies[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) => res.json(req.user));

app.post('/api/password', auth(), async (req, res) => {
  const { current, next } = req.body || {};
  const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!bcrypt.compareSync(String(current || ''), u.pass_hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
  if (String(next || '').length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
  await db.run('UPDATE users SET pass_hash = ? WHERE id = ?', [bcrypt.hashSync(String(next), 10), u.id]);
  await db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [u.id, req.cookies[COOKIE] || '']);
  res.json({ ok: true });
});

// ---------- Estado mensual de cada sucursal ----------
async function clientStatuses() {
  const ms = T.monthStartUTC();
  const rows = await db.all(`
    SELECT c.*,
      (SELECT MAX(v.arrived_at) FROM visits v WHERE v.client_id = c.id AND v.result = 'si' AND v.arrived_at >= @ms) AS visited_at,
      (SELECT MAX(v.arrived_at) FROM visits v WHERE v.client_id = c.id) AS last_visit_at,
      (SELECT v.result FROM visits v WHERE v.client_id = c.id ORDER BY v.arrived_at DESC LIMIT 1) AS last_result,
      (SELECT pi.status FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.client_id = c.id AND pi.status <> 'pending' ORDER BY p.started_at DESC, pi.id DESC LIMIT 1) AS last_item_status,
      ve.ultima_venta, ve.codigo AS venta_codigo
    FROM clients c LEFT JOIN ventas ve ON ve.codigo = c.codigo AND c.codigo <> ''
    WHERE c.active = 1 ORDER BY lower(c.zona), lower(c.nombre)`, { ms });
  const hayVentas = !!(await db.get('SELECT codigo FROM ventas LIMIT 1'));
  const grupos = await mapaGrupos();
  return rows.map((c) => {
    let status = 'pendiente';
    if (c.visited_at) status = 'visitada';
    else if (c.last_item_status === 'no' || c.last_item_status === 'skipped') status = 'postergada';
    return { ...c, status, urgencia: hayVentas ? urgencia(c) : null };
  }).map((c) => ({ ...c, grupo: grupos.get(X.norm(c.zona)) || c.zona }));
}

// ---------- Zonas de recorrida: barrios cercanos agrupados ----------
async function mapaGrupos() {
  return new Map((await db.all('SELECT barrio, grupo FROM zona_grupos')).map((r) => [r.barrio, r.grupo]));
}

function barriosDe(st) {
  const b = new Map();
  for (const c of st) {
    const k = X.norm(c.zona);
    const e = b.get(k) || { key: k, barrio: c.zona, n: 0, lat: 0, lng: 0, conUbic: 0, grupo: c.grupo };
    e.n++;
    if (c.lat != null) { e.lat += c.lat; e.lng += c.lng; e.conUbic++; }
    b.set(k, e);
  }
  return [...b.values()].map((e) => ({ ...e, lat: e.conUbic ? e.lat / e.conUbic : null, lng: e.conUbic ? e.lng / e.conUbic : null }));
}

function nombreGrupo(miembros) {
  const m = [...miembros].sort((a, b) => b.n - a.n || a.barrio.localeCompare(b.barrio, 'es'));
  const tops = m.slice(0, 3).map((x) => x.barrio);
  return tops.join(' · ') + (m.length > 3 ? ` +${m.length - 3}` : '');
}

// Junta barrios cuyo centro está a menos de km entre sí (agrupamiento jerárquico, sin grupos estirados)
function agrupar(barrios, km) {
  let cl = barrios.filter((b) => b.lat != null).map((b) => ({ m: [b], lat: b.lat, lng: b.lng, n: b.n }));
  const diam = (a, b) => Math.max(...a.m.flatMap((x) => b.m.map((y) => geo.km(x, y))));
  for (;;) {
    let best = null;
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
      const d = geo.km(cl[i], cl[j]);
      if (d <= km && diam(cl[i], cl[j]) <= km * 1.6 && (!best || d < best.d)) best = { i, j, d };
    }
    if (!best) break;
    const a = cl[best.i], b = cl[best.j], n = a.n + b.n;
    const nuevo = { m: [...a.m, ...b.m], n, lat: (a.lat * a.n + b.lat * b.n) / n, lng: (a.lng * a.n + b.lng * b.n) / n };
    cl = cl.filter((_, k) => k !== best.i && k !== best.j).concat([nuevo]);
  }
  const sinUbic = barrios.filter((b) => b.lat == null).map((b) => ({ m: [b] }));
  return [...cl, ...sinUbic].map((c) => ({ grupo: nombreGrupo(c.m), barrios: c.m }));
}

app.get('/api/grupos', auth(), async (req, res) => {
  const bs = barriosDe(await clientStatuses());
  const g = new Map();
  for (const b of bs) { const e = g.get(b.grupo) || { grupo: b.grupo, n: 0, barrios: [] }; e.n += b.n; e.barrios.push({ barrio: b.barrio, n: b.n }); g.set(b.grupo, e); }
  res.json({ grupos: [...g.values()].sort((a, b) => a.grupo.localeCompare(b.grupo, 'es')), agrupado: !!(await db.get('SELECT barrio FROM zona_grupos LIMIT 1')) });
});

app.post('/api/grupos/auto', auth(), async (req, res) => {
  const km = Math.max(0.5, Math.min(30, Number(req.body?.km) || 3));
  const gs = agrupar(barriosDe(await clientStatuses()), km);
  await db.tx(async (t) => {
    await t.run('DELETE FROM zona_grupos');
    for (const g of gs) for (const b of g.barrios) if (g.barrios.length > 1) await t.run('INSERT INTO zona_grupos (barrio, grupo) VALUES (?, ?)', [b.key, g.grupo]);
  });
  res.json({ zonas: gs.length, agrupadas: gs.filter((g) => g.barrios.length > 1).length });
});

app.post('/api/grupos/mover', auth(), async (req, res) => {
  const barrio = String(req.body?.barrio || '').trim();
  const grupo = String(req.body?.grupo || '').trim();
  if (!barrio) return res.status(400).json({ error: 'Falta el barrio.' });
  const antes = await db.get('SELECT grupo FROM zona_grupos WHERE barrio = ?', [X.norm(barrio)]);
  await db.run('DELETE FROM zona_grupos WHERE barrio = ?', [X.norm(barrio)]);
  if (grupo && X.norm(grupo) !== X.norm(barrio)) {
    // si la zona destino era un barrio solo (sin agrupar), ese barrio pasa a formar parte de la zona
    const solo = await db.get('SELECT barrio FROM zona_grupos WHERE grupo = ?', [grupo]);
    if (!solo) await db.run('INSERT INTO zona_grupos (barrio, grupo) VALUES (?, ?) ON CONFLICT (barrio) DO NOTHING', [X.norm(grupo), grupo]);
    await db.run('INSERT INTO zona_grupos (barrio, grupo) VALUES (?, ?)', [X.norm(barrio), grupo]);
  }
  // si la zona de origen quedó con un solo barrio y tenía nombre automático ("A · B"), vuelve a llamarse como el barrio
  if (antes) {
    const resto = await db.all('SELECT barrio FROM zona_grupos WHERE grupo = ?', [antes.grupo]);
    if (resto.length === 1 && antes.grupo.includes(' · ')) await db.run('DELETE FROM zona_grupos WHERE grupo = ?', [antes.grupo]);
  }
  res.json({ ok: true });
});

app.post('/api/grupos/renombrar', auth(), async (req, res) => {
  const de = String(req.body?.de || '').trim(), a = String(req.body?.a || '').trim();
  if (!de || !a) return res.status(400).json({ error: 'El nombre de la zona no puede quedar vacío.' });
  const r = await db.run('UPDATE zona_grupos SET grupo = ? WHERE grupo = ?', [a, de]);
  if (!r.changes) await db.run('INSERT INTO zona_grupos (barrio, grupo) VALUES (?, ?) ON CONFLICT (barrio) DO UPDATE SET grupo = excluded.grupo', [X.norm(de), a]);
  res.json({ ok: true });
});

// Urgencia de venta (Disco, Devoto, Geant): días desde la última factura de esa sucursal
const URG_ALTA = Number(process.env.URGENCIA_ALTA_DIAS || 45);
const URG_MEDIA = Number(process.env.URGENCIA_MEDIA_DIAS || 30);
function urgencia(c) {
  if (!c.codigo) return null;
  if (!c.venta_codigo) return { nivel: 'alta', dias: null, texto: 'Sin ventas registradas' };
  const dias = Math.floor((new Date(T.today() + 'T00:00:00Z') - new Date(c.ultima_venta + 'T00:00:00Z')) / 86400000);
  const nivel = dias >= URG_ALTA ? 'alta' : dias >= URG_MEDIA ? 'media' : null;
  return { nivel, dias, ultima: c.ultima_venta, texto: `Sin ventas hace ${dias} días` };
}

function publicClient(c) {
  return { id: c.id, empresa: c.empresa, nombre: c.nombre, direccion: c.direccion, zona: c.zona, horario: c.horario, link: c.link, codigo: c.codigo || '', geo_fuente: c.geo_fuente || 'link', lat: c.lat, lng: c.lng };
}
function limpiarCodigo(v) { return String(v ?? '').toUpperCase().replace(/\s+/g, ''); }

// ---------- Clientes ----------
app.get('/api/clients', auth(), async (req, res) => {
  const st = await clientStatuses();
  res.json(st.map((c) => ({ ...publicClient(c), status: c.status, visited_at: c.visited_at, last_visit_at: c.last_visit_at, urgencia: c.urgencia })));
});

const FIELDS = ['empresa', 'nombre', 'direccion', 'zona', 'horario', 'link', 'codigo'];

async function findDuplicate(rec, exceptId) {
  const all = await db.all('SELECT * FROM clients WHERE active = 1 AND id <> ?', [exceptId || 0]);
  return all.find((c) => (rec.codigo && c.codigo === rec.codigo) ||
    (c.lat != null && rec.lat != null && (c.geo_fuente || 'link') === 'link' && (rec.geo_fuente || 'link') === 'link' && geo.meters(c, rec) <= 15) ||
    (X.norm(c.nombre) === X.norm(rec.nombre) && X.norm(rec.direccion) !== '' && X.norm(c.direccion) === X.norm(rec.direccion)));
}

const INSERT_CLIENT = 'INSERT INTO clients (empresa,nombre,direccion,zona,horario,link,codigo,geo_fuente,lat,lng,active,created_at,updated_at) VALUES (@empresa,@nombre,@direccion,@zona,@horario,@link,@codigo,@geo_fuente,@lat,@lng,1,@now,@now)';
const UPDATE_CLIENT = 'UPDATE clients SET empresa=@empresa,nombre=@nombre,direccion=@direccion,zona=@zona,horario=@horario,link=@link,codigo=@codigo,geo_fuente=@geo_fuente,lat=@lat,lng=@lng,active=1,updated_at=@now WHERE id=@id';
function clientParams(r, now, id) {
  const p = { empresa: r.empresa, nombre: r.nombre, direccion: r.direccion || '', zona: r.zona, horario: r.horario || '', link: r.link || '', codigo: limpiarCodigo(r.codigo), geo_fuente: r.geo_fuente || 'link', lat: r.lat, lng: r.lng, now };
  if (id !== undefined) p.id = id;
  return p;
}

app.post('/api/clients', auth(), async (req, res) => {
  const b = req.body || {};
  const rec = {
    empresa: String(b.empresa || '').toUpperCase().trim(), nombre: String(b.nombre || '').trim(), direccion: String(b.direccion || '').trim(),
    zona: String(b.zona || '').trim(), horario: X.cleanHorario(b.horario), link: String(b.link || '').trim(), codigo: limpiarCodigo(b.codigo)
  };
  if (!['BEC', 'MAN'].includes(rec.empresa)) return res.status(400).json({ error: 'Empresa debe ser BEC o MAN.' });
  if (!rec.nombre) return res.status(400).json({ error: 'Falta el nombre.' });
  if (!rec.zona) return res.status(400).json({ error: 'Falta la zona.' });
  if (!rec.link && !rec.direccion) return res.status(400).json({ error: 'Falta la dirección o el link de Google Maps.' });
  if (rec.link) {
    const c = await geo.resolveLink(rec.link);
    if (!c) return res.status(400).json({ error: 'No se pudo leer la ubicación del link de Maps. Copiá el link desde Maps → Compartir.' });
    Object.assign(rec, c, { geo_fuente: 'link' });
  } else {
    const u = await ubicarDireccion(rec.direccion, rec.zona);
    if (!u) return res.status(400).json({ error: 'No se encontró esa dirección en el mapa. Agregá el link de Google Maps.' });
    Object.assign(rec, { lat: u.lat, lng: u.lng, geo_fuente: u.fuente });
  }
  const dup = await findDuplicate(rec);
  if (dup) return res.status(409).json({ error: rec.codigo && dup.codigo === rec.codigo ? `El código ${rec.codigo} ya está asignado a "${dup.nombre}".` : `Esta sucursal ya está cargada como "${dup.nombre}" (${dup.zona}).`, id: dup.id });
  const r = await db.run(INSERT_CLIENT, clientParams(rec, T.nowISO()));
  res.json({ id: r.id });
});

app.patch('/api/clients/:id', auth(), async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM clients WHERE id = ? AND active = 1', [id]);
  if (!cur) return res.status(404).json({ error: 'No existe esa sucursal.' });
  const upd = { ...cur };
  for (const f of FIELDS) if (req.body && f in req.body) upd[f] = String(req.body[f] ?? '').trim();
  upd.empresa = upd.empresa.toUpperCase();
  upd.horario = X.cleanHorario(upd.horario);
  upd.codigo = limpiarCodigo(upd.codigo);
  if (!['BEC', 'MAN'].includes(upd.empresa)) return res.status(400).json({ error: 'Empresa debe ser BEC o MAN.' });
  if (!upd.nombre) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
  if (!upd.zona) return res.status(400).json({ error: 'La zona no puede quedar vacía.' });
  if (upd.link && upd.link !== cur.link) {
    const c = await geo.resolveLink(upd.link);
    if (!c) return res.status(400).json({ error: 'No se pudo leer la ubicación del link de Maps.' });
    upd.lat = c.lat; upd.lng = c.lng; upd.geo_fuente = 'link';
  } else if (!upd.link && (cur.link || upd.direccion !== cur.direccion || upd.zona !== cur.zona || cur.geo_fuente !== 'link')) {
    // sin link: se ubica por dirección (al borrar el link o al cambiar la dirección de una ubicada por dirección)
    if (!upd.direccion) return res.status(400).json({ error: 'Sin link de Maps hace falta la dirección.' });
    if (cur.link || upd.direccion !== cur.direccion || upd.zona !== cur.zona) {
      const u = await ubicarDireccion(upd.direccion, upd.zona);
      if (!u) return res.status(400).json({ error: 'No se encontró esa dirección en el mapa. Agregá el link de Google Maps.' });
      upd.lat = u.lat; upd.lng = u.lng; upd.geo_fuente = u.fuente;
    }
  }
  const dup = await findDuplicate(upd, id);
  if (dup) return res.status(409).json({ error: upd.codigo && dup.codigo === upd.codigo ? `El código ${upd.codigo} ya está asignado a "${dup.nombre}".` : `Quedaría igual a "${dup.nombre}" (${dup.zona}), que ya está cargada.` });
  await db.run(UPDATE_CLIENT, clientParams(upd, T.nowISO(), id));
  res.json({ ok: true, client: publicClient(upd) });
});

app.delete('/api/clients/:id', auth(), async (req, res) => {
  const r = await db.run('UPDATE clients SET active = 0, updated_at = ? WHERE id = ? AND active = 1', [T.nowISO(), Number(req.params.id)]);
  if (!r.changes) return res.status(404).json({ error: 'No existe esa sucursal.' });
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
  const existing = await db.all('SELECT * FROM clients');
  const result = await X.analyze(rows, existing, ubicarDireccion);
  const token = crypto.randomBytes(16).toString('hex');
  pendingImports.set(token, { userId: req.user.id, at: Date.now(), result });
  for (const [k, v] of pendingImports) if (Date.now() - v.at > 30 * 60000) pendingImports.delete(k);
  const brief = (r) => ({ fila: r.fila, empresa: r.empresa, nombre: r.nombre, direccion: r.direccion, zona: r.zona, cambios: r.cambios, parecido: r.parecido, reactivar: r.reactivar });
  res.json({
    token, archivo: req.file.originalname,
    nuevas: result.nuevas.map(brief), actualizadas: result.actualizadas.map(brief), sinCambios: result.sinCambios.length,
    posibles: result.posibles.map(brief), errores: result.errores, repetidasArchivo: result.repetidasArchivo, aprox: result.aprox
  });
});

app.post('/api/clients/import/confirm', auth(), async (req, res) => {
  const { token, incluirPosibles } = req.body || {};
  const p = pendingImports.get(token);
  if (!p || p.userId !== req.user.id) return res.status(400).json({ error: 'La vista previa venció. Subí el archivo de nuevo.' });
  pendingImports.delete(token);
  const include = new Set((incluirPosibles || []).map(Number));
  const now = T.nowISO();
  const out = await db.tx(async (t) => {
    let agregadas = 0, actualizadas = 0;
    for (const r of p.result.nuevas) { await t.run(INSERT_CLIENT, clientParams(r, now)); agregadas++; }
    for (const r of p.result.posibles) if (include.has(r.fila)) { await t.run(INSERT_CLIENT, clientParams(r, now)); agregadas++; }
    for (const r of p.result.actualizadas) { await t.run(UPDATE_CLIENT, clientParams(r, now, r.id)); actualizadas++; }
    return { agregadas, actualizadas };
  });
  res.json(out);
});

app.get('/api/clients/template', auth(), async (req, res) => {
  const wb = await X.templateWorkbook();
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="plantilla_clientes_recorridas.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// ---------- Planilla de ventas (Disco, Devoto, Geant) ----------
const CADENA_CLAVE = { Disco: 'disco', Devoto: 'devoto', Geant: 'geant' };

async function resumenVentas() {
  const act = await db.get(`SELECT valor FROM ajustes WHERE clave = 'ventas_actualizado'`);
  const arch = await db.get(`SELECT valor FROM ajustes WHERE clave = 'ventas_archivo'`);
  const ventas = await db.all('SELECT * FROM ventas ORDER BY ultima_venta');
  const usados = new Set((await db.all(`SELECT codigo FROM clients WHERE active = 1 AND codigo <> ''`)).map((r) => r.codigo));
  const hoy = new Date(T.today() + 'T00:00:00Z');
  const dias = (f) => Math.floor((hoy - new Date(f + 'T00:00:00Z')) / 86400000);
  return {
    actualizado: act?.valor || null, archivo: arch?.valor || null, total: ventas.length, vinculadas: ventas.filter((v) => usados.has(v.codigo)).length,
    sin_vincular: ventas.filter((v) => !usados.has(v.codigo)).map((v) => ({ codigo: v.codigo, cadena: v.cadena, nombre: v.nombre, ultima: v.ultima_venta, dias: dias(v.ultima_venta) }))
  };
}

app.get('/api/ventas', auth('admin'), async (req, res) => res.json(await resumenVentas()));

app.post('/api/ventas', auth('admin'), uploadSheet.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Elegí la planilla de ventas (.xlsx).' });
  let data;
  try { data = await X.readVentas(req.file.buffer); }
  catch (e) { return res.status(400).json({ error: e.message && e.message.length < 300 ? e.message : 'No se pudo leer la planilla.' }); }
  const now = T.nowISO();
  // Vinculación automática por nombre: "Disco Lostorto" ↔ sucursal LOSTORTO de Disco (solo si no hay dudas)
  const clientes = await db.all(`SELECT id, nombre, codigo FROM clients WHERE active = 1 AND empresa = 'MAN'`);
  const usados = new Set(clientes.filter((c) => c.codigo).map((c) => c.codigo));
  const libres = clientes.filter((c) => !c.codigo);
  const propuestas = new Map(); // cliente -> [sucursales]
  const porSucursal = new Map();
  for (const v of data.sucursales) {
    if (usados.has(v.codigo)) continue;
    const nom = X.norm(v.nombre).replace(/^(disco|devoto|geant)\s+/, '');
    if (nom.length < 4) continue;
    const cands = libres.filter((c) => { const n = X.norm(c.nombre); return n.includes(CADENA_CLAVE[v.cadena]) && (` ${n} `).includes(` ${nom} `); });
    porSucursal.set(v.codigo, cands);
    for (const c of cands) propuestas.set(c.id, [...(propuestas.get(c.id) || []), v.codigo]);
  }
  const auto = [];
  for (const [codigo, cands] of porSucursal) {
    if (cands.length === 1 && propuestas.get(cands[0].id).length === 1) auto.push({ id: cands[0].id, nombre: cands[0].nombre, codigo });
  }
  await db.tx(async (t) => {
    await t.run('DELETE FROM ventas');
    for (const v of data.sucursales) {
      await t.run('INSERT INTO ventas (codigo, cadena, nombre, ultima_venta, facturas, actualizado) VALUES (?,?,?,?,?,?)', [v.codigo, v.cadena, v.nombre, v.ultima, v.facturas, now]);
    }
    for (const a of auto) await t.run('UPDATE clients SET codigo = ?, updated_at = ? WHERE id = ?', [a.codigo, now, a.id]);
    for (const [k, val] of [['ventas_actualizado', now], ['ventas_archivo', req.file.originalname]]) {
      await t.run('DELETE FROM ajustes WHERE clave = ?', [k]);
      await t.run('INSERT INTO ajustes (clave, valor) VALUES (?, ?)', [k, val]);
    }
  });
  const porCadena = {};
  for (const v of data.sucursales) porCadena[v.cadena] = (porCadena[v.cadena] || 0) + 1;
  const st = await clientStatuses();
  res.json({ ...(await resumenVentas()), porCadena, autoVinculadas: auto, urgentes: st.filter((c) => c.urgencia?.nivel && c.status !== 'visitada').length });
});

// ---------- Zonas ----------
app.get('/api/zones', auth(), async (req, res) => {
  const st = await clientStatuses();
  const zones = {};
  for (const c of st) {
    const z = zones[c.grupo] || (zones[c.grupo] = { zona: c.grupo, total: 0, visitadas: 0, postergadas: 0, pendientes: 0, urgentes: 0 });
    z.total++;
    if (c.status === 'visitada') z.visitadas++; else if (c.status === 'postergada') z.postergadas++; else z.pendientes++;
    if (c.status !== 'visitada' && c.urgencia?.nivel) z.urgentes++;
  }
  res.json({
    mes: T.currentMonth(),
    zonas: Object.values(zones).sort((a, b) => a.zona.localeCompare(b.zona, 'es')),
    sucursales: st.map((c) => ({ ...publicClient(c), grupo: c.grupo, status: c.status, visited_at: c.visited_at, last_visit_at: c.last_visit_at, last_result: c.last_result, urgencia: c.urgencia }))
  });
});

// ---------- Estimaciones de tiempo ----------
async function estimates() {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = await db.all(`SELECT c.empresa, v.arrived_at, v.saved_at FROM visits v JOIN clients c ON c.id = v.client_id WHERE v.result='si' AND v.saved_at IS NOT NULL AND v.arrived_at >= ?`, [since]);
  const out = { BEC: { min: 15, n: 0 }, MAN: { min: 30, n: 0 }, traslado: { min: 12, n: 0 } };
  for (const emp of ['BEC', 'MAN']) {
    const d = rows.filter((r) => r.empresa === emp).map((r) => T.minutesBetween(r.arrived_at, r.saved_at)).filter((m) => m >= 1 && m <= 240);
    if (d.length) out[emp] = { min: Math.round(d.reduce((a, b) => a + b, 0) / d.length), n: d.length };
  }
  const vs = await db.all('SELECT v.plan_id, v.arrived_at, v.saved_at FROM visits v JOIN plans p ON p.id = v.plan_id WHERE p.started_at >= ? ORDER BY v.plan_id, v.arrived_at', [since]);
  const gaps = [];
  for (let i = 1; i < vs.length; i++) {
    if (vs[i].plan_id !== vs[i - 1].plan_id) continue;
    const g = T.minutesBetween(vs[i - 1].saved_at || vs[i - 1].arrived_at, vs[i].arrived_at);
    if (g >= 1 && g <= 120) gaps.push(g);
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

async function planPayload(plan) {
  if (!plan) return { plan: null };
  const urg = new Map((await clientStatuses()).map((c) => [c.id, c.urgencia]));
  const items = await db.all(`SELECT pi.id AS item_id, pi.position, pi.carried, pi.status, c.*,
      v.id AS visit_id, v.arrived_at, v.saved_at, v.comment, v.photo_file, v.photo_at, v.lat AS v_lat, v.lng AS v_lng
    FROM plan_items pi JOIN clients c ON c.id = pi.client_id LEFT JOIN visits v ON v.plan_item_id = pi.id
    WHERE pi.plan_id = ? ORDER BY pi.position`, [plan.id]);
  return {
    plan: { id: plan.id, zona: plan.zona, started_at: plan.started_at, start_lat: plan.start_lat, start_lng: plan.start_lng },
    items: items.map((r) => ({
      item_id: r.item_id, position: r.position, carried: !!r.carried, status: r.status,
      client: publicClient(r), urgencia: urg.get(r.id) || null,
      visit: r.visit_id ? {
        id: r.visit_id, arrived_at: r.arrived_at, saved_at: r.saved_at, comment: r.comment, lat: r.v_lat, lng: r.v_lng,
        has_photo: !!r.photo_file, photo_at: r.photo_at, photo_url: r.photo_file ? `/api/photos/${r.photo_file}` : null
      } : null
    })),
    rutas: mapsRouteLinks(items.filter((r) => r.status === 'pending'), { lat: plan.start_lat, lng: plan.start_lng })
  };
}

function openPlan(userId) {
  return db.get('SELECT * FROM plans WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [userId]);
}

function num(v) { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n; }

async function candidatesFor(zona) {
  return (await clientStatuses()).filter((c) => c.grupo === zona && c.status !== 'visitada')
    .map((c) => ({ ...c, postponed: c.status === 'postergada', urgent: !!c.urgencia?.nivel, urgentDays: c.urgencia ? (c.urgencia.dias ?? 99999) : 0 }));
}

app.get('/api/plan/current', auth('vendedor', 'admin'), async (req, res) => res.json(await planPayload(await openPlan(req.user.id))));

app.get('/api/plan/options', auth('vendedor', 'admin'), async (req, res) => {
  const st = await clientStatuses();
  const zones = {};
  for (const c of st) {
    const z = zones[c.grupo] || (zones[c.grupo] = { zona: c.grupo, total: 0, visitadas: 0, postergadas: 0, disponibles: 0, urgentes: 0 });
    z.total++;
    if (c.status === 'visitada') z.visitadas++;
    else { z.disponibles++; if (c.status === 'postergada') z.postergadas++; if (c.urgencia?.nivel) z.urgentes++; }
  }
  res.json({ zonas: Object.values(zones).sort((a, b) => a.zona.localeCompare(b.zona, 'es')), estimaciones: await estimates() });
});

app.post('/api/plan/preview', auth('vendedor', 'admin'), async (req, res) => {
  const n = Math.max(1, Math.min(30, Number(req.body?.n) || 1));
  const start = { lat: num(req.body?.lat), lng: num(req.body?.lng) };
  const chosen = geo.suggest(await candidatesFor(req.body?.zona), n, start.lat != null ? start : null);
  res.json({ minutos: estimateMinutes(chosen, await estimates()), cantidad: chosen.length });
});

app.post('/api/plan', auth('vendedor', 'admin'), async (req, res) => {
  const zona = req.body?.zona;
  const n = Math.max(1, Math.min(30, Number(req.body?.n) || 1));
  const start = { lat: num(req.body?.lat), lng: num(req.body?.lng), acc: num(req.body?.acc) };
  const now = T.nowISO();
  const prev = await openPlan(req.user.id);
  const cands = await candidatesFor(zona);
  if (!cands.length) return res.status(400).json({ error: 'No quedan sucursales por visitar en esa zona este mes.' });
  const chosen = geo.suggest(cands, n, start.lat != null ? start : null);
  if (!chosen.length) return res.status(400).json({ error: 'Las sucursales de esa zona no tienen ubicación válida.' });
  const planId = await db.tx(async (t) => {
    // Si había una jornada abierta, se cierra sola y lo no visitado vuelve a sugerirse.
    if (prev) {
      await t.run(`UPDATE plans SET ended_at = ?, end_mode = 'auto' WHERE id = ?`, [now, prev.id]);
      await t.run(`UPDATE plan_items SET status = 'skipped' WHERE plan_id = ? AND status = 'pending'`, [prev.id]);
    }
    const r = await t.run('INSERT INTO plans (user_id, zona, n_requested, started_at, start_lat, start_lng, start_acc) VALUES (?,?,?,?,?,?,?)',
      [req.user.id, zona, n, now, start.lat, start.lng, start.acc]);
    for (let i = 0; i < chosen.length; i++) {
      await t.run('INSERT INTO plan_items (plan_id, client_id, position, carried) VALUES (?,?,?,?)', [r.id, chosen[i].id, i + 1, chosen[i].postponed ? 1 : 0]);
    }
    return r.id;
  });
  res.json(await planPayload(await db.get('SELECT * FROM plans WHERE id = ?', [planId])));
});

app.post('/api/plan/end', auth('vendedor', 'admin'), async (req, res) => {
  const plan = await openPlan(req.user.id);
  if (!plan) return res.status(400).json({ error: 'No hay una jornada abierta.' });
  const now = T.nowISO();
  const { n: pending } = await db.get(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM plan_items WHERE plan_id = ? AND status = 'pending'`, [plan.id]);
  await db.tx(async (t) => {
    await t.run(`UPDATE plans SET ended_at = ?, end_lat = ?, end_lng = ?, end_acc = ?, end_mode = 'manual' WHERE id = ?`,
      [now, num(req.body?.lat), num(req.body?.lng), num(req.body?.acc), plan.id]);
    await t.run(`UPDATE plan_items SET status = 'skipped' WHERE plan_id = ? AND status = 'pending'`, [plan.id]);
  });
  res.json({ ok: true, ended_at: now, devueltas: pending, zona: plan.zona });
});

app.post('/api/visits', auth('vendedor', 'admin'), async (req, res) => {
  const itemId = Number(req.body?.item_id);
  const result = req.body?.result;
  if (!['si', 'no'].includes(result)) return res.status(400).json({ error: 'Resultado inválido.' });
  const item = await db.get('SELECT pi.*, p.user_id, p.ended_at FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.id = ?', [itemId]);
  if (!item || item.user_id !== req.user.id) return res.status(404).json({ error: 'No existe esa parada.' });
  if (item.ended_at) return res.status(400).json({ error: 'Esa jornada ya está cerrada.' });
  await db.tx(async (t) => {
    const existing = await t.get('SELECT id FROM visits WHERE plan_item_id = ?', [itemId]);
    if (existing) await t.run('UPDATE visits SET result = ? WHERE id = ?', [result, existing.id]);
    else {
      await t.run('INSERT INTO visits (plan_item_id, plan_id, client_id, user_id, result, arrived_at, lat, lng, acc) VALUES (?,?,?,?,?,?,?,?,?)',
        [itemId, item.plan_id, item.client_id, req.user.id, result, T.nowISO(), num(req.body?.lat), num(req.body?.lng), num(req.body?.acc)]);
    }
    await t.run('UPDATE plan_items SET status = ? WHERE id = ?', [result, itemId]);
  });
  res.json(await db.get('SELECT id, result, arrived_at, lat, lng FROM visits WHERE plan_item_id = ?', [itemId]));
});

async function ownVisit(req, id) {
  const v = await db.get('SELECT v.*, p.ended_at FROM visits v JOIN plans p ON p.id = v.plan_id WHERE v.id = ?', [id]);
  if (!v || v.user_id !== req.user.id) return null;
  return v;
}

app.post('/api/visits/:id/photo', auth('vendedor', 'admin'), uploadPhoto.single('foto'), async (req, res) => {
  const v = await ownVisit(req, Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'No existe esa visita.' });
  if (v.ended_at) return res.status(400).json({ error: 'Esa jornada ya está cerrada.' });
  if (!req.file) return res.status(400).json({ error: 'No llegó ninguna foto.' });
  const name = `v${v.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  await fotos.guardar(name, req.file.buffer);
  if (v.photo_file) fotos.borrar(path.basename(v.photo_file));
  const now = T.nowISO();
  await db.run('UPDATE visits SET photo_file = ?, photo_at = ?, photo_lat = ?, photo_lng = ?, photo_acc = ? WHERE id = ?',
    [name, now, num(req.body?.lat), num(req.body?.lng), num(req.body?.acc), v.id]);
  res.json({ ok: true, photo_at: now });
});

app.patch('/api/visits/:id', auth('vendedor', 'admin'), async (req, res) => {
  const v = await ownVisit(req, Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'No existe esa visita.' });
  if (v.ended_at) return res.status(400).json({ error: 'Esa jornada ya está cerrada.' });
  if (v.result === 'si' && !v.photo_file) return res.status(400).json({ error: 'Falta la foto para guardar una visita SÍ.' });
  const comment = String(req.body?.comment ?? v.comment ?? '').slice(0, 2000);
  await db.run('UPDATE visits SET comment = ?, saved_at = ? WHERE id = ?', [comment, T.nowISO(), v.id]);
  res.json({ ok: true });
});

app.get('/api/photos/:file', auth(), async (req, res) => {
  const name = path.basename(req.params.file);
  const row = await db.get('SELECT user_id FROM visits WHERE photo_file = ?', [name]);
  if (!row) return res.status(404).end();
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).end();
  res.set('Cache-Control', 'private, max-age=86400');
  await fotos.enviar(name, res);
});

// ---------- Visitas (base) ----------
async function visitRows(q, role) {
  const where = ['1=1'];
  const p = {};
  if (q.mes && /^\d{4}-\d{2}$/.test(q.mes)) { const [a, b] = T.monthRangeUTC(q.mes); where.push('v.arrived_at >= @a AND v.arrived_at < @b'); p.a = a; p.b = b; }

  if (q.resultado === 'si' || q.resultado === 'no') { where.push('v.result = @res'); p.res = q.resultado; }
  const rows = await db.all(`SELECT v.*, c.empresa, c.nombre, c.direccion, c.zona, c.lat AS c_lat, c.lng AS c_lng, u.username
    FROM visits v JOIN clients c ON c.id = v.client_id JOIN users u ON u.id = v.user_id
    WHERE ${where.join(' AND ')} ORDER BY v.arrived_at DESC LIMIT 5000`, p);
  const grupos = await mapaGrupos();
  return rows.map((r) => ({ ...r, grupo: grupos.get(X.norm(r.zona)) || r.zona })).filter((r) => !q.zona || r.grupo === q.zona).map((r) => {
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

app.get('/api/visits', auth(), async (req, res) => res.json(await visitRows(req.query, req.user.role)));

app.get('/api/visits/export', auth(), async (req, res) => {
  const rows = await visitRows(req.query, req.user.role);
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
app.get('/api/users', auth('admin'), async (req, res) => {
  res.json(await db.all('SELECT id, username, role FROM users ORDER BY role DESC, username'));
});

app.get('/api/estimates', auth('admin'), async (req, res) => res.json(await estimates()));

function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${m} m`; }
function fmtMin(m) { const h = Math.floor(m / 60); return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; }

app.get('/api/control', auth('admin'), async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '') ? req.query.fecha : T.today();
  const userId = Number(req.query.usuario) || (await db.get(`SELECT id FROM users WHERE role='vendedor' ORDER BY id LIMIT 1`))?.id;
  const plans = await db.all('SELECT * FROM plans WHERE user_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at', [userId, T.dayStartUTC(date), T.dayEndUTC(date)]);
  const events = [], alerts = [], points = [];
  let visitMin = 0, travelMin = 0, idleMin = 0, photosOk = 0, photosTotal = 0, nVisits = 0;
  for (const p of plans) {
    events.push({ tipo: 'inicio', hora: T.localTime(p.started_at), titulo: `Inicio de jornada · ${p.zona}`, detalle: `Armó la recorrida de ${p.n_requested} visitas`, lat: p.start_lat, lng: p.start_lng });
    if (p.start_lat != null) points.push({ lat: p.start_lat, lng: p.start_lng, tipo: 'inicio' });
    else alerts.push(`No se registró la ubicación al iniciar la jornada (${T.localTime(p.started_at)}).`);
    const vs = await db.all('SELECT v.*, c.nombre, c.empresa, c.lat AS c_lat, c.lng AS c_lng FROM visits v JOIN clients c ON c.id = v.client_id WHERE v.plan_id = ? ORDER BY v.arrived_at', [p.id]);
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
    eventos: events, alertas: alerts, puntos: points, estimaciones: await estimates()
  });
});

// ---------- Páginas ----------
const PUB = fs.existsSync(path.join(__dirname, 'public', 'app.html')) ? path.join(__dirname, 'public') : __dirname;
const PUBLICOS = new Set(['app.html', 'app.js', 'comun.js', 'estilos.css', 'login.html', 'panel.html', 'panel.js', 'icono.svg', 'manifest.webmanifest']);
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
// Solo se sirven los archivos de la interfaz, nunca el resto del código
app.get('/:archivo', (req, res, next) => (PUBLICOS.has(req.params.archivo) ? res.sendFile(path.join(PUB, req.params.archivo), { maxAge: '1h' }) : next()));
const page = (file) => (req, res) => res.sendFile(path.join(PUB, file));
app.get('/', async (req, res) => {
  const u = await currentUser(req);
  if (!u) return res.redirect('/ingresar');
  const mobile = /Mobi|Android|iPhone/i.test(req.get('user-agent') || '');
  res.redirect(u.role === 'vendedor' && mobile ? '/app' : '/panel');
});
app.get('/ingresar', page('login.html'));
app.get('/app', async (req, res, next) => ((await currentUser(req)) ? next() : res.redirect('/ingresar?a=app')), page('app.html'));
app.get('/panel', async (req, res, next) => ((await currentUser(req)) ? next() : res.redirect('/ingresar')), page('panel.html'));

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo es demasiado grande.' : 'No se pudo subir el archivo.' });
  res.status(500).json({ error: 'Ocurrió un error. Probá de nuevo.' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  Promise.all([initDb(), fotos.init()])
    .then(() => app.listen(PORT, () => console.log(`Recorridas funcionando en http://localhost:${PORT} (base: ${db.kind}, fotos: ${fotos.REMOTE ? 'Supabase' : 'disco'})`)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = app;
