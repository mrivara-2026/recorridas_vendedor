'use strict';
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { resolveLink, parseCoords, meters } = require('./geo');

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.result != null) return cellText(v.result);
  }
  return String(v);
}

async function loadWorkbook(buffer, filename) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename || '')) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    await wb.csv.read(Readable.from([text]), { parserOptions: { delimiter } });
  } else {
    await wb.xlsx.load(buffer);
  }
  return wb;
}

// ---------- Comercios ----------
const TIPOS = { serrana: 'serrana', man: 'serrana', 'cliente bec': 'cliente', cliente: 'cliente', bec: 'cliente', 'prospecto bec': 'prospecto', prospecto: 'prospecto' };
const TIPO_NOMBRE = { serrana: 'Serrana', cliente: 'Cliente BEC', prospecto: 'Prospecto BEC' };
const CADENAS = { 'grupo disco': 'Grupo Disco', 'tienda inglesa': 'Tienda Inglesa', otra: 'Otra' };
const CIUDADES = { montevideo: 'Montevideo', 'ciudad de la costa': 'Ciudad de la Costa' };

const HEADERS = {
  tipo: (h) => h === 'tipo',
  empresa: (h) => h === 'empresa',
  cadena: (h) => h === 'cadena',
  nombre: (h) => h === 'nombre' || h === 'sucursal' || h === 'comercio',
  direccion: (h) => h.startsWith('direccion'),
  zona: (h) => h === 'zona' || h === 'barrio' || h.startsWith('zona '),
  ciudad: (h) => h === 'ciudad',
  horario: (h) => h.startsWith('horario'),
  link: (h) => h.includes('link') || h.includes('maps'),
  visitas_anio: (h) => h.startsWith('visitas por ano') || h.startsWith('visitas al ano') || h === 'frecuencia',
  volver_meses: (h) => h.startsWith('volver en'),
  codigo_ventas: (h) => h.startsWith('codigo ventas') || h === 'codigo de ventas',
  contacto: (h) => h === 'contacto',
  telefono: (h) => h.startsWith('telefono'),
  observaciones: (h) => h.startsWith('observacion')
};

const EXAMPLE_NAMES = new Set(['restaurante ejemplo', 'supermercado ejemplo suc centro', 'disco ejemplo', 'parrillada ejemplo', 'pizzeria ejemplo']);

function headerMap(ws, needed) {
  for (let r = 1; r <= Math.min(30, ws.rowCount); r++) {
    const m = {};
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const h = norm(cellText(cell.value));
      for (const [key, test] of Object.entries(HEADERS)) if (!m[key] && test(h)) { m[key] = col; break; }
    });
    if (needed(m)) return { row: r, map: m };
  }
  return null;
}

async function readComercios(buffer, filename) {
  const wb = await loadWorkbook(buffer, filename);
  const ws = wb.worksheets.find((w) => /comercio|cliente/i.test(w.name)) || wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene hojas.');
  const hm = headerMap(ws, (m) => m.nombre && (m.tipo || m.empresa));
  if (!hm) throw new Error('No encontré los encabezados. La primera fila debe tener: Tipo, Cadena, Nombre, Dirección, Barrio, Ciudad… (usá la plantilla).');
  const { row: headerRow, map } = hm;
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k) => (map[k] ? cellText(row.getCell(map[k]).value).trim() : '');
    const rec = { fila: r };
    for (const k of Object.keys(HEADERS)) rec[k] = get(k);
    if (!rec.nombre && !rec.direccion && !rec.link) continue;
    if (/^(obligatorio|opcional)/i.test(rec.nombre) || /^(obligatorio|opcional)/i.test(rec.tipo)) continue;
    if (EXAMPLE_NAMES.has(norm(rec.nombre)) || /ejemplo/i.test(rec.observaciones)) continue;
    rows.push(rec);
  }
  return { rows, barrios: readBarriosSheet(wb), listas: readListasSheet(wb) };
}

function readBarriosSheet(wb) {
  const ws = wb.worksheets.find((w) => norm(w.name) === 'barrios');
  if (!ws) return null;
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const nombre = cellText(row.getCell(1).value).trim();
    if (!nombre) continue;
    const ciudad = CIUDADES[norm(cellText(row.getCell(2).value))] || 'Montevideo';
    const linderos = cellText(row.getCell(3).value).split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ nombre, ciudad, linderos });
  }
  return out.length ? out : null;
}

