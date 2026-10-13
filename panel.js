// Panel web de gestión (administrador y vendedor)
const P = { me: null, tab: 'clientes', clients: [], zonas: null, zonaSel: null, filtroZona: 'Todas', filtroEmpresa: '', buscar: '', visitas: [], vFiltro: { mes: '', zona: '', resultado: '' }, control: null, cFecha: '', cUsuario: '', usuarios: [] };
const wrap = document.getElementById('wrap');
let mapa = null;
const ST = {
  visitada: { l: 'Visitada este mes', cls: 'ok', color: '#1F6B4F' },
  postergada: { l: 'Quedó pendiente · vuelve primero', cls: 'warn', color: '#D9875A' },
  pendiente: { l: 'Sin visitar', cls: 'idle', color: '#FFFFFF' }
};
const ICON_DEL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';

function mesActual() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7); }
function hoyISO() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function nombreMes(ym) { const [y, m] = ym.split('-').map(Number); return new Intl.DateTimeFormat('es-UY', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15))); }
function isAdmin() { return P.me?.role === 'admin'; }

async function init() {
  P.me = await api('/api/me');
  P.vFiltro.mes = mesActual();
  P.cFecha = hoyISO();
  const t = (location.hash || '').slice(1);
  if (['clientes', 'zonas', 'visitas', 'control'].includes(t) && (t !== 'control' || isAdmin())) P.tab = t;
  await abrir(P.tab);
}

