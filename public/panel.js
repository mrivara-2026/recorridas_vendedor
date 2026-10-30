// Panel web de gestión (administrador y vendedor)
const P = {
  me: null, tab: null, clients: [], barrios: [], usuarios: [], usuario: '',
  fc: { barrio: '', tipo: '', buscar: '' },
  sem: { semana: null, data: null, sug: null, elegidos: [], marcados: new Set(), dia: null, buscar: '' },
  dash: null, dMes: '', ventas: null, vSoloPrio: true,
  visitas: [], vFiltro: { mes: '', zona: '', tipo: '', resultado: '' },
  control: null, cFecha: '', listas: null
};
const wrap = document.getElementById('wrap');
let mapa = null;
const ICON_DEL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';
const TIPOS = { serrana: ['Serrana', 'SERRANA', 'MAN'], cliente: ['Cliente BEC', 'CLIENTE BEC', 'BEC'], prospecto: ['Prospecto BEC', 'PROSPECTO', 'PROS'] };
const GEO = { ok: ['Ubicado', 'ok'], aprox: ['Aproximado (barrio)', 'warn'], pendiente: ['Buscando ubicación…', 'idle'], fallo: ['Sin ubicación: pegá el link de Maps', 'warn'] };

function mesActual() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7); }
function hoyISO() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lunes(ymd) { const d = new Date(`${ymd}T12:00:00Z`); return addDays(ymd, -((d.getUTCDay() + 6) % 7)); }
function dm(ymd) { return ymd ? ymd.split('-').reverse().slice(0, 2).join('/') : ''; }
function dmy(ymd) { return ymd ? ymd.split('-').reverse().join('/') : ''; }
function nombreMes(ym) { const [y, m] = ym.split('-').map(Number); return new Intl.DateTimeFormat('es-UY', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15))); }
function isAdmin() { return P.me?.role === 'admin'; }
function badge(tipo) { const t = TIPOS[tipo] || TIPOS.cliente; return `<span class="badge ${t[2]}">${t[1]}</span>`; }
function tabsList() {
  const t = [['semana', isAdmin() ? 'Armar semana' : 'Mi semana'], ['dashboard', isAdmin() ? 'Dashboard y alertas' : 'Mi dashboard'], ['comercios', 'Comercios']];
  if (isAdmin()) t.push(['ventas', 'Ventas Serrana']);
  t.push(['visitas', 'Visitas']);
  if (isAdmin()) t.push(['control', 'Control de jornada'], ['config', 'Barrios y listas']);
  return t;
}

async function init() {
  P.me = await api('/api/me');
  P.vFiltro.mes = mesActual(); P.dMes = mesActual(); P.cFecha = hoyISO();
  P.sem.semana = lunes(hoyISO());
  if (isAdmin()) { P.usuarios = (await api('/api/users')).filter((u) => u.role === 'vendedor'); P.usuario = String(P.usuarios[0]?.id || ''); }
  const t = (location.hash || '').slice(1);
  await abrir(tabsList().some(([k]) => k === t) ? t : (isAdmin() ? 'semana' : 'dashboard'));
}

