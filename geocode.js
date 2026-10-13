'use strict';
// Ubicación aproximada a partir de la dirección (OpenStreetMap / Nominatim), para sucursales sin link de Maps.
// Respeta el límite del servicio (1 consulta por segundo) y guarda los resultados para no repetir consultas.
const { db } = require('./db');

const URL_ = (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const PAUSA = Number(process.env.GEOCODER_PAUSA_MS ?? 1100);

let cola = Promise.resolve();
let ultima = 0;

function limpiar(dir) {
  return String(dir || '')
    .split(/\s+esq\.?\s+|\s+esquina\s+/i)[0]
    .replace(/\b(s\/n|sin n[uú]mero)\b/gi, '')
    .replace(/\b(local(es)?|loc\.?)\s+[\d,\sy]+/gi, '')
    .replace(/\bkm\.?\s*[\d.,]+/gi, '')
    .replace(/\b(av|avda)\.?\s/gi, 'Avenida ')
    .replace(/\b(bvar|bv|br)\.?\s/gi, 'Bulevar ')
    .replace(/\b(cno)\.?\s/gi, 'Camino ')
    .replace(/\b(rbla)\.?\s/gi, 'Rambla ')
    .replace(/\s+/g, ' ')
    .replace(/[\s,.-]+$/, '')
    .trim();
}

async function consultar(q) {
  const cached = await db.get('SELECT lat, lng FROM geocache WHERE q = ?', [q]);
  if (cached) return cached.lat == null ? null : { lat: cached.lat, lng: cached.lng };
  const turno = cola.then(async () => {
    const espera = ultima + PAUSA - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    ultima = Date.now();
    try {
      const r = await fetch(`${URL_}/search?format=json&limit=1&countrycodes=uy&q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': 'Recorridas/1.0 (gestion de visitas comerciales)', 'Accept-Language': 'es' },
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) return undefined; // error del servicio: no se guarda, se puede reintentar
      const j = await r.json();
      const hit = Array.isArray(j) && j[0] ? { lat: +(+j[0].lat).toFixed(6), lng: +(+j[0].lon).toFixed(6) } : null;
      return hit;
    } catch (_) { return undefined; }
  });
  cola = turno.catch(() => {});
  const res = await turno;
  if (res !== undefined) await db.run('INSERT INTO geocache (q, lat, lng, at) VALUES (?,?,?,?) ON CONFLICT (q) DO NOTHING', [q, res?.lat ?? null, res?.lng ?? null, new Date().toISOString()]);
  return res || null;
}

// Devuelve { lat, lng, fuente: 'direccion' | 'zona' } o null
async function ubicarDireccion(direccion, zona) {
  const calle = limpiar(direccion);
  const z = String(zona || '').trim();
  if (calle && /\d/.test(calle)) {
    const a = await consultar(`${calle}, ${z ? z + ', ' : ''}Uruguay`);
    if (a) return { ...a, fuente: 'direccion' };
    if (z) { const b = await consultar(`${calle}, Uruguay`); if (b) return { ...b, fuente: 'direccion' }; }
  } else if (calle) {
    const a = await consultar(`${calle}, ${z ? z + ', ' : ''}Uruguay`);
    if (a) return { ...a, fuente: 'zona' }; // calle sin número: solo aproximado
  }
  if (z) { const c = await consultar(`${z}, Uruguay`); if (c) return { ...c, fuente: 'zona' }; }
  return null;
}

module.exports = { ubicarDireccion, limpiar };