const LISTA_KEYS = { 'comentarios prospecto bec': 'comentario_prospecto', 'comentarios cliente bec': 'comentario_cliente', 'comentarios serrana': 'comentario_serrana', 'motivos de no visita': 'motivo_no' };
function readListasSheet(wb) {
  const ws = wb.worksheets.find((w) => norm(w.name) === 'listas');
  if (!ws) return null;
  const out = {};
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const key = LISTA_KEYS[norm(cellText(cell.value))];
    if (!key) return;
    const vals = [];
    for (let r = 2; r <= ws.rowCount; r++) { const v = cellText(ws.getRow(r).getCell(col).value).trim(); if (v) vals.push(v); }
    if (vals.length) out[key] = vals;
  });
  return Object.keys(out).length ? out : null;
}

function cleanHorario(h) {
  return String(h || '').replace(/\s*[-–a]\s*/g, '–').replace(/\s+/g, ' ').trim();
}

function intOrNull(v) { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Normaliza una fila (de la planilla o del formulario) a un comercio. Devuelve { rec } o { problems }.
async function normalizar(r, barriosConocidos) {
  const problems = [];
  const tipo = TIPOS[norm(r.tipo)] || (r.empresa ? TIPOS[norm(r.empresa)] : null);
  if (!tipo) problems.push('Tipo debe ser Serrana, Cliente BEC o Prospecto BEC');
  if (!r.nombre) problems.push('Falta el nombre');
  if (!r.zona) problems.push('Falta el barrio');
  const conocido = barriosConocidos.get(norm(r.zona));
  const ciudad = r.ciudad ? CIUDADES[norm(r.ciudad)] : (conocido?.ciudad || 'Montevideo');
  if (!ciudad) problems.push('Ciudad debe ser Montevideo o Ciudad de la Costa');
  const zona = conocido?.nombre || String(r.zona || '').trim();
  let coords = null;
  if (r.link) {
    coords = await resolveLink(r.link);
    if (!coords) problems.push('No se pudo leer la ubicación del link de Maps');
  }
  if (problems.length) return { problems };
  const visitas = intOrNull(r.visitas_anio);
  const volver = intOrNull(r.volver_meses);
  return {
    rec: {
      fila: r.fila, tipo, empresa: tipo === 'serrana' ? 'MAN' : 'BEC',
      cadena: tipo === 'serrana' ? (CADENAS[norm(r.cadena)] || 'Otra') : '',
      nombre: String(r.nombre).trim(), direccion: String(r.direccion || '').trim(), zona, ciudad, horario: cleanHorario(r.horario), link: String(r.link || '').trim(),
      visitas_anio: tipo === 'prospecto' ? null : (visitas && visitas > 0 ? Math.min(visitas, 52) : (tipo === 'serrana' ? 3 : 2)),
      volver_meses: tipo === 'prospecto' ? (volver != null && volver >= 0 ? Math.min(volver, 36) : null) : null,
      codigo_ventas: String(r.codigo_ventas || '').trim().toUpperCase(), contacto: String(r.contacto || '').trim(), telefono: String(r.telefono || '').trim(),
      observaciones: String(r.observaciones || '').trim(),
      lat: coords ? coords.lat : null, lng: coords ? coords.lng : null, geo: coords ? 'ok' : 'pendiente'
    }
  };
}

const FIELDS = ['tipo', 'cadena', 'nombre', 'direccion', 'zona', 'ciudad', 'horario', 'link', 'visitas_anio', 'volver_meses', 'codigo_ventas', 'contacto', 'telefono', 'observaciones'];

function sameClient(c, rec) {
  if (c.codigo_ventas && rec.codigo_ventas && c.codigo_ventas === rec.codigo_ventas) return true;
  if (c.lat != null && rec.lat != null && c.geo === 'ok' && rec.geo === 'ok' && meters(c, rec) <= 15) return true;
  return norm(c.nombre) === norm(rec.nombre) && norm(rec.direccion) !== '' && norm(c.direccion) === norm(rec.direccion);
}

// Compara cada fila con la base y arma la vista previa de la importación.
async function analyze(rows, existing, barriosConocidos) {
  const errores = [];
  const valid = [];
  await mapLimit(rows, 6, async (r) => {
    const { rec, problems } = await normalizar(r, barriosConocidos);
    if (problems) errores.push({ fila: r.fila, nombre: r.nombre, motivo: problems.join(' · ') });
    else valid.push(rec);
  });
  valid.sort((a, b) => a.fila - b.fila);

  const unique = [];
  let repetidasArchivo = 0;
  for (const rec of valid) {
    const prev = unique.find((u) => sameClient(u, rec));
    if (prev) { Object.assign(prev, rec); repetidasArchivo++; } else unique.push({ ...rec });
  }

  const nuevas = [], actualizadas = [], sinCambios = [], posibles = [];
  for (const rec of unique) {
    const match = existing.find((c) => sameClient(c, rec));
    if (match) {
      if (!rec.link && match.lat != null && norm(match.direccion) === norm(rec.direccion)) { rec.lat = match.lat; rec.lng = match.lng; rec.geo = match.geo; }
      const changes = FIELDS.filter((f) => f !== 'link' || rec.link).filter((f) => String(match[f] ?? '') !== String(rec[f] ?? ''));
      if (!rec.link) rec.link = match.link;
      if (changes.length || !match.active) actualizadas.push({ ...rec, id: match.id, cambios: changes, reactivar: !match.active });
      else sinCambios.push({ ...rec, id: match.id });
    } else {
      const similar = existing.find((c) => c.active && norm(c.nombre) === norm(rec.nombre) && norm(c.zona) === norm(rec.zona));
      if (similar) posibles.push({ ...rec, parecido: { id: similar.id, nombre: similar.nombre, direccion: similar.direccion } });
      else nuevas.push(rec);
    }
  }
  errores.sort((a, b) => a.fila - b.fila);
  return { nuevas, actualizadas, sinCambios, posibles, errores, repetidasArchivo };
}

// ---------- Ventas (Consulta Factura Sucursal de GIA, o la plantilla) ----------
const VHEAD = {
  fecha: (h) => h === 'fecha',
  documento: (h) => h === 'documento' || h === 'tipo de doc' || h === 'tipo doc',
  numero: (h) => h === 'numero' || h === 'comprobante',
  cliente: (h) => h === 'cliente',
  sucursal: (h) => h === 'sucursal',
  packs: (h) => h === 'packs' || h === 'cantidad'
};

function toYmd(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = cellText(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

async function readVentas(buffer, filename) {
  const wb = await loadWorkbook(buffer, filename);
  for (const ws of wb.worksheets) {
    let head = null;
    for (let r = 1; r <= Math.min(60, ws.rowCount) && !head; r++) {
      const m = {};
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        const h = norm(cellText(cell.value));
        for (const [k, t] of Object.entries(VHEAD)) if (!m[k] && t(h)) { m[k] = col; break; }
      });
      if (m.fecha && m.documento && m.cliente && m.sucursal && m.packs) head = { r, m };
    }
    if (!head) continue;
    const rows = [];
    let invalidas = 0;
    for (let r = head.r + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const g = (k) => row.getCell(head.m[k]).value;
      const fecha = toYmd(g('fecha'));
      const documento = cellText(g('documento')).trim().toUpperCase();
      const sucursal = cellText(g('sucursal')).trim().toUpperCase();
      const cliente = cellText(g('cliente')).trim();
      const packs = Number(cellText(g('packs')).replace(',', '.'));
      if (!fecha && !documento && !sucursal) continue;
      if (/^(obligatorio|opcional)/i.test(documento) || /^(obligatorio|opcional)/i.test(cliente)) continue;
      if (head.m.numero && /ejemplo/i.test(cellText(g('numero')))) continue;
      if (!fecha || !sucursal || !cliente || !Number.isFinite(packs) || !/^(SFAC|SNCRED)$/.test(documento)) { invalidas++; continue; }
      rows.push({ fecha, documento, numero: head.m.numero ? cellText(g('numero')).trim() : '', cliente, sucursal, packs: documento === 'SNCRED' ? -Math.abs(packs) : packs });
    }
    return { rows, invalidas, hoja: ws.name };
  }
  throw new Error('No encontré las columnas FECHA, DOCUMENTO, CLIENTE, SUCURSAL y PACKS. Subí la Consulta Factura Sucursal de GIA o la plantilla de ventas.');
}

module.exports = { readComercios, analyze, readVentas, norm, cleanHorario, parseCoords, TIPO_NOMBRE, FIELDS, sameClient, normalizar };