function shell(inner, titulo) {
  const tabs = [['clientes', 'Clientes'], ['zonas', 'Zonas del mes'], ['visitas', 'Visitas']];
  if (isAdmin()) tabs.push(['control', 'Control de jornada']);
  return `<div class="topbar"><div style="font-size:14px;font-weight:600">Recorridas · Gestión</div>
    <div style="display:flex;align-items:center;gap:10px;font-size:14px;flex-wrap:wrap">
      <span class="pill" style="${isAdmin() ? 'background:var(--ink);color:#fff' : 'background:var(--blue-bg);color:var(--blue-ink)'}">${isAdmin() ? 'Administrador' : 'Vendedor'}</span>
      <span class="mono">${esc(P.me.username)}</span>
      <button class="btn sm" data-act="clave">Cambiar contraseña</button>
      <button class="btn sm" data-act="salir">Salir</button></div></div>
    <div class="head"><div style="display:flex;flex-direction:column;gap:6px"><div class="kick">Recorridas</div><h1>${esc(titulo)}</h1></div>
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${P.tab === k}" data-act="tab" data-t="${k}">${l}</button>`).join('')}</div></div>
    ${inner}`;
}

async function abrir(tab) {
  P.tab = tab;
  history.replaceState(null, '', '#' + tab);
  if (mapa) { mapa.remove(); mapa = null; }
  try {
    if (tab === 'clientes') { [P.clients, P.ventas] = await Promise.all([api('/api/clients'), isAdmin() ? api('/api/ventas') : null]); renderClientes(); }
    else if (tab === 'zonas') { P.zonas = await api('/api/zones'); if (!P.zonas.zonas.find((z) => z.zona === P.zonaSel)) P.zonaSel = P.zonas.zonas[0]?.zona || null; renderZonas(); }
    else if (tab === 'visitas') { await cargarVisitas(); }
    else if (tab === 'control') { if (!P.usuarios.length) P.usuarios = (await api('/api/users')).filter((u) => u.role === 'vendedor'); if (!P.cUsuario && P.usuarios[0]) P.cUsuario = String(P.usuarios[0].id); await cargarControl(); }
  } catch (err) { toast(err.message, 5000); }
}

// ---------- Clientes ----------
function zonasDe(list) { return [...new Set(list.map((c) => c.zona))].sort((a, b) => a.localeCompare(b, 'es')); }

function renderClientes() {
  const zonas = zonasDe(P.clients);
  if (P.filtroZona !== 'Todas' && !zonas.includes(P.filtroZona)) P.filtroZona = 'Todas';
  const q = P.buscar.trim().toLowerCase();
  const rows = P.clients.filter((c) => (P.filtroZona === 'Todas' || c.zona === P.filtroZona) && (!P.filtroEmpresa || c.empresa === P.filtroEmpresa) &&
    (!q || `${c.nombre} ${c.direccion}`.toLowerCase().includes(q)));
  wrap.innerHTML = shell(`
    <div class="grid2">
      <div class="card drop" id="drop">
        <div style="font-size:17px;font-weight:600">Subir Excel de clientes</div>
        <div style="font-size:14px;color:var(--muted)">Arrastrá el archivo acá o elegilo (.xlsx o .csv). Columnas: <span class="mono" style="color:var(--ink)">Empresa · Nombre · Dirección · Zona · Horario (opcional) · Link Google Maps (opcional) · Código ventas (opcional)</span></div>
        <div style="font-size:14px;color:var(--muted)">Cada archivo se suma a la base. Lo que ya existe (misma ubicación, o mismo nombre y dirección) se actualiza sin duplicarse. Antes de confirmar ves un resumen.</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <label class="btn dark">Elegir archivo<input type="file" id="xls" accept=".xlsx,.csv" class="sr"></label>
          <a class="btn" href="/api/clients/template">Descargar plantilla</a>
        </div>
      </div>
      <div class="card" style="padding:22px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:17px;font-weight:600">Cómo se sugieren las visitas</div>
        <ol style="margin:0;padding-left:20px;font-size:14px;color:var(--ink2);display:flex;flex-direction:column;gap:6px">
          <li>El vendedor elige la zona y cuántas visitas hace hoy.</li>
          <li>Primero entran las que quedaron pendientes la vez anterior.</li>
          <li>Se completa con las más cercanas entre sí que no visitó este mes.</li>
          <li>El orden sale desde donde está y va a la parada más próxima.</li>
        </ol>
        <button class="btn green" data-act="nueva" style="align-self:flex-start;margin-top:4px">+ Agregar sucursal</button>
      </div>
    </div>
    ${isAdmin() ? tarjetaVentas() : ''}
    <div class="fil">
      <div class="chips">${['Todas', ...zonas].map((z) => `<button class="chipb" data-act="fz" data-z="${esc(z)}" aria-pressed="${P.filtroZona === z}">${esc(z)}</button>`).join('')}</div>
      <label class="sr" for="fe">Empresa</label><select id="fe" data-act="fe"><option value="">BEC y MAN</option><option value="BEC" ${P.filtroEmpresa === 'BEC' ? 'selected' : ''}>BEC · restaurantes</option><option value="MAN" ${P.filtroEmpresa === 'MAN' ? 'selected' : ''}>MAN · supermercados</option></select>
      <label class="sr" for="bq">Buscar</label><input id="bq" type="search" placeholder="Buscar nombre o dirección" value="${esc(P.buscar)}">
      <span class="muted" style="font-size:14px">${rows.length} de ${P.clients.length} sucursales</span>
    </div>
    <div class="card tbl">
      ${P.clients.length ? `<table><thead><tr><th>Empresa</th><th>Nombre</th><th>Dirección</th><th>Zona</th><th>Código ventas</th><th>Horario</th><th>Link Google Maps</th><th>Este mes</th><th><span class="sr">Acciones</span></th></tr></thead><tbody>
      ${rows.map((c) => `<tr data-id="${c.id}">
        <td><select aria-label="Empresa" data-f="empresa"><option ${c.empresa === 'BEC' ? 'selected' : ''}>BEC</option><option ${c.empresa === 'MAN' ? 'selected' : ''}>MAN</option></select></td>
        <td><input aria-label="Nombre" data-f="nombre" value="${esc(c.nombre)}" style="width:230px"></td>
        <td><input aria-label="Dirección" data-f="direccion" value="${esc(c.direccion)}" style="width:190px"></td>
        <td><input aria-label="Zona" data-f="zona" value="${esc(c.zona)}" style="width:120px" list="dl-zonas"></td>
        <td><input aria-label="Código de ventas" data-f="codigo" value="${esc(c.codigo)}" placeholder="—" style="width:96px" class="mono"></td>
        <td><input aria-label="Horario" data-f="horario" value="${esc(c.horario)}" placeholder="—" style="width:110px" class="mono"></td>
        <td><input aria-label="Link de Google Maps" data-f="link" value="${esc(c.link)}" style="width:220px;font-size:12px" class="mono"> <a href="https://www.google.com/maps?q=${c.lat},${c.lng}" target="_blank" rel="noopener" style="font-size:13px">ver</a>${c.geo_fuente !== 'link' ? ` <span class="pill ${c.geo_fuente === 'zona' ? 'warn' : 'idle'}" title="Ubicada por ${c.geo_fuente === 'zona' ? 'zona (muy aproximado)' : 'dirección'}: pegá el link de Maps para que quede exacta">≈ ${c.geo_fuente === 'zona' ? 'zona' : 'dirección'}</span>` : ''}</td>
        <td><span class="pill ${ST[c.status].cls}">${c.status === 'visitada' ? 'Visitada' : c.status === 'postergada' ? 'Pendiente anterior' : 'Sin visitar'}</span> ${pillUrg(c.urgencia)}</td>
        <td><button class="iconbtn" data-act="borrar" aria-label="Eliminar ${esc(c.nombre)}">${ICON_DEL}</button></td></tr>`).join('')}
      </tbody></table><datalist id="dl-zonas">${zonas.map((z) => `<option value="${esc(z)}">`).join('')}</datalist>` : '<div style="padding:30px;text-align:center" class="muted">Todavía no hay sucursales. Subí el Excel o agregalas una por una.</div>'}
    </div>`, 'Clientes a visitar');
  const bq = document.getElementById('bq');
  bq.addEventListener('input', () => { P.buscar = bq.value; const pos = bq.selectionStart; renderClientes(); const nb = document.getElementById('bq'); nb.focus(); nb.setSelectionRange(pos, pos); });
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
  if (String(c[f] ?? '') === val) return;
  input.classList.remove('saved', 'bad');
  try {
    const r = await api(`/api/clients/${id}`, { method: 'PATCH', json: { [f]: val } });
    Object.assign(c, r.client);
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 1500);
    if (['zona', 'link', 'codigo', 'direccion'].includes(f)) { if (f === 'codigo' || f === 'link') P.clients = await api('/api/clients'); renderClientes(); }
  } catch (err) {
    input.value = c[f] ?? '';
    input.classList.add('bad');
    toast(err.message, 5000);
  }
}

function modal(html) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(bg);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) bg.remove(); });
  return bg;
}

function nuevaSucursal() {
  const zonas = zonasDe(P.clients);
  const bg = modal(`<h2>Agregar sucursal</h2>
    <form id="fn" style="display:flex;flex-direction:column;gap:12px">
      <label class="f">Empresa<select name="empresa"><option value="BEC">BEC · restaurante</option><option value="MAN">MAN · supermercado</option></select></label>
      <label class="f">Nombre<input name="nombre" required></label>
      <label class="f">Dirección<input name="direccion"></label>
      <label class="f">Zona<input name="zona" list="dl-z2" required></label><datalist id="dl-z2">${zonas.map((z) => `<option value="${esc(z)}">`).join('')}</datalist>
      <label class="f">Horario (opcional)<input name="horario" placeholder="10:00-12:00"></label>
      <label class="f">Código ventas (opcional, solo Disco, Devoto o Geant)<input name="codigo" placeholder="ej.: DISCO27"></label>
      <label class="f">Link de Google Maps (opcional: sin link se ubica por la dirección)<input name="link" placeholder="https://maps.app.goo.gl/…"></label>
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
      bg.remove(); toast('Sucursal agregada.');
      await abrir('clientes');
    } catch (err) { er.textContent = err.message; er.hidden = false; b.disabled = false; }
  });
}

