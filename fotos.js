'use strict';
// Guardado de fotos: en Supabase Storage si están SUPABASE_URL y SUPABASE_SERVICE_KEY; si no, en disco.
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./db');

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'fotos';
const REMOTE = !!(URL_ && KEY);
const DIR = path.join(DATA_DIR, 'fotos');

function headers(extra = {}) {
  const h = { apikey: KEY, ...extra };
  if (!KEY.startsWith('sb_')) h.Authorization = `Bearer ${KEY}`; // claves antiguas (JWT)
  return h;
}

async function init() {
  if (!REMOTE) { fs.mkdirSync(DIR, { recursive: true }); return; }
  const r = await fetch(`${URL_}/storage/v1/bucket`, {
    method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
  });
  if (!r.ok) {
    const t = await r.text();
    if (!/exist|duplicate/i.test(t)) throw new Error(`No se pudo preparar el almacenamiento de fotos en Supabase (${r.status}): ${t.slice(0, 200)}`);
  }
}

async function guardar(name, buffer) {
  if (!REMOTE) { fs.writeFileSync(path.join(DIR, name), buffer); return; }
  const r = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`, {
    method: 'POST', headers: headers({ 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }), body: buffer
  });
  if (!r.ok) throw new Error(`No se pudo guardar la foto (${r.status}).`);
}

async function enviar(name, res) {
  if (!REMOTE) return res.sendFile(path.join(DIR, name));
  const r = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`, { headers: headers() });
  if (!r.ok) return res.status(404).end();
  res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.send(Buffer.from(await r.arrayBuffer()));
}

async function borrar(name) {
  try {
    if (!REMOTE) { fs.rmSync(path.join(DIR, name), { force: true }); return; }
    await fetch(`${URL_}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ prefixes: [name] })
    });
  } catch (_) { /* no es grave si queda una foto vieja */ }
}

module.exports = { init, guardar, enviar, borrar, REMOTE };
