// Funciones compartidas por la app del vendedor y el panel web.
const TZ = 'America/Montevideo';

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.json !== undefined) {
    o.method = o.method || 'POST';
    o.headers = { 'Content-Type': 'application/json', ...(o.headers || {}) };
    o.body = JSON.stringify(o.json);
    delete o.json;
  }
  let res;
  try { res = await fetch(path, o); } catch (_) { throw new Error('Sin conexión. Revisá internet y probá de nuevo.'); }
  if (res.status === 401) { location.href = '/ingresar' + (location.pathname === '/app' ? '?a=app' : ''); throw new Error('Sesión vencida'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || 'Ocurrió un error. Probá de nuevo.');
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hora(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-UY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

function hoyTexto() {
  return new Intl.DateTimeFormat('es-UY', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' }).format(new Date());
}

function minTexto(m) {
  if (m == null) return '—';
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} h ${String(r).padStart(2, '0')}` : `${r} min`;
}

let toastTimer;
function toast(msg, ms = 3500) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Ubicación actual del teléfono. Devuelve null si no hay permiso o no se pudo obtener.
function ubicacion(timeout = 15000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 0 }
    );
  });
}

function confirmar(titulo, texto, si = 'Confirmar', no = 'Cancelar') {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="cf-t"><h2 id="cf-t">${esc(titulo)}</h2><div style="font-size:15px;color:var(--ink2)">${esc(texto)}</div>
      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"><button class="btn" data-r="0">${esc(no)}</button><button class="btn dark" data-r="1">${esc(si)}</button></div></div>`;
    document.body.appendChild(bg);
    bg.querySelector('[data-r="1"]').focus();
    bg.addEventListener('click', (e) => {
      const r = e.target.closest('[data-r]');
      if (r || e.target === bg) { bg.remove(); resolve(r ? r.dataset.r === '1' : false); }
    });
  });
}