async function previewImport(file) {
  const bg = modal('<h2>Revisando el archivo…</h2><div class="muted">Leyendo filas y ubicaciones. Si hay sucursales sin link de Maps, el sistema las busca por dirección: puede tardar 1 o 2 minutos la primera vez.</div>');
  const fd = new FormData();
  fd.append('archivo', file);
  let p;
  try { p = await api('/api/clients/import/preview', { method: 'POST', body: fd }); }
  catch (err) { bg.querySelector('.modal').innerHTML = `<h2>No se pudo importar</h2><div class="err">${esc(err.message)}</div><div style="text-align:right"><button class="btn" data-close>Cerrar</button></div>`; return; }
  const n = p.nuevas.length, a = p.actualizadas.length;
  const lista = (arr, fn) => `<div class="list-sm">${arr.map(fn).join('')}</div>`;
  bg.querySelector('.modal').innerHTML = `<h2>Importar ${esc(p.archivo)}</h2>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
      <div class="card kpi"><div class="v" style="color:var(--green-ink)">${n}</div><div class="l">Nuevas</div></div>
      <div class="card kpi"><div class="v">${a}</div><div class="l">Se actualizan</div></div>
      <div class="card kpi"><div class="v">${p.sinCambios}</div><div class="l">Ya estaban igual</div></div>
      <div class="card kpi"><div class="v" style="color:${p.errores.length ? 'var(--orange)' : 'inherit'}">${p.errores.length}</div><div class="l">Con errores</div></div>
    </div>
    ${p.aprox ? `<div class="muted" style="font-size:14px">${p.aprox} ${p.aprox === 1 ? 'sucursal se ubicó' : 'sucursales se ubicaron'} por dirección (aproximado). En la tabla quedan marcadas con ≈; si alguna queda mal, pegale el link de Google Maps.</div>` : ''}
    ${p.repetidasArchivo ? `<div class="muted" style="font-size:14px">${p.repetidasArchivo} ${p.repetidasArchivo === 1 ? 'fila estaba repetida' : 'filas estaban repetidas'} dentro del archivo: queda una sola.</div>` : ''}
    ${n ? `<div><strong>Nuevas</strong>${lista(p.nuevas, (r) => `<div><span class="badge ${r.empresa}">${r.empresa}</span> ${esc(r.nombre)} · <span class="muted">${esc(r.zona)}</span></div>`)}</div>` : ''}
    ${a ? `<div><strong>Se actualizan</strong>${lista(p.actualizadas, (r) => `<div>${esc(r.nombre)} · <span class="muted">${r.reactivar ? 'se vuelve a activar' : 'cambia: ' + esc(r.cambios.join(', '))}</span></div>`)}</div>` : ''}
    ${p.posibles.length ? `<div><strong>Posibles repetidos</strong> <span class="muted" style="font-size:14px">— mismo nombre y zona que una sucursal cargada, pero en otra ubicación. Marcá solo las que sean otra sucursal.</span>
      ${lista(p.posibles, (r) => `<div><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-pos="${r.fila}" style="margin-top:4px"> <span>Fila ${r.fila}: ${esc(r.nombre)} (${esc(r.direccion)}) <span class="muted">· parecida a "${esc(r.parecido.nombre)}" (${esc(r.parecido.direccion)})</span></span></label></div>`)}</div>` : ''}
    ${p.errores.length ? `<div><strong style="color:var(--orange-ink)">Filas con errores (no se importan)</strong>${lista(p.errores, (r) => `<div>Fila ${r.fila}${r.nombre ? ` · ${esc(r.nombre)}` : ''}: <span style="color:var(--orange-ink)">${esc(r.motivo)}</span></div>`)}</div>` : ''}
    <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"><button class="btn" data-close>Cancelar</button>
    <button class="btn dark" id="imp-ok" ${n + a + p.posibles.length ? '' : 'disabled'}>Confirmar importación</button></div>`;
  bg.querySelector('#imp-ok').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const incluir = [...bg.querySelectorAll('[data-pos]:checked')].map((x) => Number(x.dataset.pos));
    try {
      const r = await api('/api/clients/import/confirm', { json: { token: p.token, incluirPosibles: incluir } });
      bg.remove();
      toast(`Importación lista: ${r.agregadas} nuevas, ${r.actualizadas} actualizadas.`, 5000);
      await abrir('clientes');
    } catch (err) { toast(err.message, 5000); e.target.disabled = false; }
  });
}

