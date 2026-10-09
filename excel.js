'use strict';
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { resolveLink, parseCoords, meters } = require('./geo');

function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.result != null) return String(v.result);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

const HEADERS = {
  empresa: (h) => h === 'empresa',
  nombre: (h) => h === 'nombre' || h === 'sucursal' || h === 'comercio',
  direccion: (h) => h.startsWith('direccion'),
  zona: (h) => h === 'zona' || h === 'barrio' || h.startsWith('zona '),
  horario: (h) => h.startsWith('horario'),
  link: (h) => h.includes('link') || h.includes('maps') || h.includes('ubicacion')
};

const EXAMPLE_NAMES = new Set(['restaurante ejemplo', 'supermercado ejemplo suc centro']);

async function readRows(buffer, filename) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename || '')) {
    let text = buffer.toString('utf8').replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    await wb.csv.read(Readable.from([text]), { parserOptions: { delimiter } });
  } else {
    await wb.xlsx.load(buffer);
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
    const rec = { fila: r, empresa: get('empresa').toUpperCase(), nombre: get('nombre'), direccion: get('direccion'), zona: get('zona'), horario: get('horario'), link: get('link') };
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
async function analyze(rows, existing) {
  const errores = [];
  const valid = [];
  await mapLimit(rows, 6, async (r) => {
    const problems = [];
    if (!['BEC', 'MAN'].includes(r.empresa)) problems.push('Empresa debe ser BEC o MAN');
    if (!r.nombre) problems.push('Falta el nombre');
    if (!r.zona) problems.push('Falta la zona');
    let coords = null;
    if (!r.link) problems.push('Falta el link de Google Maps');
    else {
      coords = await resolveLink(r.link);
      if (!coords) problems.push('No se pudo leer la ubicación del link de Maps');
    }
    if (problems.length) errores.push({ fila: r.fila, nombre: r.nombre, motivo: problems.join(' · ') });
    else valid.push({ ...r, horario: cleanHorario(r.horario), lat: coords.lat, lng: coords.lng });
  });
  valid.sort((a, b) => a.fila - b.fila);

  const findMatch = (rec, pool) => pool.find((c) =>
    (c.lat != null && rec.lat != null && meters(c, rec) <= 15) ||
    (norm(c.nombre) === norm(rec.nombre) && norm(c.direccion) === norm(rec.direccion) && norm(rec.direccion) !== ''));

  // Repetidos dentro del mismo archivo: queda la última fila
  const unique = [];
  let repetidasArchivo = 0;
  for (const rec of valid) {
    const prev = findMatch(rec, unique);
    if (prev) { Object.assign(prev, rec); repetidasArchivo++; } else unique.push({ ...rec });
  }

  const nuevas = [], actualizadas = [], sinCambios = [], posibles = [];
  const fields = ['empresa', 'nombre', 'direccion', 'zona', 'horario', 'link'];
  for (const rec of unique) {
    const match = findMatch(rec, existing);
    if (match) {
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
  return { nuevas, actualizadas, sinCambios, posibles, errores, repetidasArchivo };
}

async function templateWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Clientes');
  const headers = ['Empresa', 'Nombre', 'Dirección', 'Zona', 'Horario', 'Link Google Maps'];
  ws.addRow(headers);
  ws.addRow(['Obligatorio', 'Obligatorio', 'Obligatorio', 'Obligatorio', 'Opcional', 'Obligatorio']);
  ws.addRow(['BEC', 'Restaurante Ejemplo', 'Av. Ejemplo 1234', 'El Pinar', '', 'https://www.google.com/maps?q=-34.7950,-55.8900']);
  ws.addRow(['MAN', 'Supermercado Ejemplo · Suc. Centro', 'Calle Ejemplo 567', 'Solymar', '10:00-12:00', 'https://www.google.com/maps?q=-34.8230,-55.9550']);
  ws.getRow(1).font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17201B' } };
  ws.getRow(2).font = { name: 'Arial', italic: true, size: 9, color: { argb: 'FF5B635E' } };
  [3, 4].forEach((r) => {
    ws.getRow(r).font = { name: 'Arial', italic: true, color: { argb: 'FF3F4642' } };
    ws.getRow(r).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF5F1' } };
  });
  ws.getCell('G3').value = '← filas de ejemplo: se ignoran al importar, podés borrarlas';
  ws.getCell('G3').font = { name: 'Arial', size: 9, color: { argb: 'FF8F3A14' } };
  [10, 36, 28, 16, 14, 52, 46].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
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
    ['6. Link Google Maps: en Maps, tocá la sucursal → Compartir → Copiar vínculo.', false],
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

module.exports = { readRows, analyze, templateWorkbook, norm, cleanHorario, parseCoords };
