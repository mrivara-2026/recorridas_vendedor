'use strict';
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { resolveLink, parseCoords, meters } = require('./geo');

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Carga un .xlsx; si falla por comentarios/notas (archivos hechos con otros programas), los quita y reintenta
async function loadXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); return wb; } catch (err) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    for (const name of Object.keys(zip.files)) {
      if (/comments\d*\.xml$|vmlDrawing\d*\.vml$|threadedComments/i.test(name)) zip.remove(name);
    }
    for (const name of Object.keys(zip.files)) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
        const x = await zip.file(name).async('string');
        zip.file(name, x.replace(/<legacyDrawing[^>]*\/>/g, ''));
      } else if (/_rels\/.*\.rels$/.test(name)) {
        const x = await zip.file(name).async('string');
        zip.file(name, x.replace(/<Relationship[^>]*(comments|vmlDrawing|threadedComment)[^>]*\/>/gi, ''));
      } else if (name === '[Content_Types].xml') {
        const x = await zip.file(name).async('string');
        zip.file(name, x.replace(/<Override[^>]*comments[^>]*\/>/gi, ''));
      }
    }
    const limpio = await zip.generateAsync({ type: 'nodebuffer' });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(limpio);
    return wb2;
  }
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.error) return '';
    if (v.result != null) return typeof v.result === 'object' ? cellText(v.result) : String(v.result);
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return String(v);
}

const HEADERS = {
  empresa: (h) => h === 'empresa',
  nombre: (h) => h === 'nombre' || h === 'sucursal' || h === 'comercio',
  direccion: (h) => h.startsWith('direccion'),
  zona: (h) => h === 'zona' || h === 'barrio' || h.startsWith('zona '),
  horario: (h) => h.startsWith('horario'),
  codigo: (h) => h.startsWith('codigo'),
  link: (h) => h.includes('link') || h.includes('maps') || h.includes('ubicacion')
};

const EXAMPLE_NAMES = new Set(['restaurante ejemplo', 'supermercado ejemplo suc centro']);

async function readRows(buffer, filename) {
  let wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename || '')) {
    let text = buffer.toString('utf8').replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    await wb.csv.read(Readable.from([text]), { parserOptions: { delimiter } });
  } else {
    wb = await loadXlsx(buffer);
  }
  const ws = wb.worksheets.find((w) => /cliente/i.test(w.name)) || wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene hojas.');
  let headerRow = null, map = null;
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const m = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = norm(cellText(cell.value));
      for (const [key, test] of Object.entries(HEADERS)) if (!m[key] && test(h)) { m[key] = col; break; }
    });
    if (m.nombre && m.empresa) { headerRow = r; map = m; break; }
  }
  if (!map) throw new Error('No encontré los encabezados. La primera fila debe tener: Empresa, Nombre, Dirección, Zona, Horario, Link Google Maps.');
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k) => (map[k] ? cellText(row.getCell(map[k]).value).trim() : '');
    const rec = { fila: r, empresa: get('empresa').toUpperCase(), nombre: get('nombre'), direccion: get('direccion'), zona: get('zona'), horario: get('horario'), link: get('link'), codigo: get('codigo').toUpperCase().replace(/\s+/g, '') };
    if (!rec.empresa && !rec.nombre && !rec.direccion && !rec.link) continue;
    if (/^(obligatorio|opcional)$/i.test(rec.empresa) || /^(obligatorio|opcional)$/i.test(rec.nombre)) continue;
    if (EXAMPLE_NAMES.has(norm(rec.nombre))) continue;
    rows.push(rec);
  }
  return rows;
}