// ---------- Planilla de ventas (Disco, Devoto, Geant) ----------
function pillUrg(u, siempre) {
  if (!u) return siempre ? '<span class="muted">—</span>' : '';
  if (!u.nivel) return siempre ? `<span class="pill ok">Venta hace ${u.dias} d</span>` : '';
  return `<span class="pill ${u.nivel === 'alta' ? 'warn' : 'idle'}" title="${esc(u.ultima ? 'Última venta: ' + u.ultima : '')}">${u.dias == null ? 'Sin ventas registradas' : `Sin ventas hace ${u.dias} d`}</span>`;
}

function fechaCorta(iso) { return iso ? new Date(iso).toLocaleDateString('es-UY', { timeZone: TZ }) : ''; }

function tarjetaVentas() {
  const V = P.ventas || {};
  return `<div class="card" style="padding:22px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between">
    <div style="display:flex;flex-direction:column;gap:6px;max-width:720px">
      <div style="font-size:17px;font-weight:600">Planilla de ventas · Disco, Devoto y Geant</div>
      <div style="font-size:14px;color:var(--muted)">Con la planilla de facturas, los supermercados sin ventas hace 30 días o más se sugieren primero cuando el vendedor elige su zona (después de los que quedaron pendientes). El orden de la recorrida no cambia. Cada sucursal se vincula por su <strong>código de ventas</strong> (ej.: DISCO27, DEV3005, GEANT1).</div>
      <div style="font-size:14px">${V.actualizado ? `Última carga: <strong>${esc(fechaCorta(V.actualizado))}</strong> · ${esc(V.archivo || '')} · ${V.vinculadas} de ${V.total} sucursales vinculadas` : '<span class="muted">Todavía no se cargó ninguna planilla.</span>'}</div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${V.sin_vincular?.length ? `<button class="btn" data-act="sinvinc">Sin vincular (${V.sin_vincular.length})</button>` : ''}
      <label class="btn dark">Subir planilla de ventas<input type="file" id="ventas" accept=".xlsx,.xlsm" class="sr"></label>
    </div>
  </div>`;
}

