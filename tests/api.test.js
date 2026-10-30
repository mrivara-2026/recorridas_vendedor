'use strict';
// Prueba de punta a punta de la API: base vacía, planilla de comercios y de ventas inventadas,
// semana armada por el administrador, jornada del vendedor, urgencia y dashboard.
// Uso:  npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'visitas-test-'));
const PORT = 4300 + Math.floor(Math.random() * 500);
const GPORT = PORT + 1;
const B = `http://127.0.0.1:${PORT}`;
let srv, geoSrv;

function hoy() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function cliente() {
  let cookie = '';
  return async (p, opts = {}) => {
    const o = { headers: { cookie, ...(opts.headers || {}) }, method: opts.method || (opts.json || opts.form ? 'POST' : 'GET') };
    if (opts.json) { o.body = JSON.stringify(opts.json); o.headers['content-type'] = 'application/json'; }
    if (opts.form) o.body = opts.form;
    const r = await fetch(B + p, o);
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer() };
  };
}
const admin = cliente(), vend = cliente();

async function xlsx(build) { const wb = new ExcelJS.Workbook(); build(wb); return Buffer.from(await wb.xlsx.writeBuffer()); }
function archivo(buf, name) { const f = new FormData(); f.append('archivo', new Blob([buf]), name); return f; }

before(async () => {
  geoSrv = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    let h = 0; for (const c of q) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ lat: String(-34.9 + (h % 1000) / 20000), lon: String(-56.16 + ((h >> 10) % 1000) / 20000) }]));
  }).listen(GPORT);
  srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), ADMIN_PASS: 'admin123', VENDOR_PASS: 'vend123', GEOCODER_URL: `http://127.0.0.1:${GPORT}/search`, GEOCODER_INTERVAL_MS: '30' }, stdio: 'inherit' });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/ingresar'); break; } catch (_) { await new Promise((r) => setTimeout(r, 150)); } }
  assert.equal((await admin('/api/login', { json: { username: 'plateroadmin', password: 'admin123' } })).status, 200);
  assert.equal((await vend('/api/login', { json: { username: 'msayago', password: 'vend123' } })).status, 200);
});