function selVendedor() {
  if (!isAdmin() || P.usuarios.length < 2) return '';
  return `<label class="muted" style="font-size:14px" for="usel">Vendedor</label><select id="usel" data-act="usel">${P.usuarios.map((u) => `<option value="${u.id}" ${String(u.id) === P.usuario ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}</select>`;
}
function qU() { return isAdmin() && P.usuario ? `usuario=${P.usuario}` : ''; }

function shell(inner, titulo, kick = 'Sistema de visitas') {
  return `<div class="topbar"><div style="font-size:14px;font-weight:600">Visitas · Platero</div>
    <div style="display:flex;align-items:center;gap:10px;font-size:14px;flex-wrap:wrap">
      <span class="pill" style="${isAdmin() ? 'background:var(--ink);color:#fff' : 'background:var(--blue-bg);color:var(--blue-ink)'}">${isAdmin() ? 'Administrador' : 'Vendedor'}</span>
      <span class="mono">${esc(P.me.username)}</span>
      <button class="btn sm" data-act="clave">Cambiar contraseña</button>
      <button class="btn sm" data-act="salir">Salir</button></div></div>
    <div class="tabs" role="tablist">${tabsList().map(([k, l]) => `<button role="tab" aria-selected="${P.tab === k}" data-act="tab" data-t="${k}">${l}</button>`).join('')}</div>
    <div class="head"><div style="display:flex;flex-direction:column;gap:6px"><div class="kick">${esc(kick)}</div><h1>${esc(titulo)}</h1></div></div>
    ${inner}`;
}

async function abrir(tab) {
  P.tab = tab;
  history.replaceState(null, '', '#' + tab);
  if (mapa) { mapa.remove(); mapa = null; }
  try {
    if (tab === 'semana') await cargarSemana(true);
    else if (tab === 'dashboard') await cargarDash();
    else if (tab === 'comercios') { [P.clients, P.barrios] = await Promise.all([api('/api/clients'), api('/api/barrios')]); renderComercios(); }
    else if (tab === 'ventas') { P.ventas = await api('/api/ventas'); renderVentas(); }
    else if (tab === 'visitas') await cargarVisitas();
    else if (tab === 'control') await cargarControl();
    else if (tab === 'config') { [P.barrios, P.listas] = await Promise.all([api('/api/barrios'), api('/api/listas')]); renderConfig(); }
  } catch (err) { toast(err.message, 5000); }
}

function modal(html) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) bg.remove(); });
  return bg;
}

// ================= SEMANA =================
async function cargarSemana(conBarrios) {
  const S = P.sem;
  const [data, barrios] = await Promise.all([api(`/api/semana?semana=${S.semana}&${qU()}`), conBarrios || !P.barrios.length ? api('/api/barrios') : Promise.resolve(P.barrios)]);
  S.data = data; P.barrios = barrios;
  if (!S.dia || lunes(S.dia) !== S.semana) S.dia = S.semana <= hoyISO() && hoyISO() <= addDays(S.semana, 5) ? hoyISO() : S.semana;
  if (isAdmin() && S.elegidos.length) await buscarSugeridos(); else renderSemana();
}

async function buscarSugeridos() {
  const S = P.sem;
  if (!S.elegidos.length) { S.sug = null; S.marcados = new Set(); return renderSemana(); }
  S.sug = await api('/api/semana/sugerencias', { json: { semana: S.semana, barrios: S.elegidos, usuario: P.usuario } });
  S.marcados = new Set(S.sug.sugeridos.filter((x) => x.prioridad <= 1).map((x) => x.client.id));
  renderSemana();
}

function semanaDias() { return P.sem.data.dias.filter((d, i) => i < 5 || d.items.length); }

function renderSemana() {
  const S = P.sem, W = S.data, adm = isAdmin();
  const pub = W.publicada_at;
  const dias = W.dias.slice(0, 6);
  const hoy = hoyISO();
  const est = { si: ['SÍ', 'ok'], no: ['NO', 'warn'], sin_visitar: ['Sin visitar', 'warn'], pendiente: ['Pendiente', 'idle'] };
  const semanaHtml = `<div class="week">${semanaDias().map((d) => `<div class="card daycol${d.fecha === hoy ? ' today' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px"><strong>${d.nombre} ${dm(d.fecha)}</strong><span class="mono muted" style="font-size:13px">${d.items.length}</span></div>
      ${d.barrios.length ? `<div class="muted" style="font-size:12px">${esc(d.barrios.join(' · '))}</div>` : ''}
      ${d.items.map((it) => `<div class="witem">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${badge(it.client.tipo)}<span class="pill ${est[it.estado][1]}" style="font-size:11px;padding:2px 6px">${est[it.estado][0]}</span></div>
        <div style="font-weight:600;font-size:14px">${esc(it.client.nombre)}</div>
        <div class="muted" style="font-size:12px">${esc(it.client.zona)}${it.motivo ? ' · ' + esc(it.motivo) : ''}</div>
        ${adm ? `<div style="display:flex;gap:6px;align-items:center"><label class="sr" for="md${it.id}">Mover a otro día</label><select id="md${it.id}" data-act="mover" data-id="${it.id}" style="height:32px;font-size:13px;flex:1">${dias.map((x) => `<option value="${x.fecha}" ${x.fecha === d.fecha ? 'selected' : ''}>${x.nombre.slice(0, 3)} ${dm(x.fecha)}</option>`).join('')}</select>
          <button class="iconbtn" data-act="quitar" data-id="${it.id}" aria-label="Quitar ${esc(it.client.nombre)} de la semana">${ICON_DEL}</button></div>` : ''}
      </div>`).join('') || '<div class="muted" style="font-size:13px">Sin visitas</div>'}
    </div>`).join('')}</div>`;
  if (!adm) {
    wrap.innerHTML = shell(`${W.sinPublicar ? '<div class="card" style="padding:18px">El jefe comercial todavía no publicó esta semana.</div>' : ''}
      <div class="fil"><button class="btn sm" data-act="semPrev">← Semana anterior</button><button class="btn sm" data-act="semNext">Semana siguiente →</button></div>${semanaHtml}`,
    `Mi semana: ${W.total} ${W.total === 1 ? 'visita' : 'visitas'} · ${W.hechas} hechas`, `Semana del ${dm(W.dias[0].fecha)} al ${dm(W.dias[4].fecha)}`);
    return;
  }
  const sug = S.sug;
  const bm = new Map(P.barrios.map((b) => [b.nombre, b]));
  const ciudades = ['Montevideo', 'Ciudad de la Costa'];
  const q = S.buscar.trim().toLowerCase();
  const manual = q.length >= 2 ? P.clients.filter((c) => `${c.nombre} ${c.direccion} ${c.zona}`.toLowerCase().includes(q)).slice(0, 8) : [];
  wrap.innerHTML = shell(`
    <div class="fil" style="justify-content:space-between">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button class="btn sm" data-act="semPrev">← Anterior</button><button class="btn sm" data-act="semHoy">Esta semana</button><button class="btn sm" data-act="semNext">Siguiente →</button>${selVendedor()}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="pill ${pub ? 'ok' : 'idle'}">${pub ? `Publicada ${new Date(pub).toLocaleDateString('es-UY', { timeZone: TZ })} ${hora(pub)}` : 'Sin publicar: el vendedor no la ve'}</span>
        ${pub ? '<button class="btn" data-act="despublicar">Despublicar</button>' : ''}<button class="btn green" data-act="publicar" ${W.total ? '' : 'disabled'}>${pub ? 'Volver a publicar' : 'Publicar semana'}</button></div>
    </div>
    <section class="card" style="padding:18px;display:flex;flex-direction:column;gap:12px">
      <h2 class="h2">1. Barrios de la semana</h2>
      ${ciudades.map((ci) => `<div style="display:flex;flex-direction:column;gap:6px"><div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.06em">${ci}</div>
        <div class="chips">${P.barrios.filter((b) => b.ciudad === ci).map((b) => `<button class="chipb" data-act="barrio" data-b="${esc(b.nombre)}" aria-pressed="${S.elegidos.includes(b.nombre)}">${esc(b.nombre)}</button>`).join('')}</div></div>`).join('')}
      ${sug && sug.linderos.length ? `<div style="font-size:14px;color:var(--ink2)">Linderos sumados: ${sug.linderos.map((l) => `<span class="lind">${esc(l)}</span>`).join(' ')}</div>` : '<div class="muted" style="font-size:14px">Elegí uno o más barrios: el sistema suma los barrios linderos y sugiere los comercios a los que les toca visita.</div>'}
    </section>
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
      <section class="card" style="flex:999 1 560px;min-width:0;padding:18px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <h2 class="h2">2. Sugeridos por el sistema${sug ? ` · ${sug.sugeridos.length}` : ''}</h2>
          <span class="muted" style="font-size:13px">Orden: caída de ventas → quedaron pendientes → les toca por frecuencia</span></div>
        ${sug ? (sug.sugeridos.length ? `<div class="tbl"><table><thead><tr><th><label class="sr" for="mtodos">Marcar todos</label><input type="checkbox" id="mtodos" data-act="mtodos" ${S.marcados.size === sug.sugeridos.length ? 'checked' : ''}></th><th>Comercio</th><th>Tipo</th><th>Barrio</th><th>Motivo</th></tr></thead><tbody>
          ${sug.sugeridos.map((s) => `<tr><td><input type="checkbox" data-act="marcar" data-id="${s.client.id}" aria-label="Incluir ${esc(s.client.nombre)}" ${S.marcados.has(s.client.id) ? 'checked' : ''}></td>
            <td style="font-weight:600;white-space:normal">${esc(s.client.nombre)}<div class="muted" style="font-size:12px;font-weight:400">${esc(s.client.direccion)}</div></td><td>${badge(s.client.tipo)}</td>
            <td>${esc(s.client.zona)}${s.lindero ? ' <span class="muted" style="font-size:12px">(lindero)</span>' : ''}</td>
            <td style="white-space:normal"><span class="pill ${s.prioridad === 0 ? 'warn' : s.prioridad === 1 ? 'idle' : ''}" style="${s.prioridad > 1 ? 'background:none;padding:0;font-weight:400' : ''}">${esc(s.motivo)}</span></td></tr>`).join('')}
          </tbody></table></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><label for="sdia" class="muted" style="font-size:14px">Agregar los marcados al día</label>
            <select id="sdia" data-act="sdia">${dias.map((x) => `<option value="${x.fecha}" ${x.fecha === S.dia ? 'selected' : ''}>${x.nombre} ${dm(x.fecha)}</option>`).join('')}</select>
            <button class="btn dark" data-act="agregarSem" ${S.marcados.size ? '' : 'disabled'}>Agregar ${S.marcados.size || ''} a la semana</button></div>`
          : '<div class="muted">No hay comercios a los que les toque visita en esos barrios esta semana.</div>') : '<div class="muted">Elegí barrios arriba para ver las sugerencias.</div>'}
        <div style="border-top:1px solid var(--line2);padding-top:12px;display:flex;flex-direction:column;gap:8px">
          <label for="sbus" style="font-size:14px;font-weight:600">Agregar un comercio a mano</label>
          <input id="sbus" type="search" placeholder="Buscar por nombre, dirección o barrio" value="${esc(S.buscar)}" class="inp">
          ${manual.map((c) => `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${badge(c.tipo)}<span style="font-weight:600">${esc(c.nombre)}</span><span class="muted" style="font-size:13px">${esc(c.zona)}</span><button class="btn sm" data-act="agregarUno" data-id="${c.id}" style="margin-left:auto">+ ${dias.find((x) => x.fecha === S.dia)?.nombre || 'Agregar'}</button></div>`).join('')}
        </div>
      </section>
      <section style="flex:1 1 100%;min-width:0;display:flex;flex-direction:column;gap:10px">
        <h2 class="h2">3. La semana · ${W.total} ${W.total === 1 ? 'visita' : 'visitas'}</h2>
        ${semanaHtml}
        <div class="muted" style="font-size:13px">Cada día se ordena por el recorrido más corto. Al iniciar la jornada se reordena desde donde está el vendedor.</div>
      </section>
    </div>`, 'Armar la semana del vendedor', `Semana del ${dm(W.dias[0].fecha)} al ${dm(W.dias[4].fecha)}`);
  const sb = document.getElementById('sbus');
  if (sb) sb.addEventListener('input', async () => {
    S.buscar = sb.value;
    if (!P.clients.length) P.clients = await api('/api/clients');
    const p = sb.selectionStart; renderSemana(); const n = document.getElementById('sbus'); n.focus(); n.setSelectionRange(p, p);
  });
}

// ================= DASHBOARD =================
async function cargarDash() {
  P.dash = await api(`/api/dashboard?mes=${P.dMes}&${qU()}`);
  renderDash();
}

function renderDash() {
  const D = P.dash, T = D.total;
  const h = (m) => (m == null ? '—' : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`);
  const pct = (x) => (x == null ? '—' : `${x}%`);
  const al = D.alertas || [];
  const tag = { urgencia: ['URGENCIA', 'URG'], caida: ['VENTAS', 'BEC'], jornada: ['JORNADA', 'PROS'] };
  wrap.innerHTML = shell(`
    <div class="fil"><label for="dmes" class="muted" style="font-size:14px">Mes</label><input type="month" id="dmes" value="${esc(P.dMes)}">${selVendedor()}
      <a class="btn dark" style="margin-left:auto" href="/api/visits/export?mes=${esc(P.dMes)}">Exportar visitas a Excel</a></div>
    <div class="kpis">
      <div class="card kpi"><div class="l">Cumplimiento</div><div class="v">${pct(T.cumplimiento)}</div><div class="l">${T.cumplidas} de ${T.planificadas} visitas planificadas hasta hoy</div></div>
      <div class="card kpi"><div class="l">Visitas hechas</div><div class="v">${T.visitas}</div><div class="l">Serrana ${T.porTipo.serrana} · Cliente ${T.porTipo.cliente} · Prospecto ${T.porTipo.prospecto}</div></div>
      <div class="card kpi"><div class="l">Horas trabajadas</div><div class="v">${h(T.minutos)}</div><div class="l">de inicio a fin de jornada</div></div>
      <div class="card kpi"><div class="l">Prospectos a cliente</div><div class="v">${T.convertidos}</div><div class="l">en ${esc(nombreMes(D.mes))}</div></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
      <div class="card tbl" style="flex:999 1 520px;min-width:0"><table><thead><tr><th>Semana</th><th>Cumplimiento</th><th>Visitas</th><th>Serrana</th><th>Cliente BEC</th><th>Prospecto</th><th>Horas</th><th>A cliente</th></tr></thead><tbody>
        ${D.semanas.map((s) => `<tr><td class="mono">${dm(s.desde)} – ${dm(s.hasta)}</td><td>${s.planificadas ? `${pct(s.cumplimiento)} <span class="muted" style="font-size:13px">(${s.cumplidas}/${s.planificadas})</span>` : '<span class="muted">—</span>'}</td>
          <td class="mono">${s.visitas}</td><td class="mono">${s.porTipo.serrana}</td><td class="mono">${s.porTipo.cliente}</td><td class="mono">${s.porTipo.prospecto}</td><td class="mono">${h(s.minutos)}</td><td class="mono">${s.convertidos}</td></tr>`).join('')}
      </tbody></table></div>
      ${isAdmin() ? `<section class="card" style="flex:1 1 360px;min-width:0;padding:18px;display:flex;flex-direction:column;gap:10px">
        <h2 class="h2">Alertas · ${al.length}</h2>
        ${al.length ? al.map((a) => `<div class="alert"><span class="badge ${tag[a.tipo]?.[1] || 'PROS'}" style="flex:none">${tag[a.tipo]?.[0] || 'AVISO'}</span>
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><span style="font-size:14px">${esc(a.texto)}</span><span class="muted" style="font-size:12px">${esc(a.fecha)}${a.dia ? ` · <a href="#control" data-act="verdia" data-d="${a.dia}">ver jornada</a>` : ''}</span></div>
          ${a.id ? `<button class="btn sm" data-act="vista" data-id="${a.id}">Vista</button>` : ''}</div>`).join('') : '<div class="okmsg">Sin alertas.</div>'}
        <div class="muted" style="font-size:12px">Las alertas de jornada son de los últimos 7 días y se ven en Control de jornada.</div>
      </section>` : ''}
    </div>`, isAdmin() ? 'Dashboard y alertas' : 'Cómo me viene yendo', nombreMes(D.mes));
  document.getElementById('dmes').addEventListener('change', (e) => { P.dMes = e.target.value || mesActual(); cargarDash().catch((er) => toast(er.message)); });
}

