'use strict';
// Utilidades geográficas: leer links de Google Maps, distancias y armado de recorridas.

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

function parseCoords(text) {
  if (!text) return null;
  let s = String(text).trim();
  try { s = decodeURIComponent(s); } catch (_) { /* dejar como está */ }
  const patterns = [
    /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|destination|center|daddr|sll)=(?:loc:)?\s*(-?\d{1,3}\.\d+)\s*,\s*\+?(-?\d{1,3}\.\d+)/,
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /\/(?:place|search|dir)\/[^@]*?(-?\d{1,3}\.\d+)\s*,\s*\+?(-?\d{1,3}\.\d+)/,
    /^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (validCoord(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

function isShortLink(url) {
  return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.google\.com\/\?cid)/i.test(String(url || '').trim());
}

// Sigue las redirecciones de un link corto de Maps para encontrar las coordenadas.
async function resolveLink(url) {
  const direct = parseCoords(url);
  if (direct) return direct;
  if (!/^https?:\/\//i.test(String(url || '').trim())) return null;
  let current = String(url).trim();
  for (let hop = 0; hop < 6; hop++) {
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (Recorridas)' } });
    } catch (_) {
      return null;
    }
    const loc = res.headers.get('location');
    if (loc) {
      const next = new URL(loc, current).toString();
      const c = parseCoords(next);
      if (c) return c;
      current = next;
      continue;
    }
    if (res.ok) {
      const body = (await res.text()).slice(0, 400000);
      const c = parseCoords(body.match(/https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\s<>]+/)?.[0]) ||
        (() => { const m = body.match(/\[null,null,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]/); return m && validCoord(+m[1], +m[2]) ? { lat: +m[1], lng: +m[2] } : null; })();
      return c;
    }
    return null;
  }
  return null;
}

function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function meters(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  return Math.round(km(a, b) * 1000);
}

// Elige n sucursales: primero las que quedaron pendientes, luego las más cercanas entre sí,
// y las ordena empezando desde donde está el vendedor, siempre a la parada más próxima.
function suggest(candidates, n, start) {
  const cands = candidates.filter((c) => c.lat != null && c.lng != null);
  if (!cands.length || n < 1) return [];
  const origin = start && start.lat != null ? start : cands.reduce((a, b) => (b.lng < a.lng ? b : a));
  const post = cands.filter((c) => c.postponed).sort((a, b) => km(origin, a) - km(origin, b));
  const pend = cands.filter((c) => !c.postponed);
  const chosen = post.slice(0, n);
  while (chosen.length < n && pend.length) {
    const anchors = chosen.length ? chosen : [origin];
    let bi = 0, bd = Infinity;
    pend.forEach((p, i) => {
      const d = Math.min(...anchors.map((a) => km(a, p)));
      if (d < bd) { bd = d; bi = i; }
    });
    chosen.push(pend.splice(bi, 1)[0]);
  }
  const rest = [...chosen];
  const out = [];
  let here = origin;
  while (rest.length) {
    let bi = 0;
    rest.forEach((p, i) => { if (km(here, p) < km(here, rest[bi])) bi = i; });
    here = rest.splice(bi, 1)[0];
    out.push(here);
  }
  return out;
}

function routeKm(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += km(points[i - 1], points[i]);
  return d * 1.3; // factor por calles
}

// Ordena las paradas por el recorrido más corto (siempre a la más próxima), empezando en `start`
// (la ubicación del vendedor) o, si no hay, en la parada más al oeste. Las que no tienen ubicación van al final.
function ordenar(items, start) {
  const con = items.filter((c) => c.lat != null && c.lng != null);
  const sin = items.filter((c) => c.lat == null || c.lng == null);
  if (!con.length) return [...sin];
  let here = start && start.lat != null ? start : con.reduce((a, b) => (b.lng < a.lng ? b : a));
  const rest = [...con], out = [];
  while (rest.length) {
    let bi = 0;
    rest.forEach((p, i) => { if (km(here, p) < km(here, rest[bi])) bi = i; });
    here = rest.splice(bi, 1)[0];
    out.push(here);
  }
  return [...out, ...sin];
}

// Ubica un comercio por su dirección con OpenStreetMap (Nominatim). Sin dirección exacta, ubica el barrio (aproximado).
// GEOCODER_URL permite cambiar el servicio (o usar uno de prueba); GEOCODER=off lo apaga.
const GEOCODER_URL = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
async function nominatim(q) {
  const url = `${GEOCODER_URL}?format=json&limit=1&countrycodes=uy&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': `Recorridas/2.0 (${process.env.GEOCODER_EMAIL || 'sistema de visitas'})`, 'Accept-Language': 'es' } });
  if (!res.ok) throw new Error('geocoder ' + res.status);
  const j = await res.json();
  if (!Array.isArray(j) || !j.length) return null;
  const lat = parseFloat(j[0].lat), lng = parseFloat(j[0].lon);
  return validCoord(lat, lng) ? { lat, lng } : null;
}

// El servicio pide como máximo una consulta por segundo.
function pausa() { return new Promise((r) => setTimeout(r, process.env.GEOCODER_URL ? 0 : 1100)); }

async function geocode({ direccion, zona, ciudad }) {
  const city = ciudad === 'Ciudad de la Costa' ? 'Ciudad de la Costa, Canelones' : (ciudad || 'Montevideo');
  const dir = String(direccion || '').replace(/\b(esq\.?|esquina)\b.*$/i, '').replace(/\bs\/n\b/i, '').trim();
  if (dir) {
    let c = await nominatim(`${dir}, ${zona ? zona + ', ' : ''}${city}, Uruguay`);
    if (!c && zona) { await pausa(); c = await nominatim(`${dir}, ${city}, Uruguay`); }
    if (c) return { ...c, geo: 'ok' };
  }
  if (zona) {
    await pausa();
    const c = await nominatim(`${zona}, ${city}, Uruguay`);
    if (c) return { ...c, geo: 'aprox' };
  }
  return null;
}

module.exports = { parseCoords, resolveLink, isShortLink, km, meters, suggest, routeKm, validCoord, ordenar, geocode };