function listaSinVincular(arr) {
  return `<div class="list-sm" style="max-height:320px">${arr.map((v) => `<div style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap">
    <span><span class="mono" style="font-weight:500">${esc(v.codigo)}</span> · ${esc(v.cadena)} ${esc(v.nombre)}</span>
    <span class="muted" style="font-size:13px">última venta ${esc(v.ultima)} (${v.dias} d)</span></div>`).join('')}</div>`;
}

function verSinVincular() {
  const V = P.ventas;
  modal(`<h2>Sucursales de la planilla sin vincular</h2>
    <div style="font-size:14px;color:var(--ink2)">Estas sucursales de Disco, Devoto y Geant no están asociadas a ningún cliente. Si alguna es parte de las recorridas, escribí su código en la columna <strong>Código ventas</strong> de la tabla (o en el Excel de clientes). Si no se visita, podés ignorarla.</div>
    ${listaSinVincular(V.sin_vincular)}
    <div style="text-align:right"><button class="btn" data-close>Cerrar</button></div>`);
}

async function subirVentas(file) {
  const bg = modal('<h2>Leyendo la planilla de ventas…</h2><div class="muted">Puede tardar unos segundos.</div>');
  const fd = new FormData();
  fd.append('archivo', file);
  try {
    const r = await api('/api/ventas', { method: 'POST', body: fd });
    P.ventas = r;
    const cad = Object.entries(r.porCadena).map(([k, v]) => `${v} de ${k}`).join(', ');
    bg.querySelector('.modal').innerHTML = `<h2>Planilla de ventas cargada</h2>
      <div class="okmsg">${r.total} sucursales con ventas (${esc(cad)}). ${r.vinculadas} vinculadas a clientes de las recorridas.</div>
      ${r.autoVinculadas.length ? `<div><strong>Vinculadas automáticamente por nombre</strong><div class="list-sm">${r.autoVinculadas.map((a) => `<div>${esc(a.nombre)} → <span class="mono">${esc(a.codigo)}</span></div>`).join('')}</div></div>` : ''}
      <div style="font-size:15px">${r.urgentes ? `<strong>${r.urgentes}</strong> ${r.urgentes === 1 ? 'supermercado aparece' : 'supermercados aparecen'} con prioridad por no tener ventas hace 30 días o más.` : 'Ningún supermercado vinculado tiene ventas atrasadas.'}</div>
      ${r.sin_vincular.length ? `<div><strong>Sin vincular (${r.sin_vincular.length})</strong> <span class="muted" style="font-size:14px">— si alguna se visita, poné su código en la columna "Código ventas".</span>${listaSinVincular(r.sin_vincular)}</div>` : ''}
      <div style="text-align:right"><button class="btn dark" data-close>Listo</button></div>`;
    P.clients = await api('/api/clients');
    renderClientes();
  } catch (err) {
    bg.querySelector('.modal').innerHTML = `<h2>No se pudo cargar</h2><div class="err">${esc(err.message)}</div><div style="text-align:right"><button class="btn" data-close>Cerrar</button></div>`;
  }
}