function cleanHorario(h) {
  return String(h || '').replace(/\s*[-–a]\s*/g, '–').replace(/\s+/g, ' ').trim();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Compara cada fila con la base y arma la vista previa de la importación.
// ubicar(direccion, zona) → {lat, lng, fuente} | null : ubica por dirección cuando no hay link de Maps
async function analyze(rows, existing, ubicar) {
  const errores = [];
  const valid = [];
  const sinLink = [];
  await mapLimit(rows, 6, async (r) => {
    const problems = [];
    if (!['BEC', 'MAN'].includes(r.empresa)) problems.push('Empresa debe ser BEC o MAN');
    if (!r.nombre) problems.push('Falta el nombre');
    if (!r.zona) problems.push('Falta la zona');
    let coords = null;
    if (r.link) {
      coords = await resolveLink(r.link);
      if (!coords) problems.push('No se pudo leer la ubicación del link de Maps');
    } else if (!r.direccion) problems.push('Falta la dirección (o el link de Google Maps)');
    if (problems.length) { errores.push({ fila: r.fila, nombre: r.nombre, motivo: problems.join(' · ') }); return; }
    const rec = { ...r, horario: cleanHorario(r.horario), lat: coords?.lat ?? null, lng: coords?.lng ?? null, geo_fuente: 'link' };
    valid.push(rec);
    if (!coords) sinLink.push(rec);
  });
  // Sin link: si ya existía con la misma dirección, se conserva su ubicación; si no, se ubica por dirección
  for (const rec of sinLink.sort((a, b) => a.fila - b.fila)) {
    const prev = existing.find((c) => (rec.codigo && c.codigo === rec.codigo) || (norm(c.nombre) === norm(rec.nombre) && norm(c.direccion) === norm(rec.direccion)));
    if (prev && prev.lat != null && norm(prev.direccion) === norm(rec.direccion) && norm(prev.zona) === norm(rec.zona)) {
      Object.assign(rec, { lat: prev.lat, lng: prev.lng, link: prev.link || '', geo_fuente: prev.geo_fuente || 'link' });
      continue;
    }
    const u = ubicar ? await ubicar(rec.direccion, rec.zona) : null;
    if (u) Object.assign(rec, { lat: u.lat, lng: u.lng, geo_fuente: u.fuente });
    else {
      valid.splice(valid.indexOf(rec), 1);
      errores.push({ fila: rec.fila, nombre: rec.nombre, motivo: 'No se encontró la dirección en el mapa: agregá el link de Google Maps' });
    }
  }
  valid.sort((a, b) => a.fila - b.fila);

  const findMatch = (rec, pool) => pool.find((c) =>
    (rec.codigo && c.codigo && rec.codigo === c.codigo) ||
    // misma ubicación solo cuenta si las dos vienen de un link de Maps (las ubicadas por dirección son aproximadas)
    (c.lat != null && rec.lat != null && (c.geo_fuente || 'link') === 'link' && (rec.geo_fuente || 'link') === 'link' && meters(c, rec) <= 15) ||
    (norm(c.nombre) === norm(rec.nombre) && norm(c.direccion) === norm(rec.direccion) && norm(rec.direccion) !== ''));

  // Repetidos dentro del mismo archivo: queda la última fila
  const unique = [];
  let repetidasArchivo = 0;
  for (const rec of valid) {
    const prev = findMatch(rec, unique);
    if (prev) { Object.assign(prev, rec); repetidasArchivo++; } else unique.push({ ...rec });
  }

  const nuevas = [], actualizadas = [], sinCambios = [], posibles = [];
  const fields = ['empresa', 'nombre', 'direccion', 'zona', 'horario', 'link', 'codigo'];
  const aprox = unique.filter((r) => r.geo_fuente !== 'link').length;
  for (const rec of unique) {
    const match = findMatch(rec, existing);
    if (match) {
      if (!rec.codigo) rec.codigo = match.codigo || ''; // si el archivo no trae código, se conserva el que tenía
      const changes = fields.filter((f) => String(match[f] ?? '') !== String(rec[f] ?? ''));
      if (changes.length || !match.active) actualizadas.push({ ...rec, id: match.id, cambios: changes, reactivar: !match.active });
      else sinCambios.push({ ...rec, id: match.id });
    } else {
      const similar = existing.find((c) => c.active && norm(c.nombre) === norm(rec.nombre) && norm(c.zona) === norm(rec.zona));
      if (similar) posibles.push({ ...rec, parecido: { id: similar.id, nombre: similar.nombre, direccion: similar.direccion } });
      else nuevas.push(rec);
    }
  }
  errores.sort((a, b) => a.fila - b.fila);
  return { nuevas, actualizadas, sinCambios, posibles, errores, repetidasArchivo, aprox };
}

async function templateWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Clientes');
  const headers = ['Empresa', 'Nombre', 'Dirección', 'Zona', 'Horario', 'Link Google Maps', 'Código ventas'];
  ws.addRow(headers);
  ws.addRow(['Obligatorio', 'Obligatorio', 'Obligatorio', 'Obligatorio', 'Opcional', 'Opcional (si no está, se ubica por la dirección)', 'Opcional (Disco, Devoto, Geant)']);
  ws.addRow(['BEC', 'Restaurante Ejemplo', 'Av. Ejemplo 1234', 'El Pinar', '', 'https://www.google.com/maps?q=-34.7950,-55.8900', '']);
  ws.addRow(['MAN', 'Supermercado Ejemplo · Suc. Centro', 'Calle Ejemplo 567', 'Solymar', '10:00-12:00', 'https://www.google.com/maps?q=-34.8230,-55.9550', 'DISCO27']);
  ws.getRow(1).font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17201B' } };
  ws.getRow(2).font = { name: 'Arial', italic: true, size: 9, color: { argb: 'FF5B635E' } };
  [3, 4].forEach((r) => {
    ws.getRow(r).font = { name: 'Arial', italic: true, color: { argb: 'FF3F4642' } };
    ws.getRow(r).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF5F1' } };
  });
  ws.getCell('H3').value = '← filas de ejemplo: se ignoran al importar, podés borrarlas';
  ws.getCell('H3').font = { name: 'Arial', size: 9, color: { argb: 'FF8F3A14' } };
  [10, 36, 28, 16, 14, 52, 16, 46].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (let r = 3; r <= 1000; r++) ws.getCell(`A${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"BEC,MAN"'], showErrorMessage: true, errorTitle: 'Empresa', error: 'Elegí BEC (restaurantes) o MAN (supermercados).' };
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  const ins = wb.addWorksheet('Instrucciones');
  [
    ['Cómo completar e importar', true],
    ['1. Una fila por sucursal en la hoja Clientes, desde la fila 5.', false],
    ['2. Empresa: BEC para restaurantes, MAN para supermercados.', false],
    ['3. Si un cliente tiene varias sucursales, una fila por sucursal (ej.: Supermercado X · Suc. Centro).', false],
    ['4. Zona: barrio o zona de recorrida (El Pinar, Solymar…). Escribila siempre igual.', false],
    ['5. Horario: opcional, formato 10:00-12:00. Vacío = sin restricción.', false],
    ['6. Link Google Maps (opcional): en Maps, tocá la sucursal → Compartir → Copiar vínculo. Si no lo ponés, el sistema ubica la sucursal por dirección y zona (aproximado).', false],
    ['7. Código ventas: solo para Disco, Devoto y Geant. Es el código de sucursal de la planilla de ventas (ej.: DISCO27, DEV3005, GEANT1).', false],
    ['', false],
    ['Qué pasa al importar', true],
    ['• Cada archivo se SUMA a la base: no reemplaza lo que ya está cargado.', false],
    ['• Si una sucursal ya existe (misma ubicación, o mismo nombre y dirección) se actualiza y no se duplica.', false],
    ['• Antes de confirmar ves un resumen: nuevas, actualizadas, sin cambios, posibles repetidos y errores.', false],
    ['• Las filas con errores no se importan; se indica la fila y el motivo para corregirla.', false]
  ].forEach(([t, b], i) => { const c = ins.getCell(`A${i + 1}`); c.value = t; c.font = { name: 'Arial', bold: b, size: b ? 13 : 11 }; });
  ins.getColumn(1).width = 110;
  return wb;
}

// ---------- Planilla de ventas (Disco, Devoto y Geant) ----------
function cadenaDe(cliente, codigo) {
  const c = String(cliente || '').toUpperCase(), k = String(codigo || '').toUpperCase();
  if (c.includes('DISCO')) return 'Disco';
  if (c.includes('DEVOTO')) return 'Devoto';
  if (c.includes('GEANT') || c.includes('AMELUZ') || c.includes('ODALER') || k.startsWith('GEANT')) return 'Geant';
  return null;
}

function aFecha(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000));
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    const d = new Date(v);
    if (!isNaN(d)) return d;
  }
  return null;
}

async function readVentas(buffer) {
  const wb = await loadXlsx(buffer);
  const hojas = [...wb.worksheets].sort((a, b) => (/control|factura/i.test(b.name) ? 1 : 0) - (/control|factura/i.test(a.name) ? 1 : 0));
  for (const ws of hojas) {
    let hdr = null, cols = null;
    for (let r = 1; r <= Math.min(60, ws.rowCount); r++) {
      const m = { suc: [] };
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        const h = norm(cellText(cell.value));
        if (h === 'fecha') m.fecha = col;
        else if (h === 'documento') m.doc = col;
        else if (h === 'cliente') m.cliente = col;
        else if (h === 'sucursal') m.suc.push(col);
      });
      if (m.fecha && m.cliente && m.suc.length) { hdr = r; cols = m; break; }
    }
    if (!cols) continue;
    // De las columnas "Sucursal", la del código es la que casi no tiene espacios
    let codeCol = cols.suc[0], nameCol = cols.suc[1] || null;
    if (cols.suc.length > 1) {
      const spaces = cols.suc.map((c) => { let n = 0; for (let r = hdr + 1; r <= Math.min(ws.rowCount, hdr + 400); r++) if (/\s/.test(cellText(ws.getRow(r).getCell(c).value).trim())) n++; return n; });
      if (spaces[1] < spaces[0]) { codeCol = cols.suc[1]; nameCol = cols.suc[0]; }
    }
    const out = new Map();
    let filas = 0;
    for (let r = hdr + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const fecha = aFecha(row.getCell(cols.fecha).value);
      if (!fecha) continue;
      const doc = cols.doc ? cellText(row.getCell(cols.doc).value) : 'FAC';
      if (!/FAC/i.test(doc) || /CRED|NC/i.test(doc)) continue; // solo facturas, no notas de crédito
      const codigo = cellText(row.getCell(codeCol).value).trim().toUpperCase().replace(/\s+/g, '');
      const cadena = cadenaDe(cellText(row.getCell(cols.cliente).value), codigo);
      if (!cadena || !codigo || codigo === 'N/A') continue;
      filas++;
      const nombre = nameCol ? cellText(row.getCell(nameCol).value).trim() : '';
      const e = out.get(codigo) || { codigo, cadena, nombre: '', ultima: null, facturas: 0 };
      e.facturas++;
      if (!e.ultima || fecha > e.ultima) { e.ultima = fecha; if (nombre && nombre !== 'null') e.nombre = nombre; }
      if (!e.nombre && nombre && nombre !== 'null') e.nombre = nombre;
      out.set(codigo, e);
    }
    if (out.size) return { hoja: ws.name, filas, sucursales: [...out.values()].map((e) => ({ ...e, ultima: e.ultima.toISOString().slice(0, 10) })) };
  }
  throw new Error('No encontré ventas de Disco, Devoto o Geant. La planilla tiene que tener columnas FECHA, DOCUMENTO, CLIENTE y SUCURSAL.');
}

module.exports = { readRows, analyze, templateWorkbook, readVentas, norm, cleanHorario, parseCoords };