// ================= COMERCIOS =================
function estadoComercio(c) {
  if (c.caida) return `<span class="pill warn">Caída: ${esc(c.caida_motivo)}</span>`;
  if (c.pendiente) return '<span class="pill warn">Quedó pendiente</span>';
  if (c.proxima === 'nunca') return '<span class="pill idle">No volver</span>';
  if (!c.proxima) return `<span class="pill idle">${c.last_visit_at ? 'Le toca' : 'Sin visitar'}</span>`;
  return c.proxima <= hoyISO() ? '<span class="pill idle">Le toca</span>' : `<span class="muted" style="font-size:13px">Próxima desde ${dmy(c.proxima)}</span>`;
}

function renderComercios() {
  const F = P.fc;
  const barrios = [...new Set(P.clients.map((c) => c.zona))].sort((a, b) => a.localeCompare(b, 'es'));
  const q = F.buscar.trim().toLowerCase();
  const rows = P.clients.filter((c) => (!F.barrio || c.zona === F.barrio) && (!F.tipo || c.tipo === F.tipo) && (!q || `${c.nombre} ${c.direccion} ${c.codigo_ventas}`.toLowerCase().includes(q)));
  const nGeo = P.clients.filter((c) => c.geo === 'pendiente').length;
  wrap.innerHTML = shell(`
    <div class="grid2">
      <div class="card drop" id="drop">
        <div style="font-size:17px;font-weight:600">Subir Excel de comercios</div>
        <div style="font-size:14px;color:var(--muted)">Arrastrá el archivo acá o elegilo (.xlsx). Usá la plantilla: Tipo · Cadena · Nombre · Dirección · Barrio · Ciudad · Horario · Link Google Maps (opcional) · Visitas por año · Volver en (meses) · Código ventas · Contacto · Teléfono · Observaciones.</div>
        <div style="font-size:14px;color:var(--muted)">Cada archivo se suma a la base: lo que ya existe se actualiza sin duplicarse.${isAdmin() ? ' Si trae las hojas Barrios y Listas, también se actualizan.' : ''} Sin link de Maps, el sistema ubica cada comercio por su dirección.</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <label class="btn dark">Elegir archivo<input type="file" id="xls" accept=".xlsx,.csv" class="sr"></label>
          <a class="btn" href="/plantillas/Plantilla_Comercios.xlsx">Descargar plantilla</a>
          <button class="btn green" data-act="nueva">+ Agregar comercio</button>
        </div>
      </div>
      <div class="card" style="padding:22px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:17px;font-weight:600">Cada cuánto se visita</div>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:var(--ink2);display:flex;flex-direction:column;gap:6px">
          <li><strong>Serrana:</strong> según “Visitas por año” (2 o 3). Las del grupo Disco con caída de ventas pasan adelante.</li>
          <li><strong>Cliente BEC:</strong> según “Visitas por año” (1 o 2).</li>
          <li><strong>Prospecto BEC:</strong> cuando pidió que volvamos. Con “Pasó a cliente” queda como Cliente BEC.</li>
          <li>Una visita con NO vuelve a sugerirse la próxima vez que se arme ese barrio.</li>
        </ul>
        ${nGeo ? `<div class="pill idle" style="align-self:flex-start">Ubicando ${nGeo} ${nGeo === 1 ? 'comercio' : 'comercios'} por dirección…</div>` : ''}
      </div>
    </div>
    <div class="fil">
      <label class="sr" for="fb">Barrio</label><select id="fb" data-act="fb"><option value="">Todos los barrios</option>${barrios.map((b) => `<option ${F.barrio === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      <label class="sr" for="ft">Tipo</label><select id="ft" data-act="ft"><option value="">Todos los tipos</option>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${F.tipo === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      <label class="sr" for="bq">Buscar</label><input id="bq" type="search" placeholder="Buscar nombre, dirección o código" value="${esc(F.buscar)}">
      <span class="muted" style="font-size:14px">${rows.length} de ${P.clients.length} comercios</span>
    </div>
    <div class="card tbl">
      ${P.clients.length ? `<table><thead><tr><th>Tipo</th><th>Cadena</th><th>Nombre</th><th>Dirección</th><th>Barrio</th><th>Ciudad</th><th>Horario</th><th>Frecuencia</th><th>Código ventas</th><th>Contacto</th><th>Teléfono</th><th>Ubicación</th><th>Estado</th><th><span class="sr">Acciones</span></th></tr></thead><tbody>
      ${rows.map((c) => `<tr data-id="${c.id}">
        <td><select aria-label="Tipo" data-f="tipo">${Object.entries(TIPOS).map(([k, v]) => `<option value="${v[0]}" ${c.tipo === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></td>
        <td>${c.tipo === 'serrana' ? `<select aria-label="Cadena" data-f="cadena">${['Grupo Disco', 'Tienda Inglesa', 'Otra'].map((x) => `<option ${c.cadena === x ? 'selected' : ''}>${x}</option>`).join('')}</select>` : '<span class="muted">—</span>'}</td>
        <td><input aria-label="Nombre" data-f="nombre" value="${esc(c.nombre)}" style="width:230px"></td>
        <td><input aria-label="Dirección" data-f="direccion" value="${esc(c.direccion)}" style="width:210px"></td>
        <td><input aria-label="Barrio" data-f="zona" value="${esc(c.zona)}" style="width:140px" list="dl-barrios"></td>
        <td><select aria-label="Ciudad" data-f="ciudad">${['Montevideo', 'Ciudad de la Costa'].map((x) => `<option ${c.ciudad === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
        <td><input aria-label="Horario" data-f="horario" value="${esc(c.horario)}" placeholder="—" style="width:110px" class="mono"></td>
        <td>${c.tipo === 'prospecto' ? `<label class="sr" for="vm${c.id}">Volver en meses</label><select id="vm${c.id}" data-f="volver_meses"><option value="">Volver: sin definir</option>${[1, 2, 3, 6, 12].map((m) => `<option value="${m}" ${c.volver_meses === m ? 'selected' : ''}>Volver en ${m} ${m === 1 ? 'mes' : 'meses'}</option>`).join('')}<option value="0" ${c.volver_meses === 0 ? 'selected' : ''}>No volver</option></select>`
          : `<label class="sr" for="va${c.id}">Visitas por año</label><select id="va${c.id}" data-f="visitas_anio">${[1, 2, 3, 4, 6, 12].map((m) => `<option value="${m}" ${c.visitas_anio === m ? 'selected' : ''}>${m} por año</option>`).join('')}</select>`}</td>
        <td><input aria-label="Código ventas" data-f="codigo_ventas" value="${esc(c.codigo_ventas)}" style="width:100px" class="mono"></td>
        <td><input aria-label="Contacto" data-f="contacto" value="${esc(c.contacto)}" style="width:130px"></td>
        <td><input aria-label="Teléfono" data-f="telefono" value="${esc(c.telefono)}" style="width:120px"></td>
        <td><span class="pill ${GEO[c.geo]?.[1] || 'idle'}" title="${esc(GEO[c.geo]?.[0] || '')}">${esc((GEO[c.geo]?.[0] || c.geo).split(':')[0])}</span>
          ${c.lat != null ? ` <a href="https://www.google.com/maps?q=${c.lat},${c.lng}" target="_blank" rel="noopener" style="font-size:13px">ver</a>` : ''}
          <button class="btn sm" data-act="link" style="height:30px;margin-left:4px">Link</button></td>
        <td>${estadoComercio(c)}</td>
        <td style="display:flex;gap:4px;align-items:center">${c.tipo === 'prospecto' ? `<button class="btn sm" data-act="convertir">Pasó a cliente</button>` : ''}${isAdmin() ? `<button class="iconbtn" data-act="borrar" aria-label="Eliminar ${esc(c.nombre)}">${ICON_DEL}</button>` : ''}</td></tr>`).join('')}
      </tbody></table><datalist id="dl-barrios">${P.barrios.map((b) => `<option value="${esc(b.nombre)}">`).join('')}</datalist>` : '<div style="padding:30px;text-align:center" class="muted">Todavía no hay comercios. Subí el Excel o agregalos uno por uno.</div>'}
    </div>`, 'Comercios');
  const bq = document.getElementById('bq');
  bq.addEventListener('input', () => { F.buscar = bq.value; const pos = bq.selectionStart; renderComercios(); const nb = document.getElementById('bq'); nb.focus(); nb.setSelectionRange(pos, pos); });
  const drop = document.getElementById('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) previewImport(e.dataTransfer.files[0]); });
}

async function guardarCampo(input) {
  const tr = input.closest('tr');
  const id = Number(tr.dataset.id);
  const c = P.clients.find((x) => x.id === id);
  const f = input.dataset.f;
  const val = input.value.trim();
  const actual = f === 'tipo' ? TIPOS[c.tipo][0] : String(c[f] ?? '');
  if (actual === val) return;
  input.classList.remove('saved', 'bad');
  try {
    const r = await api(`/api/clients/${id}`, { method: 'PATCH', json: { [f]: val } });
    Object.assign(c, r.client);
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 1500);
    if (['tipo', 'zona', 'visitas_anio', 'volver_meses', 'direccion'].includes(f)) { P.clients = await api('/api/clients'); renderComercios(); }
  } catch (err) {
    input.value = actual;
    input.classList.add('bad');
    toast(err.message, 5000);
  }
}

function formComercio(c = {}) {
  return `<label class="f">Tipo<select name="tipo">${Object.values(TIPOS).map((v) => `<option ${TIPOS[c.tipo]?.[0] === v[0] ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></label>
    <label class="f">Cadena (solo Serrana)<select name="cadena"><option>Otra</option><option>Grupo Disco</option><option>Tienda Inglesa</option></select></label>
    <label class="f">Nombre<input name="nombre" required></label>
    <label class="f">Dirección<input name="direccion" required></label>
    <label class="f">Barrio<input name="zona" list="dl-z2" required></label><datalist id="dl-z2">${P.barrios.map((b) => `<option value="${esc(b.nombre)}">`).join('')}</datalist>
    <label class="f">Ciudad<select name="ciudad"><option>Montevideo</option><option>Ciudad de la Costa</option></select></label>
    <label class="f">Horario (opcional)<input name="horario" placeholder="10:00-12:00"></label>
    <label class="f">Link de Google Maps (opcional)<input name="link" placeholder="https://maps.app.goo.gl/…"></label>
    <label class="f">Visitas por año (Serrana y Cliente BEC)<select name="visitas_anio"><option value="">Por defecto (Serrana 3, Cliente 2)</option>${[1, 2, 3, 4, 6, 12].map((m) => `<option value="${m}">${m}</option>`).join('')}</select></label>
    <label class="f">Código ventas (grupo Disco)<input name="codigo_ventas" class="mono"></label>
    <label class="f">Contacto (opcional)<input name="contacto"></label>
    <label class="f">Teléfono (opcional)<input name="telefono"></label>`;
}

function nuevoComercio() {
  const bg = modal(`<h2>Agregar comercio</h2><form id="fn" style="display:flex;flex-direction:column;gap:12px">${formComercio()}
      <div class="err" id="fn-e" hidden></div>
      <div style="display:flex;gap:10px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn dark" id="fn-b">Guardar</button></div>
    </form>`);
  const f = bg.querySelector('#fn');
  f.nombre.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = bg.querySelector('#fn-b'), er = bg.querySelector('#fn-e');
    b.disabled = true; er.hidden = true;
    try {
      await api('/api/clients', { json: Object.fromEntries(new FormData(f)) });
      bg.remove(); toast('Comercio agregado.');
      await abrir('comercios');
    } catch (err) { er.textContent = err.message; er.hidden = false; b.disabled = false; }
  });
}

function pegarLink(id) {
  const c = P.clients.find((x) => x.id === id);
  const bg = modal(`<h2>Ubicación de ${esc(c.nombre)}</h2>
    <div class="muted" style="font-size:14px">En Google Maps buscá el local → Compartir → Copiar vínculo, y pegalo acá. Así la ubicación queda exacta.</div>
    <form id="fl" style="display:flex;flex-direction:column;gap:12px"><label class="f">Link de Google Maps<input name="link" value="${esc(c.link)}" required></label>
    <div class="err" id="fl-e" hidden></div>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn dark">Guardar</button></div></form>`);
  const f = bg.querySelector('#fl');
  f.link.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api(`/api/clients/${id}`, { method: 'PATCH', json: { link: f.link.value.trim() } }); Object.assign(c, r.client); bg.remove(); toast('Ubicación guardada.'); renderComercios(); }
    catch (err) { const er = bg.querySelector('#fl-e'); er.textContent = err.message; er.hidden = false; }
  });
}

async function previewImport(file) {
  const bg = modal('<h2>Revisando el archivo…</h2><div class="muted">Leyendo filas y ubicaciones.</div>');
  const fd = new FormData();
  fd.append('archivo', file);
  let p;
  try { p = await api('/api/clients/import/preview', { method: 'POST', body: fd }); }
  catch (err) { bg.querySelector('.modal').innerHTML = `<h2>No se pudo importar</h2><div class="err">${esc(err.message)}</div><div style="text-align:right"><button class="btn" data-close>Cerrar</button></div>`; return; }
  const n = p.nuevas.length, a = p.actualizadas.length;
  const lista = (arr, fn) => `<div class="list-sm">${arr.map(fn).join('')}</div>`;
  bg.querySelector('.modal').innerHTML = `<h2>Importar ${esc(p.archivo)}</h2>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
      <div class="card kpi"><div class="v" style="color:var(--green-ink)">${n}</div><div class="l">Nuevos</div></div>
      <div class="card kpi"><div class="v">${a}</div><div class="l">Se actualizan</div></div>
      <div class="card kpi"><div class="v">${p.sinCambios}</div><div class="l">Ya estaban igual</div></div>
      <div class="card kpi"><div class="v" style="color:${p.errores.length ? 'var(--orange)' : 'inherit'}">${p.errores.length}</div><div class="l">Con errores</div></div>
    </div>
    ${p.barrios || p.listas ? `<div class="okmsg">También se actualizan ${[p.barrios && `${p.barrios} barrios con sus linderos`, p.listas && `${p.listas} listas de comentarios`].filter(Boolean).join(' y ')}.</div>` : ''}
    ${p.nuevosBarrios.length ? `<div class="muted" style="font-size:14px">Barrios nuevos (se agregan sin linderos; completalos en Barrios y listas): ${esc(p.nuevosBarrios.join(', '))}</div>` : ''}
    ${p.repetidasArchivo ? `<div class="muted" style="font-size:14px">${p.repetidasArchivo} ${p.repetidasArchivo === 1 ? 'fila estaba repetida' : 'filas estaban repetidas'} dentro del archivo: queda una sola.</div>` : ''}
    ${n ? `<div><strong>Nuevos</strong>${lista(p.nuevas, (r) => `<div>${badge(r.tipo)} ${esc(r.nombre)} · <span class="muted">${esc(r.zona)}</span></div>`)}</div>` : ''}
    ${a ? `<div><strong>Se actualizan</strong>${lista(p.actualizadas, (r) => `<div>${esc(r.nombre)} · <span class="muted">${r.reactivar ? 'se vuelve a activar' : 'cambia: ' + esc(r.cambios.join(', '))}</span></div>`)}</div>` : ''}
    ${p.posibles.length ? `<div><strong>Posibles repetidos</strong> <span class="muted" style="font-size:14px">— mismo nombre y barrio que un comercio cargado, con otra dirección. Marcá solo los que sean otro local.</span>
      ${lista(p.posibles, (r) => `<div><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-pos="${r.fila}" style="margin-top:4px"> <span>Fila ${r.fila}: ${esc(r.nombre)} (${esc(r.direccion)}) <span class="muted">· parecido a "${esc(r.parecido.nombre)}" (${esc(r.parecido.direccion)})</span></span></label></div>`)}</div>` : ''}
    ${p.errores.length ? `<div><strong style="color:var(--orange-ink)">Filas con errores (no se importan)</strong>${lista(p.errores, (r) => `<div>Fila ${r.fila}${r.nombre ? ` · ${esc(r.nombre)}` : ''}: <span style="color:var(--orange-ink)">${esc(r.motivo)}</span></div>`)}</div>` : ''}
    <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"><button class="btn" data-close>Cancelar</button>
    <button class="btn dark" id="imp-ok" ${n + a + p.posibles.length + p.barrios + p.listas ? '' : 'disabled'}>Confirmar importación</button></div>`;
  bg.querySelector('#imp-ok').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const incluir = [...bg.querySelectorAll('[data-pos]:checked')].map((x) => Number(x.dataset.pos));
    try {
      const r = await api('/api/clients/import/confirm', { json: { token: p.token, incluirPosibles: incluir } });
      bg.remove();
      toast(`Importación lista: ${r.agregadas} nuevos, ${r.actualizadas} actualizados.`, 5000);
      await abrir('comercios');
    } catch (err) { toast(err.message, 5000); e.target.disabled = false; }
  });
}

// ================= VENTAS =================
function renderVentas() {
  const Vd = P.ventas;
  const rows = Vd.sucursales.filter((s) => !P.vSoloPrio || s.prioridad);
  const nPrio = Vd.sucursales.filter((s) => s.prioridad).length;
  const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
  wrap.innerHTML = shell(`
    <div class="grid2">
      <div class="card drop" id="vdrop">
        <div style="font-size:17px;font-weight:600">Subir ventas por sucursal</div>
        <div style="font-size:14px;color:var(--muted)">Subí la <strong>Consulta Factura Sucursal</strong> tal como sale de GIA, o la plantilla de ventas. Se reemplazan las ventas de las fechas que trae el archivo, sin duplicar.</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px"><label class="btn dark">Elegir archivo<input type="file" id="vxls" accept=".xlsx" class="sr"></label><a class="btn" href="/plantillas/Plantilla_Ventas_Serrana.xlsx">Descargar plantilla</a></div>
        ${Vd.cargas.length ? `<div class="muted" style="font-size:13px">Última carga: ${esc(Vd.cargas[0].archivo)} · del ${dmy(Vd.cargas[0].desde)} al ${dmy(Vd.cargas[0].hasta)} · ${Vd.cargas[0].filas} filas</div>` : '<div class="pill idle" style="align-self:flex-start">Todavía no se cargaron ventas</div>'}
      </div>
      <div class="card" style="padding:22px;display:flex;flex-direction:column;gap:8px">
        <div style="font-size:17px;font-weight:600">Regla de caída (grupo Disco)</div>
        <ol style="margin:0;padding-left:20px;font-size:14px;color:var(--ink2);display:flex;flex-direction:column;gap:6px">
          <li><strong>Caída:</strong> últimos 90 días 30% o más abajo que los mismos 90 días del año anterior (packs, descontando notas de crédito).</li>
          <li><strong>Atraso:</strong> pasó más del doble del tiempo que suele tardar entre una compra y otra.</li>
        </ol>
        <div class="muted" style="font-size:13px">Se calcula a la última fecha de la planilla${Vd.ref ? ` (${dmy(Vd.ref)})` : ''}. Para vincular cada sucursal con su comercio, completá el Código ventas en Comercios.</div>
      </div>
    </div>
    ${Vd.sinCodigo.length ? `<div class="err">Hay ${Vd.sinCodigo.length} comercios del grupo Disco sin código de ventas: ${esc(Vd.sinCodigo.slice(0, 8).map((c) => c.nombre).join(', '))}${Vd.sinCodigo.length > 8 ? '…' : ''}. Sin código no se puede detectar su caída.</div>` : ''}
    <div class="fil"><label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="vprio" ${P.vSoloPrio ? 'checked' : ''}> Solo las que son prioridad (${nPrio})</label><span class="muted" style="font-size:14px">${Vd.sucursales.length} sucursales del grupo Disco en la planilla</span></div>
    <div class="card tbl">${rows.length ? `<table><thead><tr><th>Código</th><th>Comercio</th><th>Últimos 90 días</th><th>Mismo período año anterior</th><th>Variación</th><th>Última compra</th><th>Días sin comprar</th><th>Prioridad</th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td class="mono">${esc(s.sucursal)}</td><td>${s.comercio ? `<strong>${esc(s.comercio.nombre)}</strong> <span class="muted" style="font-size:13px">${esc(s.comercio.zona)}</span>` : '<span class="muted">Sin vincular (fuera de alcance o falta el código)</span>'}</td>
        <td class="mono">${Math.round(s.ult90)}</td><td class="mono">${Math.round(s.ly90)}</td><td class="mono" style="${s.variacion != null && s.variacion <= -0.3 ? 'color:var(--orange-ink);font-weight:600' : ''}">${pct(s.variacion)}</td>
        <td class="mono">${dmy(s.ultima)}</td><td class="mono">${s.dias_sin ?? '—'}${s.intervalo ? ` <span class="muted" style="font-size:12px">(suele ${Math.round(s.intervalo)})</span>` : ''}</td>
        <td>${s.prioridad ? `<span class="pill warn">${esc(s.motivo)}</span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table>` : '<div style="padding:30px;text-align:center" class="muted">No hay sucursales para mostrar.</div>'}</div>`, 'Ventas Serrana');
  document.getElementById('vprio').addEventListener('change', (e) => { P.vSoloPrio = e.target.checked; renderVentas(); });
  const drop = document.getElementById('vdrop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) subirVentas(e.dataTransfer.files[0]); });
}

async function subirVentas(file) {
  const bg = modal('<h2>Cargando ventas…</h2><div class="muted">Puede tardar unos segundos si la planilla es grande.</div>');
  const fd = new FormData(); fd.append('archivo', file);
  try {
    const r = await api('/api/ventas/import', { method: 'POST', body: fd });
    bg.querySelector('.modal').innerHTML = `<h2>Ventas cargadas</h2><div class="okmsg">${r.filas} filas del ${dmy(r.desde)} al ${dmy(r.hasta)}. ${r.prioridad} ${r.prioridad === 1 ? 'sucursal es' : 'sucursales son'} prioridad.</div>
      ${r.invalidas ? `<div class="muted" style="font-size:14px">${r.invalidas} filas no se tomaron (sin fecha, sucursal o documento SFAC/SNCRED).</div>` : ''}<div style="text-align:right"><button class="btn dark" data-close>Listo</button></div>`;
    P.ventas = await api('/api/ventas'); renderVentas();
  } catch (err) { bg.querySelector('.modal').innerHTML = `<h2>No se pudo cargar</h2><div class="err">${esc(err.message)}</div><div style="text-align:right"><button class="btn" data-close>Cerrar</button></div>`; }
}

// ================= VISITAS =================
async function cargarVisitas() {
  const q = new URLSearchParams(Object.entries(P.vFiltro).filter(([, v]) => v));
  const [vis, barrios] = await Promise.all([api('/api/visits?' + q), P.barrios.length ? P.barrios : api('/api/barrios')]);
  P.visitas = vis; P.barrios = barrios;
  renderVisitas();
}

function renderVisitas() {
  const V = P.visitas, adm = isAdmin();
  const si = V.filter((v) => v.resultado === 'SÍ').length;
  const q = new URLSearchParams(Object.entries(P.vFiltro).filter(([, v]) => v));
  wrap.innerHTML = shell(`
    <div class="fil">
      <label class="sr" for="vm">Mes</label><input type="month" id="vm" value="${esc(P.vFiltro.mes)}">
      <label class="sr" for="vz">Barrio</label><select id="vz"><option value="">Todos los barrios</option>${P.barrios.map((b) => `<option ${P.vFiltro.zona === b.nombre ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('')}</select>
      <label class="sr" for="vt">Tipo</label><select id="vt"><option value="">Todos los tipos</option>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${P.vFiltro.tipo === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      <label class="sr" for="vr">Resultado</label><select id="vr"><option value="">SÍ y NO</option><option value="si" ${P.vFiltro.resultado === 'si' ? 'selected' : ''}>Solo SÍ</option><option value="no" ${P.vFiltro.resultado === 'no' ? 'selected' : ''}>Solo NO</option></select>
      <a class="btn dark" style="margin-left:auto" href="/api/visits/export?${q}">Exportar a Excel</a>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="l">Visitas SÍ</div><div class="v" style="color:var(--green-ink)">${si}</div></div>
      <div class="card kpi"><div class="l">Visitas NO</div><div class="v" style="color:var(--orange)">${V.length - si}</div></div>
      <div class="card kpi"><div class="l">Urgencias</div><div class="v">${V.filter((v) => v.urgencia).length}</div></div>
    </div>
    <div class="card tbl">${V.length ? `<table><thead><tr><th>Fecha y hora</th><th>Barrio</th><th>Tipo</th><th>Comercio</th><th>¿Visitó?</th>${adm ? '<th>Minutos</th><th>Ubicación</th>' : ''}<th>Foto</th><th>Comentarios</th></tr></thead><tbody>
      ${V.map((v) => `<tr><td class="mono" style="font-size:14px">${esc(v.fecha)}</td><td>${esc(v.zona)}</td><td>${badge(v.tipo)}${v.urgencia ? ' <span class="badge URG">URGENCIA</span>' : ''}</td><td style="font-weight:600">${esc(v.sucursal)}${v.convertido ? ' <span class="pill ok" style="font-size:11px">Pasó a cliente</span>' : ''}</td>
        <td><span class="pill ${v.resultado === 'SÍ' ? 'ok' : 'warn'}">${v.resultado}${v.motivo_no ? ' · ' + esc(v.motivo_no) : ''}</span></td>
        ${adm ? `<td class="mono">${v.minutos ?? '—'}</td><td>${v.lat != null ? `<a href="https://www.google.com/maps?q=${v.lat},${v.lng}" target="_blank" rel="noopener">Ver en mapa</a>${v.distancia_m != null ? ` <span class="muted" style="font-size:13px">a ${v.distancia_m} m</span>` : ''}` : '<span class="muted">—</span>'}</td>` : ''}
        <td>${v.foto ? `<button class="thumb" data-act="foto" data-src="${esc(v.foto)}" data-t="${esc(v.sucursal + ' · ' + v.fecha)}" aria-label="Ver foto de ${esc(v.sucursal)}"><img class="thumb" src="${esc(v.foto)}" alt="" loading="lazy"></button>` : '<span class="muted">—</span>'}</td>
        <td style="white-space:normal;min-width:220px;font-size:14px">${esc([v.estandar, v.comentario].filter(Boolean).join(' · '))}</td></tr>`).join('')}
    </tbody></table>` : '<div style="padding:30px;text-align:center" class="muted">No hay visitas con esos filtros.</div>'}</div>`, 'Visitas');
  const on = (id, k) => document.getElementById(id).addEventListener('change', (e) => { P.vFiltro[k] = e.target.value; cargarVisitas().catch((er) => toast(er.message)); });
  on('vm', 'mes'); on('vz', 'zona'); on('vt', 'tipo'); on('vr', 'resultado');
}

// ================= CONTROL DE JORNADA =================
async function cargarControl() {
  P.control = await api(`/api/control?fecha=${P.cFecha}&${qU()}`);
  renderControl();
}

function renderControl() {
  const C = P.control, R = C.resumen;
  const dotFor = { inicio: 'background:var(--green)', fin: 'background:var(--orange)', visita: 'background:var(--ink)', traslado: 'background:#fff;border:2px solid #9AA39D', abierta: 'background:#fff;border:2px solid var(--orange)' };
  wrap.innerHTML = shell(`
    <div class="fil">
      <label for="cf" class="muted" style="font-size:14px">Día</label><input type="date" id="cf" value="${esc(P.cFecha)}">${selVendedor()}
    </div>
    ${R ? `<div class="kpis">
      <div class="card kpi"><div class="l">Jornada</div><div class="v">${minTexto(R.jornada_min)}</div><div class="l">${R.inicio} → ${R.fin || 'en curso'}</div></div>
      <div class="card kpi"><div class="l">En visitas</div><div class="v">${minTexto(R.visitas_min)}</div><div class="l">${R.visitas} ${R.visitas === 1 ? 'visita' : 'visitas'}${R.visitas ? ` · ${Math.round(R.visitas_min / R.visitas)} min promedio` : ''}</div></div>
      <div class="card kpi"><div class="l">Traslados</div><div class="v">${minTexto(R.traslados_min)}</div></div>
      <div class="card kpi"><div class="l">Sin actividad</div><div class="v" style="${R.sin_actividad_min > 60 ? 'color:var(--orange)' : ''}">${minTexto(R.sin_actividad_min)}</div><div class="l">antes del fin de jornada</div></div>
      <div class="card kpi"><div class="l">Fotos en el lugar</div><div class="v" style="${R.fotos_ok < R.fotos_total ? 'color:var(--orange)' : ''}">${R.fotos_ok}/${R.fotos_total}</div><div class="l">a menos de 300 m</div></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
      <div class="card" style="flex:999 1 560px;min-width:0;padding:4px 20px">
        ${C.eventos.map((e) => `<div class="ev" style="${e.tipo === 'fin' ? 'background:#FDF6F1;margin:0 -20px;padding:14px 20px' : e.tipo === 'traslado' ? 'color:var(--muted)' : ''}">
          <div class="t">${esc(e.hora)}</div><div class="dot" style="${dotFor[e.tipo]};box-sizing:border-box"></div>
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:baseline"><span style="font-size:15px;font-weight:600">${esc(e.titulo)}</span>
              ${e.tipo_comercio ? badge(Object.keys(TIPOS).find((k) => TIPOS[k][0] === e.tipo_comercio)) : ''}${e.urgencia ? '<span class="badge URG">URGENCIA</span>' : ''}${e.resultado ? `<span class="pill ${e.resultado === 'SÍ' ? 'ok' : 'warn'}">${e.resultado}</span>` : ''}
              ${e.distancia ? `<span class="pill ${e.lejos ? 'warn' : 'ok'}">marcó a ${esc(e.distancia)}</span>` : ''}</div>
            <div style="font-size:13px;color:var(--muted)">${esc(e.detalle)}</div>
            ${e.foto ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px"><button class="thumb" data-act="foto" data-src="${esc(e.foto)}" data-t="${esc(e.titulo + ' · foto ' + e.foto_hora)}" aria-label="Ver foto"><img class="thumb" src="${esc(e.foto)}" alt="" loading="lazy"></button>
              <span class="mono" style="font-size:12px;color:var(--ink2)">Foto ${esc(e.foto_hora)}${e.foto_geo ? ' · ' + esc(e.foto_geo) : ' · sin ubicación'}</span>
              ${e.foto_distancia ? `<span class="pill ${e.foto_lejos ? 'warn' : 'ok'}">a ${esc(e.foto_distancia)} del comercio</span>` : ''}</div>` : ''}
            ${(e.tipo === 'inicio' || e.tipo === 'fin') ? (e.lat != null ? `<a href="https://www.google.com/maps?q=${e.lat},${e.lng}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600">Ver ubicación en el mapa</a> <span class="mono" style="font-size:12px;color:var(--muted)">${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}</span>` : '<span class="pill warn">Sin ubicación</span>') : ''}
          </div></div>`).join('')}
      </div>
      <div style="flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:12px">
        <div class="card" style="padding:18px;display:flex;flex-direction:column;gap:10px"><div style="font-size:16px;font-weight:600">Alertas del día</div>
          ${C.alertas.length ? C.alertas.map((a) => `<div class="err">${esc(a)}</div>`).join('') : '<div class="okmsg">Sin alertas.</div>'}</div>
        <div id="map" class="map" style="height:300px" aria-label="Mapa del recorrido"></div>
      </div>
    </div>` : '<div class="card" style="padding:30px;text-align:center"><span class="muted">No hubo jornada ese día.</span></div>'}`, 'Control de jornada');
  document.getElementById('cf').addEventListener('change', (e) => { P.cFecha = e.target.value; cargarControl().catch((er) => toast(er.message)); });
  if (R && C.puntos.length && window.L) {
    mapa = L.map('map', { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
    const ll = C.puntos.map((p) => [p.lat, p.lng]);
    L.polyline(ll, { color: '#17201B', weight: 2, dashArray: '6 6' }).addTo(mapa);
    let n = 0;
    C.puntos.forEach((p) => {
      const color = p.tipo === 'inicio' ? '#1F6B4F' : p.tipo === 'fin' ? '#A8461A' : '#17201B';
      const label = p.tipo === 'inicio' ? 'Inicio' : p.tipo === 'fin' ? 'Fin de jornada' : `${++n}. ${p.nombre}`;
      L.circleMarker([p.lat, p.lng], { radius: p.tipo === 'visita' ? 7 : 10, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).bindPopup(esc(label)).addTo(mapa);
    });
    mapa.fitBounds(ll, { padding: [30, 30], maxZoom: 16 });
  }
}

// ================= BARRIOS Y LISTAS =================
function renderConfig() {
  const L = P.listas;
  wrap.innerHTML = shell(`
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
      <section class="card" style="flex:999 1 560px;min-width:0;padding:18px;display:flex;flex-direction:column;gap:12px">
        <h2 class="h2">Barrios y sus linderos</h2>
        <div class="muted" style="font-size:14px">Al armar la semana, el sistema suma los barrios linderos de los que elijas. Escribí los linderos separados por coma.</div>
        <div class="tbl"><table id="tb-barrios"><thead><tr><th>Barrio</th><th>Ciudad</th><th>Linderos</th><th><span class="sr">Quitar</span></th></tr></thead><tbody>
          ${P.barrios.map((b) => filaBarrio(b)).join('')}
        </tbody></table></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="addBarrio">+ Agregar barrio</button><button class="btn dark" data-act="saveBarrios">Guardar barrios</button></div>
      </section>
      <section class="card" style="flex:1 1 340px;min-width:0;padding:18px;display:flex;flex-direction:column;gap:12px">
        <h2 class="h2">Comentarios estándar y motivos</h2>
        <div class="muted" style="font-size:14px">Uno por línea. Es lo que el vendedor elige en el formulario de visita.</div>
        ${Object.entries(L.nombres).map(([k, n]) => `<label class="f">${esc(n)}<textarea data-lista="${k}" rows="${Math.max(4, L.listas[k].length + 1)}">${esc(L.listas[k].join('\n'))}</textarea></label>`).join('')}
        <button class="btn dark" data-act="saveListas" style="align-self:flex-start">Guardar listas</button>
      </section>
    </div>`, 'Barrios y listas');
}

function filaBarrio(b = { nombre: '', ciudad: 'Montevideo', linderos: '' }) {
  return `<tr><td><input aria-label="Barrio" data-b="nombre" value="${esc(b.nombre)}" style="width:170px"></td>
    <td><select aria-label="Ciudad" data-b="ciudad">${['Montevideo', 'Ciudad de la Costa'].map((x) => `<option ${b.ciudad === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td><input aria-label="Linderos" data-b="linderos" value="${esc(b.linderos)}" style="width:100%;min-width:320px"></td>
    <td><button class="iconbtn" data-act="delBarrio" aria-label="Quitar barrio">${ICON_DEL}</button></td></tr>`;
}

// ================= EVENTOS =================
wrap.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (['marcar', 'mtodos', 'mover', 'sdia', 'usel'].includes(act)) return;
  const S = P.sem;
  try {
    if (act === 'tab') await abrir(el.dataset.t);
    else if (act === 'salir') { await api('/api/logout', { method: 'POST' }); location.href = '/ingresar'; }
    else if (act === 'clave') cambiarClave();
    else if (act === 'semPrev' || act === 'semNext' || act === 'semHoy') {
      S.semana = act === 'semHoy' ? lunes(hoyISO()) : addDays(S.semana, act === 'semPrev' ? -7 : 7); S.sug = null; S.marcados = new Set();
      await cargarSemana();
    } else if (act === 'barrio') {
      const b = el.dataset.b;
      S.elegidos = S.elegidos.includes(b) ? S.elegidos.filter((x) => x !== b) : [...S.elegidos, b];
      await buscarSugeridos();
    } else if (act === 'agregarSem') {
      const items = S.sug.sugeridos.filter((s) => S.marcados.has(s.client.id)).map((s) => ({ client_id: s.client.id, fecha: S.dia, motivo: s.motivo }));
      const r = await api('/api/semana/items', { json: { semana: S.semana, items, usuario: P.usuario } });
      S.data = r; toast(`${r.guardados} ${r.guardados === 1 ? 'visita agregada' : 'visitas agregadas'}.`);
      await buscarSugeridos();
    } else if (act === 'agregarUno') {
      const r = await api('/api/semana/items', { json: { semana: S.semana, items: [{ client_id: Number(el.dataset.id), fecha: S.dia, motivo: 'Agregado a mano' }], usuario: P.usuario } });
      S.data = r; S.buscar = ''; toast('Visita agregada.');
      if (S.elegidos.length) await buscarSugeridos(); else renderSemana();
    } else if (act === 'quitar') {
      S.data = await api(`/api/semana/items/${el.dataset.id}`, { method: 'DELETE' });
      if (S.elegidos.length) await buscarSugeridos(); else renderSemana();
    } else if (act === 'publicar' || act === 'despublicar') {
      S.data = await api('/api/semana/publicar', { json: { semana: S.semana, publicar: act === 'publicar', usuario: P.usuario } });
      toast(act === 'publicar' ? 'Semana publicada: el vendedor ya la ve en la app.' : 'Semana despublicada.');
      renderSemana();
    } else if (act === 'vista') {
      await api(`/api/alertas/${el.dataset.id}/vista`, { method: 'POST' });
      P.dash.alertas = P.dash.alertas.filter((a) => a.id !== Number(el.dataset.id)); renderDash();
    } else if (act === 'verdia') { e.preventDefault(); P.cFecha = el.dataset.d; await abrir('control'); }
    else if (act === 'nueva') nuevoComercio();
    else if (act === 'link') pegarLink(Number(el.closest('tr').dataset.id));
    else if (act === 'convertir') {
      const id = Number(el.closest('tr').dataset.id);
      const c = P.clients.find((x) => x.id === id);
      if (await confirmar('¿Pasó a cliente?', `"${c.nombre}" pasa a ser Cliente BEC y se visita 2 veces por año (lo podés cambiar).`, 'Pasó a cliente')) {
        await api(`/api/clients/${id}/convertir`, { method: 'POST' });
        P.clients = await api('/api/clients'); renderComercios(); toast('Ahora es Cliente BEC.');
      }
    } else if (act === 'borrar') {
      const id = Number(el.closest('tr').dataset.id);
      const c = P.clients.find((x) => x.id === id);
      if (await confirmar('¿Eliminar comercio?', `"${c.nombre}" deja de aparecer en la tabla y en las sugerencias. Su historial de visitas se conserva.`, 'Eliminar')) {
        await api(`/api/clients/${id}`, { method: 'DELETE' });
        P.clients = P.clients.filter((x) => x.id !== id);
        renderComercios(); toast('Comercio eliminado.');
      }
    } else if (act === 'addBarrio') { document.querySelector('#tb-barrios tbody').insertAdjacentHTML('beforeend', filaBarrio()); }
    else if (act === 'delBarrio') { el.closest('tr').remove(); }
    else if (act === 'saveBarrios') {
      const list = [...document.querySelectorAll('#tb-barrios tbody tr')].map((tr) => ({ nombre: tr.querySelector('[data-b="nombre"]').value.trim(), ciudad: tr.querySelector('[data-b="ciudad"]').value, linderos: tr.querySelector('[data-b="linderos"]').value }))
        .filter((b) => b.nombre);
      await api('/api/barrios', { method: 'PUT', json: list });
      P.barrios = await api('/api/barrios'); toast('Barrios guardados.'); renderConfig();
    } else if (act === 'saveListas') {
      const body = {};
      document.querySelectorAll('[data-lista]').forEach((t) => { body[t.dataset.lista] = t.value.split('\n').map((s) => s.trim()).filter(Boolean); });
      const r = await api('/api/listas', { method: 'PUT', json: body });
      P.listas.listas = r.listas; toast('Listas guardadas.'); renderConfig();
    } else if (act === 'foto') {
      const lb = document.createElement('div');
      lb.className = 'lb';
      lb.innerHTML = `<img src="${esc(el.dataset.src)}" alt="${esc(el.dataset.t)}"><div>${esc(el.dataset.t)}</div><button class="btn sm">Cerrar</button>`;
      lb.addEventListener('click', () => lb.remove());
      document.body.appendChild(lb);
    }
  } catch (err) { toast(err.message, 5000); }
});

wrap.addEventListener('change', async (e) => {
  const t = e.target, S = P.sem;
  try {
    if (t.id === 'xls' && t.files[0]) { previewImport(t.files[0]); t.value = ''; }
    else if (t.id === 'vxls' && t.files[0]) { subirVentas(t.files[0]); t.value = ''; }
    else if (t.dataset.act === 'fb') { P.fc.barrio = t.value; renderComercios(); }
    else if (t.dataset.act === 'ft') { P.fc.tipo = t.value; renderComercios(); }
    else if (t.dataset.act === 'usel') { P.usuario = t.value; await abrir(P.tab); }
    else if (t.dataset.act === 'marcar') { const id = Number(t.dataset.id); if (t.checked) S.marcados.add(id); else S.marcados.delete(id); renderSemana(); }
    else if (t.dataset.act === 'mtodos') { S.marcados = t.checked ? new Set(S.sug.sugeridos.map((s) => s.client.id)) : new Set(); renderSemana(); }
    else if (t.dataset.act === 'sdia') { S.dia = t.value; renderSemana(); }
    else if (t.dataset.act === 'mover') { S.data = await api(`/api/semana/items/${t.dataset.id}`, { method: 'PATCH', json: { fecha: t.value } }); renderSemana(); }
    else if (t.dataset.f) guardarCampo(t);
  } catch (err) { toast(err.message, 5000); }
});

function cambiarClave() {
  const bg = modal(`<h2>Cambiar contraseña</h2><form id="fc" style="display:flex;flex-direction:column;gap:12px">
    <label class="f">Contraseña actual<input type="password" name="current" autocomplete="current-password" required></label>
    <label class="f">Nueva contraseña (mínimo 6 caracteres)<input type="password" name="next" autocomplete="new-password" required minlength="6"></label>
    <div class="err" id="fc-e" hidden></div>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn dark">Guardar</button></div></form>`);
  const f = bg.querySelector('#fc');
  f.current.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/password', { json: { current: f.current.value, next: f.next.value } }); bg.remove(); toast('Contraseña cambiada.'); }
    catch (err) { const er = bg.querySelector('#fc-e'); er.textContent = err.message; er.hidden = false; }
  });
}

init().catch((err) => { wrap.innerHTML = `<div class="err">${esc(err.message)}</div>`; });