// ---------- Zonas ----------
function renderZonas() {
  const Z = P.zonas;
  const sel = Z.zonas.find((z) => z.zona === P.zonaSel);
  const suc = Z.sucursales.filter((s) => s.zona === P.zonaSel).sort((a, b) => ({ postergada: 0, pendiente: 1, visitada: 2 }[a.status] - { postergada: 0, pendiente: 1, visitada: 2 }[b.status]));
  wrap.innerHTML = shell(Z.zonas.length ? `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
    <div style="flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:10px">
      ${Z.zonas.map((z) => `<button class="zcard" data-act="zsel" data-z="${esc(z.zona)}" aria-pressed="${z.zona === P.zonaSel}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;width:100%"><span style="font-size:17px;font-weight:600">${esc(z.zona)}</span><span class="mono">${z.visitadas}/${z.total}</span></div>
        <div class="zbar" style="width:100%"><div style="width:${z.visitadas / z.total * 100}%;background:var(--green)"></div><div style="width:${z.postergadas / z.total * 100}%;background:var(--orange-mid)"></div></div>
        <div style="font-size:13px;color:var(--ink2)">${z.visitadas} visitadas · ${z.postergadas} pendientes de la vez anterior · ${z.pendientes} sin visitar</div>
        ${z.urgentes ? `<div><span class="pill warn">${z.urgentes} ${z.urgentes === 1 ? 'supermercado' : 'supermercados'} sin ventas hace tiempo</span></div>` : ''}</button>`).join('')}
      <div class="legend"><span><i class="dot" style="background:#1F6B4F;margin:0"></i>Visitada este mes</span><span><i class="dot" style="background:#D9875A;margin:0"></i>Quedó pendiente</span><span><i class="dot" style="background:#fff;border:1.5px solid #5B635E;margin:0"></i>Sin visitar</span></div>
    </div>
    <div style="flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:14px">
      <div id="map" class="map" aria-label="Mapa de ${esc(P.zonaSel)}"></div>
      <div class="card tbl"><table><thead><tr><th>Sucursal</th><th>Empresa</th><th>Estado en ${esc(nombreMes(Z.mes))}</th><th>Ventas</th><th>Última visita</th></tr></thead><tbody>
        ${suc.map((s) => `<tr><td style="font-weight:600">${esc(s.nombre)}</td><td><span class="badge ${s.empresa}">${s.empresa}</span></td><td><span class="pill ${ST[s.status].cls}">${ST[s.status].l}</span></td><td>${pillUrg(s.urgencia, true)}</td>
        <td class="mono" style="font-size:14px">${s.last_visit_at ? `${new Date(s.last_visit_at).toLocaleDateString('es-UY', { timeZone: TZ })} ${hora(s.last_visit_at)} · ${s.last_result === 'si' ? 'SÍ' : 'NO'}` : '—'}</td></tr>`).join('')}
      </tbody></table></div>
    </div></div>` : '<div class="card muted" style="padding:30px;text-align:center">Todavía no hay sucursales cargadas.</div>', `Zonas en ${nombreMes(Z.mes)}`);
  if (sel && window.L) {
    mapa = L.map('map', { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
    const pts = [];
    suc.forEach((s) => {
      if (s.lat == null) return;
      pts.push([s.lat, s.lng]);
      L.circleMarker([s.lat, s.lng], { radius: 9, color: s.status === 'pendiente' ? '#5B635E' : '#fff', weight: 2, fillColor: ST[s.status].color, fillOpacity: 1 })
        .bindPopup(`<strong>${esc(s.nombre)}</strong><br>${esc(s.direccion)}<br>${ST[s.status].l}`).addTo(mapa);
    });
    if (pts.length) mapa.fitBounds(pts, { padding: [30, 30], maxZoom: 16 }); else mapa.setView([-34.85, -56.0], 11);
  }
}

// ---------- Visitas ----------
async function cargarVisitas() {
  const q = new URLSearchParams(Object.entries(P.vFiltro).filter(([, v]) => v));
  const [vis, zonas] = await Promise.all([api('/api/visits?' + q), P.zonas ? Promise.resolve(P.zonas) : api('/api/zones')]);
  P.visitas = vis; P.zonas = zonas;
  renderVisitas();
}

function renderVisitas() {
  const V = P.visitas, adm = isAdmin();
  const si = V.filter((v) => v.resultado === 'SÍ').length;
  const total = P.zonas.zonas.reduce((a, z) => a + z.total, 0), vis = P.zonas.zonas.reduce((a, z) => a + z.visitadas, 0);
  const q = new URLSearchParams(Object.entries(P.vFiltro).filter(([, v]) => v));
  wrap.innerHTML = shell(`
    <div class="fil">
      <label class="sr" for="vm">Mes</label><input type="month" id="vm" value="${esc(P.vFiltro.mes)}">
      <label class="sr" for="vz">Zona</label><select id="vz"><option value="">Todas las zonas</option>${P.zonas.zonas.map((z) => `<option ${P.vFiltro.zona === z.zona ? 'selected' : ''}>${esc(z.zona)}</option>`).join('')}</select>
      <label class="sr" for="vr">Resultado</label><select id="vr"><option value="">SÍ y NO</option><option value="si" ${P.vFiltro.resultado === 'si' ? 'selected' : ''}>Solo SÍ</option><option value="no" ${P.vFiltro.resultado === 'no' ? 'selected' : ''}>Solo NO</option></select>
      <a class="btn dark" style="margin-left:auto" href="/api/visits/export?${q}">Exportar a Excel</a>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="l">Visitas SÍ</div><div class="v" style="color:var(--green-ink)">${si}</div></div>
      <div class="card kpi"><div class="l">Visitas NO</div><div class="v" style="color:var(--orange)">${V.length - si}</div></div>
      <div class="card kpi"><div class="l">Cobertura de ${esc(nombreMes(mesActual()))}</div><div class="v">${total ? Math.round(vis / total * 100) : 0}%</div><div class="l">${vis} de ${total} sucursales</div></div>
    </div>
    <div class="card tbl">${V.length ? `<table><thead><tr><th>Fecha y hora</th><th>Zona</th><th>Empresa</th><th>Sucursal</th><th>¿Visita?</th>${adm ? '<th>Minutos</th><th>Ubicación</th>' : ''}<th>Foto</th><th>Comentarios</th></tr></thead><tbody>
      ${V.map((v) => `<tr><td class="mono" style="font-size:14px">${esc(v.fecha)}</td><td>${esc(v.zona)}</td><td><span class="badge ${v.empresa}">${v.empresa}</span></td><td style="font-weight:600">${esc(v.sucursal)}</td>
        <td><span class="pill ${v.resultado === 'SÍ' ? 'ok' : 'warn'}">${v.resultado}</span></td>
        ${adm ? `<td class="mono">${v.minutos ?? '—'}</td><td>${v.lat != null ? `<a href="https://www.google.com/maps?q=${v.lat},${v.lng}" target="_blank" rel="noopener">Ver en mapa</a>${v.distancia_m != null ? ` <span class="muted" style="font-size:13px">a ${v.distancia_m} m</span>` : ''}` : '<span class="muted">—</span>'}</td>` : ''}
        <td>${v.foto ? `<button class="thumb" data-act="foto" data-src="${esc(v.foto)}" data-t="${esc(v.sucursal + ' · ' + v.fecha)}" aria-label="Ver foto de ${esc(v.sucursal)}"><img class="thumb" src="${esc(v.foto)}" alt="" loading="lazy"></button>` : '<span class="muted">—</span>'}</td>
        <td style="white-space:normal;min-width:200px;font-size:14px">${esc(v.comentario)}</td></tr>`).join('')}
    </tbody></table>` : '<div style="padding:30px;text-align:center" class="muted">No hay visitas con esos filtros.</div>'}</div>`, 'Visitas');
  const on = (id, k) => document.getElementById(id).addEventListener('change', (e) => { P.vFiltro[k] = e.target.value; cargarVisitas().catch((er) => toast(er.message)); });
  on('vm', 'mes'); on('vz', 'zona'); on('vr', 'resultado');
}

// ---------- Control de jornada ----------
async function cargarControl() {
  P.control = await api(`/api/control?fecha=${P.cFecha}&usuario=${P.cUsuario}`);
  renderControl();
}

function renderControl() {
  const C = P.control, R = C.resumen, E = C.estimaciones;
  const dotFor = { inicio: 'background:var(--green)', fin: 'background:var(--orange)', visita: 'background:var(--ink)', traslado: 'background:#fff;border:2px solid #9AA39D', abierta: 'background:#fff;border:2px solid var(--orange)' };
  wrap.innerHTML = shell(`
    <div class="fil">
      <label for="cf" class="muted" style="font-size:14px">Día</label><input type="date" id="cf" value="${esc(P.cFecha)}">
      <label for="cu" class="muted" style="font-size:14px">Vendedor</label><select id="cu">${P.usuarios.map((u) => `<option value="${u.id}" ${String(u.id) === P.cUsuario ? 'selected' : ''}>${esc(u.username)}</option>`).join('')}</select>
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
              ${e.empresa ? `<span class="badge ${e.empresa}">${e.empresa}</span>` : ''}${e.resultado ? `<span class="pill ${e.resultado === 'SÍ' ? 'ok' : 'warn'}">${e.resultado}</span>` : ''}
              ${e.distancia ? `<span class="pill ${e.lejos ? 'warn' : 'ok'}">marcó a ${esc(e.distancia)}</span>` : ''}</div>
            <div style="font-size:13px;color:var(--muted)">${esc(e.detalle)}</div>
            ${e.foto ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px"><button class="thumb" data-act="foto" data-src="${esc(e.foto)}" data-t="${esc(e.titulo + ' · foto ' + e.foto_hora)}" aria-label="Ver foto"><img class="thumb" src="${esc(e.foto)}" alt="" loading="lazy"></button>
              <span class="mono" style="font-size:12px;color:var(--ink2)">Foto ${esc(e.foto_hora)}${e.foto_geo ? ' · ' + esc(e.foto_geo) : ' · sin ubicación'}</span>
              ${e.foto_distancia ? `<span class="pill ${e.foto_lejos ? 'warn' : 'ok'}">a ${esc(e.foto_distancia)} de la sucursal</span>` : ''}</div>` : ''}
            ${(e.tipo === 'inicio' || e.tipo === 'fin') ? (e.lat != null ? `<a href="https://www.google.com/maps?q=${e.lat},${e.lng}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600">Ver ubicación en el mapa</a> <span class="mono" style="font-size:12px;color:var(--muted)">${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}</span>` : '<span class="pill warn">Sin ubicación</span>') : ''}
          </div></div>`).join('')}
      </div>
      <div style="flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:12px">
        <div class="card" style="padding:18px;display:flex;flex-direction:column;gap:10px"><div style="font-size:16px;font-weight:600">Alertas del día</div>
          ${C.alertas.length ? C.alertas.map((a) => `<div class="err">${esc(a)}</div>`).join('') : '<div class="okmsg">Sin alertas.</div>'}</div>
        <div id="map" class="map" style="height:300px" aria-label="Mapa del recorrido"></div>
      </div>
    </div>` : '<div class="card" style="padding:30px;text-align:center"><span class="muted">No hubo jornada ese día.</span></div>'}
    <div class="card" style="padding:18px;display:flex;flex-direction:column;gap:10px;max-width:560px">
      <div style="font-size:16px;font-weight:600">Tiempo estimado por visita</div>
      <div style="font-size:13px;color:var(--muted)">Promedio de los últimos 30 días, desde que marca SÍ/NO hasta que guarda. Se usa para estimar cuánto lleva cada recorrida.</div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px">
        <div style="background:var(--orange-bg);border-radius:10px;padding:10px 12px"><div style="font-size:12px;color:var(--orange-ink);font-weight:600">BEC</div><div class="mono" style="font-size:20px">${E.BEC.min} min</div><div style="font-size:11px" class="muted">${E.BEC.n ? E.BEC.n + (E.BEC.n === 1 ? ' visita' : ' visitas') : 'valor inicial'}</div></div>
        <div style="background:var(--blue-bg);border-radius:10px;padding:10px 12px"><div style="font-size:12px;color:var(--blue-ink);font-weight:600">MAN</div><div class="mono" style="font-size:20px">${E.MAN.min} min</div><div style="font-size:11px" class="muted">${E.MAN.n ? E.MAN.n + (E.MAN.n === 1 ? ' visita' : ' visitas') : 'valor inicial'}</div></div>
        <div style="background:var(--soft);border-radius:10px;padding:10px 12px"><div style="font-size:12px;font-weight:600">Traslado</div><div class="mono" style="font-size:20px">${E.traslado.min} min</div><div style="font-size:11px" class="muted">${E.traslado.n ? E.traslado.n + (E.traslado.n === 1 ? ' tramo' : ' tramos') : 'valor inicial'}</div></div>
      </div></div>`, 'Control de jornada');
  document.getElementById('cf').addEventListener('change', (e) => { P.cFecha = e.target.value; cargarControl().catch((er) => toast(er.message)); });
  document.getElementById('cu').addEventListener('change', (e) => { P.cUsuario = e.target.value; cargarControl().catch((er) => toast(er.message)); });
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

// ---------- Eventos ----------
wrap.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    if (act === 'tab') await abrir(el.dataset.t);
    else if (act === 'salir') { await api('/api/logout', { method: 'POST' }); location.href = '/ingresar'; }
    else if (act === 'clave') cambiarClave();
    else if (act === 'fz') { P.filtroZona = el.dataset.z; renderClientes(); }
    else if (act === 'nueva') nuevaSucursal();
    else if (act === 'sinvinc') verSinVincular();
    else if (act === 'borrar') {
      const id = Number(el.closest('tr').dataset.id);
      const c = P.clients.find((x) => x.id === id);
      if (await confirmar('¿Eliminar sucursal?', `"${c.nombre}" deja de aparecer en la tabla y en las recorridas. Su historial de visitas se conserva.`, 'Eliminar')) {
        await api(`/api/clients/${id}`, { method: 'DELETE' });
        P.clients = P.clients.filter((x) => x.id !== id);
        renderClientes(); toast('Sucursal eliminada.');
      }
    } else if (act === 'zsel') { P.zonaSel = el.dataset.z; if (mapa) { mapa.remove(); mapa = null; } renderZonas(); }
    else if (act === 'foto') {
      const lb = document.createElement('div');
      lb.className = 'lb';
      lb.innerHTML = `<img src="${esc(el.dataset.src)}" alt="${esc(el.dataset.t)}"><div>${esc(el.dataset.t)}</div><button class="btn sm">Cerrar</button>`;
      lb.addEventListener('click', () => lb.remove());
      document.body.appendChild(lb);
    }
  } catch (err) { toast(err.message, 5000); }
});

wrap.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'xls' && t.files[0]) { previewImport(t.files[0]); t.value = ''; }
  else if (t.id === 'ventas' && t.files[0]) { subirVentas(t.files[0]); t.value = ''; }
  else if (t.id === 'fe') { P.filtroEmpresa = t.value; renderClientes(); }
  else if (t.dataset.f) guardarCampo(t);
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
