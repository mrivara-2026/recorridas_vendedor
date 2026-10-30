'use strict';
// Regla de caída de ventas para las sucursales del grupo Disco (Disco, Devoto, Devoto Express, Geant).
// Una sucursal es prioridad si cumple cualquiera de estas dos condiciones:
//  1. Caída: en los últimos 90 días vendió 30% o menos que en los mismos 90 días del año anterior (packs netos).
//  2. Atraso: pasó más del doble del tiempo que suele tardar entre una compra y la siguiente.
// La fecha de referencia es la última fecha que trae la planilla de ventas (no la de hoy),
// así una planilla vieja no marca caídas que no existen.
const T = require('./time');

const GRUPO_DISCO = /DISCO|DEVOTO|AMELUZ|ODALER/i;
const UMBRAL_CAIDA = -0.30;
const FACTOR_ATRASO = 2;

let cache = null;
function invalidar() { cache = null; }

function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function analizar(db) {
  if (cache) return cache;
  const ref = db.prepare('SELECT MAX(fecha) AS f FROM ventas').get().f;
  const out = { ref, sucursales: {} };
  if (!ref) return (cache = out);
  const d90 = T.addDays(ref, -90), ly1 = T.addDays(ref, -455), ly2 = T.addDays(ref, -365), y1 = T.addDays(ref, -365);
  const rows = db.prepare(`SELECT sucursal, cliente,
      SUM(CASE WHEN fecha > @d90 AND fecha <= @ref THEN packs ELSE 0 END) AS ult90,
      SUM(CASE WHEN fecha > @ly1 AND fecha <= @ly2 THEN packs ELSE 0 END) AS ly90,
      MAX(CASE WHEN documento = 'SFAC' THEN fecha END) AS ultima
    FROM ventas GROUP BY sucursal`).all({ d90, ref, ly1, ly2 });
  const fechas = db.prepare(`SELECT DISTINCT fecha FROM ventas WHERE sucursal = ? AND documento = 'SFAC' AND fecha > ? ORDER BY fecha`);
  for (const r of rows) {
    if (!GRUPO_DISCO.test(r.cliente)) continue;
    const fs = fechas.all(r.sucursal, y1).map((x) => x.fecha);
    const gaps = [];
    for (let i = 1; i < fs.length; i++) gaps.push(T.daysBetween(fs[i - 1], fs[i]));
    const intervalo = fs.length >= 3 ? median(gaps) : null;
    const diasSin = r.ultima ? T.daysBetween(r.ultima, ref) : null;
    const variacion = r.ly90 > 0 ? (r.ult90 - r.ly90) / r.ly90 : null;
    const caida = variacion != null && variacion <= UMBRAL_CAIDA;
    const atraso = intervalo != null && diasSin != null && diasSin > FACTOR_ATRASO * intervalo;
    const sinCompras = diasSin != null && diasSin > 180;
    const motivos = [];
    if (caida) motivos.push(`${Math.round(variacion * 100)}% vs año anterior`);
    if (sinCompras) motivos.push(`sin compras desde ${r.ultima.split('-').reverse().join('/')}`);
    else if (atraso) motivos.push(`${diasSin} días sin comprar (suele cada ~${Math.round(intervalo)})`);
    out.sucursales[r.sucursal] = {
      sucursal: r.sucursal, cliente: r.cliente, ult90: r.ult90, ly90: r.ly90, variacion, ultima: r.ultima, dias_sin: diasSin,
      intervalo, prioridad: caida || atraso || sinCompras, motivo: motivos.join(' · ')
    };
  }
  return (cache = out);
}

module.exports = { analizar, invalidar, GRUPO_DISCO };