after(() => { srv.kill(); geoSrv.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('importa la planilla de comercios (sin links: se ubican por dirección)', async () => {
  const buf = await xlsx((wb) => {
    const ws = wb.addWorksheet('Comercios');
    ws.addRow(['Tipo', 'Cadena', 'Nombre', 'Dirección', 'Barrio', 'Ciudad', 'Horario', 'Link Google Maps', 'Visitas por año', 'Volver en (meses)', 'Código ventas', 'Contacto', 'Teléfono', 'Observaciones']);
    ws.addRow(['Obligatorio', 'Solo Serrana', 'Obligatorio']);
    ws.addRow(['Serrana', 'Grupo Disco', 'Disco Ejemplo', 'Av. Ejemplo 1', 'Pocitos', 'Montevideo', '', '', 3, '', 'DISCO99', '', '', '← EJEMPLO']);
    ws.addRow(['Serrana', 'Grupo Disco', 'Disco Uno', 'Calle 1 100', 'Pocitos', 'Montevideo', '', '', 3, '', 'D1']);
    ws.addRow(['Serrana', 'Grupo Disco', 'Disco Dos', 'Calle 2 200', 'Punta Carretas', 'Montevideo', '', '', 3, '', 'D2']);
    ws.addRow(['Serrana', 'Tienda Inglesa', 'Tienda Tres', 'Calle 3 300', 'Buceo', 'Montevideo', '', '', 2]);
    ws.addRow(['Cliente BEC', '', 'Parrilla Cuatro', 'Calle 4 400', 'Pocitos', 'Montevideo', '12:00-15:00', '', 2]);
    ws.addRow(['Prospecto BEC', '', 'Pizzería Cinco', 'Calle 5 500', 'Solymar', 'Ciudad de la Costa']);
    ws.addRow(['Otra cosa', '', 'Mal Tipo', 'Calle 6', 'Pocitos']);
  });
  const p = await admin('/api/clients/import/preview', { form: archivo(buf, 'comercios.xlsx') });
  assert.equal(p.status, 200);
  assert.equal(p.body.nuevas.length, 5);
  assert.equal(p.body.errores.length, 1);
  const c = await admin('/api/clients/import/confirm', { json: { token: p.body.token } });
  assert.equal(c.body.agregadas, 5);
  const again = await admin('/api/clients/import/preview', { form: archivo(buf, 'comercios.xlsx') });
  assert.equal(again.body.nuevas.length, 0, 'no duplica al subir de nuevo');
  await new Promise((r) => setTimeout(r, 1500));
  const list = (await admin('/api/clients')).body;
  assert.ok(list.every((x) => x.geo === 'ok' && x.lat != null), 'todos ubicados');
});

test('ventas: detecta la caída contra el año anterior', async () => {
  const ref = hoy();
  const buf = await xlsx((wb) => {
    const ws = wb.addWorksheet('MATRIZ');
    ws.addRow(['FECHA INICIO', '2025-01-01']); ws.addRow([]);
    ws.addRow(['FECHA', 'DOCUMENTO', 'NUMERO', 'CLIENTE', 'SUCURSAL', 'PRODUCTO', 'PRECIO', 'PACKS']);
    for (let d = 0; d < 480; d += 14) {
      const f = new Date(`${addDays(ref, -d)}T12:00:00Z`);
      const reciente = d < 90;
      ws.addRow([f, 'SFAC', d, 'SUPERMERCADO DISCO DEL URUGUAY S.A', 'D1', 'SERRANA', null, reciente ? 20 : 80]);
      ws.addRow([f, 'SFAC', d + 1, 'SUPERMERCADO DISCO DEL URUGUAY S.A', 'D2', 'SERRANA', null, 80]);
    }
    ws.addRow([new Date(`${ref}T12:00:00Z`), 'SFAC', 'EJEMPLO', 'SUPERMERCADO DISCO DEL URUGUAY S.A', 'D2', 'SERRANA', null, 999]);
  });
  const r = await admin('/api/ventas/import', { form: archivo(buf, 'ventas.xlsx') });
  assert.equal(r.status, 200);
  const v = (await admin('/api/ventas')).body;
  const d1 = v.sucursales.find((s) => s.sucursal === 'D1'), d2 = v.sucursales.find((s) => s.sucursal === 'D2');
  assert.ok(d1.prioridad && d1.variacion <= -0.3, 'D1 en caída');
  assert.ok(!d2.prioridad, 'D2 normal');
});

let semana;
test('el administrador arma y publica la semana; el vendedor la ve recién al publicar', async () => {
  const s = await admin('/api/semana/sugerencias', { json: { barrios: ['Pocitos'] } });
  semana = s.body.semana;
  assert.ok(s.body.linderos.includes('Punta Carretas'));
  assert.equal(s.body.sugeridos[0].client.nombre, 'Disco Uno', 'la caída va primero');
  assert.ok(!s.body.sugeridos.some((x) => x.client.nombre === 'Pizzería Cinco'), 'Solymar no es lindero de Pocitos');
  const items = s.body.sugeridos.map((x) => ({ client_id: x.client.id, fecha: hoy() < semana || hoy() > addDays(semana, 5) ? semana : hoy(), motivo: x.motivo }));
  const r = await admin('/api/semana/items', { json: { semana, items } });
  assert.equal(r.body.guardados, items.length);
  assert.equal((await vend('/api/semana')).body.sinPublicar, true);
  await admin('/api/semana/publicar', { json: { semana } });
  assert.equal((await vend('/api/semana')).body.total, items.length);
});

test('jornada: NO exige motivo y se reprograma, SÍ exige foto, urgencia avisa al jefe', async () => {
  const p = await vend('/api/plan/iniciar', { json: { lat: -34.9, lng: -56.15 } });
  assert.equal(p.status, 200);
  const [a, b] = p.body.items.length ? p.body.items : [];
  if (a) {
    const no = (await vend('/api/visits', { json: { item_id: a.item_id, result: 'no' } })).body;
    assert.equal((await vend(`/api/visits/${no.id}`, { method: 'PATCH', json: {} })).status, 400);
    assert.equal((await vend(`/api/visits/${no.id}`, { method: 'PATCH', json: { motivo_no: 'Cerrado' } })).status, 200);
  }
  if (b) {
    const si = (await vend('/api/visits', { json: { item_id: b.item_id, result: 'si' } })).body;
    assert.equal((await vend(`/api/visits/${si.id}`, { method: 'PATCH', json: {} })).status, 400, 'sin foto no guarda');
    const f = new FormData(); f.append('foto', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'f.jpg');
    assert.equal((await vend(`/api/visits/${si.id}/photo`, { form: f })).status, 200);
    assert.equal((await vend(`/api/visits/${si.id}`, { method: 'PATCH', json: { estandar: ['Todo OK'] } })).status, 200);
  }
  const u = await vend('/api/plan/agregar', { json: { nuevo: { nombre: 'Resto Nuevo', direccion: 'Calle 9 900', zona: 'Malvín' }, nota: 'mirar la leña' } });
  assert.equal(u.status, 200);
  const it = u.body.items.at(-1);
  assert.ok(it.urgencia && it.client.tipo === 'prospecto');
  const si = (await vend('/api/visits', { json: { item_id: it.item_id, result: 'si' } })).body;
  const f = new FormData(); f.append('foto', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'f.jpg');
  await vend(`/api/visits/${si.id}/photo`, { form: f });
  assert.equal((await vend(`/api/visits/${si.id}`, { method: 'PATCH', json: { convertido: true } })).status, 200);
  assert.equal((await vend('/api/plan/end', { json: {} })).status, 200);
  const dash = (await admin('/api/dashboard')).body;
  assert.ok(dash.alertas.some((x) => x.tipo === 'urgencia' && /mirar la leña/.test(x.texto)));
  assert.ok(dash.total.convertidos >= 1);
  const c = (await admin('/api/clients')).body.find((x) => x.nombre === 'Resto Nuevo');
  assert.equal(c.tipo, 'cliente', 'pasó a cliente');
  if (a) {
    const s2 = await admin('/api/semana/sugerencias', { json: { semana: addDays(semana, 7), barrios: [a.client.zona] } });
    const vuelve = s2.body.sugeridos.find((x) => x.client.id === a.client.id);
    assert.ok(vuelve && vuelve.prioridad <= 1, 'la visita en NO vuelve a sugerirse');
  }
});

test('exporta visitas a Excel y el vendedor no ve el control de jornada', async () => {
  const x = await admin('/api/visits/export');
  assert.equal(x.status, 200);
  assert.equal((await vend('/api/control')).status, 403);
  assert.equal((await vend('/api/ventas')).status, 403);
});
