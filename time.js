'use strict';
// Fechas en hora de Montevideo (UTC-3, sin horario de verano).
const TZ = 'America/Montevideo';

function nowISO() { return new Date().toISOString(); }

function parts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}

function localDate(iso) { const p = parts(new Date(iso)); return `${p.year}-${p.month}-${p.day}`; }
function localTime(iso) { if (!iso) return ''; const p = parts(new Date(iso)); return `${p.hour}:${p.minute}`; }
function localDateTime(iso) { if (!iso) return ''; const p = parts(new Date(iso)); return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`; }

// Inicio de un día local (YYYY-MM-DD) expresado en UTC ISO.
function dayStartUTC(ymd) { return new Date(`${ymd}T00:00:00-03:00`).toISOString(); }
function dayEndUTC(ymd) { return new Date(new Date(`${ymd}T00:00:00-03:00`).getTime() + 86400000).toISOString(); }

function monthStartUTC(d = new Date()) {
  const p = parts(d);
  return new Date(`${p.year}-${p.month}-01T00:00:00-03:00`).toISOString();
}
function monthRangeUTC(ym) { // ym = 'YYYY-MM'
  const [y, m] = ym.split('-').map(Number);
  const start = new Date(`${ym}-01T00:00:00-03:00`);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const end = new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00-03:00`);
  return [start.toISOString(), end.toISOString()];
}
function currentMonth() { const p = parts(new Date()); return `${p.year}-${p.month}`; }
function today() { return localDate(new Date().toISOString()); }
function minutesBetween(a, b) { if (!a || !b) return null; return Math.round((new Date(b) - new Date(a)) / 60000); }

module.exports = { TZ, nowISO, localDate, localTime, localDateTime, dayStartUTC, dayEndUTC, monthStartUTC, monthRangeUTC, currentMonth, today, minutesBetween };
