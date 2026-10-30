// App del vendedor (celular)
const S = {
  me: null, plan: null, items: [], rutas: [], asignadas: [], opts: null, zona: null, n: 5, screen: 'cargando', vista: 'hoy', curId: null,
  form: {}, aviso: '', busy: false, est: null, fotoLocal: {}, listas: null, semana: null, comercios: null, barrios: null, ag: null
};
const root = document.getElementById('root');
const TIPO = { serrana: ['SERRANA', 'MAN'], cliente: ['CLIENTE BEC', 'BEC'], prospecto: ['PROSPECTO', 'PROS'] };
const VOLVER = [['1', 'En 1 mes'], ['2', 'En 2 meses'], ['3', 'En 3 meses'], ['6', 'En 6 meses'], ['12', 'En 1 año'], ['0', 'No volver']];
const BACK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';

function badge(c) { const t = TIPO[c.tipo] || TIPO.cliente; return `<span class="badge ${t[1]}">${t[0]}</span>`; }
function motivoColor(m) { return /^Caída/.test(m || '') ? 'var(--orange-ink)' : 'var(--ink2)'; }

async function cargar() {
  S.me = await api('/api/me');
  S.listas = (await api('/api/listas')).listas;
  await recargarPlan();
  S.screen = S.plan ? 'lista' : 'inicio';
  render();
}

function aplicarPlan(d) { S.plan = d.plan; S.items = d.items || []; S.rutas = d.rutas || []; S.asignadas = d.asignadas || []; }
async function recargarPlan() { aplicarPlan(await api('/api/plan/current')); }

async function cargarOpciones() {
  S.opts = await api('/api/plan/options');
  const disp = S.opts.zonas.filter((z) => z.disponibles > 0);
  if (!S.zona || !disp.find((z) => z.zona === S.zona)) S.zona = disp[0]?.zona || null;
  ajustarN();
  estimar();
}

function maxN() { const z = S.opts?.zonas.find((x) => x.zona === S.zona); return z ? Math.min(30, z.disponibles) : 0; }
function ajustarN() { const m = maxN(); if (m) S.n = Math.max(1, Math.min(S.n, m)); }

let estTimer;
function estimar() {
  clearTimeout(estTimer);
  if (!S.zona) { S.est = null; return; }
  estTimer = setTimeout(async () => {
    try { const r = await api('/api/plan/preview', { json: { zona: S.zona, n: S.n } }); S.est = r.minutos; render(); } catch (_) { /* sin estimación */ }
  }, 200);
}

function header(title, extra = '') {
  return `<header class="top"><div class="row"><div class="kick">${esc(hoyTexto())}</div>
    <button class="ghost" data-act="salir">${esc(S.me?.username || '')} · Salir</button></div>
    <h1>${esc(title)}</h1>${extra}</header>`;
}

function tabs() {
  return `<nav class="vtabs" aria-label="Vista"><button data-act="vista" data-v="hoy" aria-pressed="${S.vista === 'hoy'}">Hoy</button>
    <button data-act="vista" data-v="semana" aria-pressed="${S.vista === 'semana'}">Mi semana</button></nav>`;
}

function render() {
  if (S.screen === 'visita') return renderVisita();
  if (S.screen === 'agregar') return renderAgregar();
  if (S.screen === 'plan') return renderPlan();
  if (S.vista === 'semana') return renderSemana();
  if (S.screen === 'lista') return renderLista();
  return renderInicio();
}

// ---------- Hoy, antes de iniciar la jornada ----------
function renderInicio() {
  const A = S.asignadas;
  const barrios = [...new Set(A.map((a) => a.client.zona))];
  root.innerHTML = header(A.length ? `Hoy: ${barrios.join(', ')}` : 'Hoy', A.length ? `<div style="font-size:14px;color:#D5DBD7">${A.length} ${A.length === 1 ? 'visita asignada' : 'visitas asignadas'} por el jefe comercial</div>` : '') + tabs() + `<main>
    ${S.aviso ? `<div class="okmsg" role="status">${esc(S.aviso)}</div>` : ''}
    ${A.length ? A.map((a, i) => `<div class="stop" style="cursor:default">
        <div class="num">${i + 1}</div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${badge(a.client)}<span style="font-size:16px;font-weight:600">${esc(a.client.nombre)}</span></div>
          <div style="font-size:14px;color:var(--muted)">${esc(a.client.direccion)} · ${esc(a.client.zona)}${a.client.horario ? ' · ' + esc(a.client.horario) : ''}</div>
          ${a.motivo ? `<div style="font-size:13px;color:${motivoColor(a.motivo)}">${esc(a.motivo)}</div>` : ''}
        </div></div>`).join('')
      : `<div class="sec"><div style="font-size:16px;font-weight:600">No tenés visitas asignadas para hoy</div>
        <div style="font-size:14px;color:var(--ink2)">Podés iniciar la jornada igual y agregar visitas, o armar una recorrida en un barrio con los comercios a los que les toca visita.</div>
        <button class="btn" data-act="abrirplan">Armar recorrida en un barrio</button></div>`}
  </main>
  <div class="foot"><button class="big" data-act="iniciar" style="background:var(--green);color:#fff" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Buscando tu ubicación…' : 'Iniciar jornada'}</button>
  <div style="font-size:12px;color:var(--muted);text-align:center">Registra la hora y tu ubicación de inicio${A.length ? ' · ordena el recorrido desde donde estás' : ''}</div></div>`;
}

// ---------- Recorrida armada por el vendedor en un barrio ----------
function renderPlan() {
  const zonas = (S.opts?.zonas || []).filter((z) => z.disponibles > 0);
  const m = maxN();
  root.innerHTML = `<header class="vhead"><button class="back" data-act="volverinicio" aria-label="Volver">${BACK}</button>
    <div style="font-size:18px;font-weight:600">¿A qué barrio vas hoy?</div></header><main>
    ${!S.opts ? '<div class="empty">Cargando…</div>' : zonas.length ? '' : '<div class="empty">No hay comercios a los que les toque visita. Pedile al jefe comercial que arme la semana.</div>'}
    ${zonas.map((z) => `<button class="zone" data-act="zona" data-z="${esc(z.zona)}" aria-pressed="${S.zona === z.zona}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;width:100%"><span style="font-size:17px;font-weight:600">${esc(z.zona)}</span>
        <span class="mono" style="font-size:13px;color:var(--muted)">${z.disponibles} para visitar</span></div>
        <div style="font-size:14px;color:var(--ink2)">${[z.caidas && `${z.caidas} con caída de ventas`, z.postergadas && `${z.postergadas} ${z.postergadas === 1 ? 'quedó pendiente' : 'quedaron pendientes'}`].filter(Boolean).join(' · ') || 'Les toca visita'}</div>
      </button>`).join('')}
    ${m ? `<div class="sec" style="flex-direction:row;align-items:center;justify-content:space-between;margin-top:6px">
      <div><div style="font-size:16px;font-weight:600">Cantidad de visitas</div><div style="font-size:13px;color:var(--muted)">Hasta ${m} en ${esc(S.zona)}</div></div>
      <div class="stepper"><button data-act="menos" aria-label="Una visita menos">−</button>
      <div class="mono" style="width:40px;text-align:center;font-size:24px" aria-live="polite">${S.n}</div>
      <button data-act="mas" aria-label="Una visita más">+</button></div></div>
      <div style="font-size:14px;color:var(--ink2);padding:2px 4px">Tiempo estimado: <strong class="mono" style="font-weight:500">${S.est != null ? minTexto(S.est) : '…'}</strong> con traslados</div>` : ''}
  </main>
  <div class="foot"><button class="big" data-act="armar" style="background:var(--green);color:#fff" ${!m || S.busy ? 'disabled' : ''}>${S.busy ? 'Buscando tu ubicación…' : 'Iniciar jornada con esta recorrida'}</button></div>`;
}

// ---------- Jornada en curso ----------
function renderLista() {
  const done = S.items.filter((i) => i.status !== 'pending').length;
  const left = S.items.length - done;
  const pct = S.items.length ? Math.round(done / S.items.length * 100) : 0;
  const sig = S.items.find((i) => i.status === 'pending');
  const rutas = S.rutas.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${S.rutas.map((r) => `<a class="btn sm" style="background:#F3F2EE;border:none" href="${esc(r.url)}" target="_blank" rel="noopener">Ruta en Maps${S.rutas.length > 1 ? ` (${r.desde}–${r.hasta})` : ''}</a>`).join('')}</div>` : '';
  root.innerHTML = header(`Hoy: ${S.plan.zona}`, `<div class="row"><span style="font-size:13px;color:#9FE0BC">Jornada desde ${hora(S.plan.started_at)}</span><span style="font-size:13px;color:#D5DBD7">${done} de ${S.items.length} visitas</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>${rutas}`) + tabs() + `<main>
    ${S.items.length ? '' : '<div class="empty">Todavía no hay visitas en la recorrida. Tocá “Agregar visita”.</div>'}
    ${S.items.map((it) => {
      const c = it.client;
      const tag = it.status === 'si' ? `<div style="font-size:13px;color:var(--green-ink)">SÍ · ${hora(it.visit?.arrived_at)}${it.visit?.saved_at ? '' : ' · falta guardar'}</div>`
        : it.status === 'no' ? `<div style="font-size:13px;color:var(--orange-ink)">NO${it.visit?.motivo_no ? ' · ' + esc(it.visit.motivo_no) : ''} · se reprograma${it.visit?.saved_at ? '' : ' · falta guardar'}</div>`
        : it.motivo ? `<div style="font-size:13px;color:${motivoColor(it.motivo)}">${esc(it.motivo)}</div>`
        : it.carried ? '<div style="font-size:13px;color:var(--orange-ink)">Quedó pendiente la vez anterior</div>' : '';
      const esSig = it === sig;
      return `<button class="stop${esSig ? ' next' : ''}" data-act="abrir" data-id="${it.item_id}">
        <div class="num ${it.status === 'si' ? 'si' : it.status === 'no' ? 'no' : ''}">${it.position}</div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
          ${esSig ? '<div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--green)">Siguiente</div>' : ''}
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${badge(c)}${it.urgencia ? '<span class="badge URG">URGENCIA</span>' : ''}<span style="font-size:16px;font-weight:600">${esc(c.nombre)}</span></div>
          <div style="font-size:14px;color:var(--muted)">${esc(c.direccion)} · ${esc(c.zona)}${c.horario ? ' · ' + esc(c.horario) : ''}</div>
          ${it.nota ? `<div style="font-size:13px;color:var(--ink2)">${esc(it.nota)}</div>` : ''}${tag}
        </div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8A918C" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>`;
    }).join('')}
  </main>
  <div class="foot"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <button class="big" data-act="agregar" style="background:#fff;border:1.5px solid var(--line);color:var(--ink);font-size:16px">+ Agregar visita</button>
    <button class="big" data-act="terminar" style="background:var(--ink);color:#fff;font-size:16px" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Registrando…' : 'Terminar jornada'}</button></div>
  <div style="font-size:12px;color:var(--muted);text-align:center">${left ? `Las ${left} sin visitar se reprograman al terminar` : 'Registra hora y ubicación de cierre'}</div></div>`;
}

// ---------- Mi semana ----------
function renderSemana() {
  const W = S.semana;
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const fmt = (ymd) => ymd.split('-').reverse().slice(0, 2).join('/');
  if (!W) { root.innerHTML = header('Mi semana') + tabs() + '<main><div class="empty">Cargando…</div></main>'; return; }
  root.innerHTML = header(`Mi semana: ${W.total} ${W.total === 1 ? 'visita' : 'visitas'}`, `<div style="font-size:14px;color:#D5DBD7">Del ${fmt(W.dias[0].fecha)} al ${fmt(W.dias[4].fecha)} · ${W.hechas} hechas</div>`) + tabs() + `<main>
    ${W.sinPublicar ? '<div class="sec"><div style="font-size:15px">El jefe comercial todavía no publicó la semana.</div></div>' : ''}
    ${W.dias.filter((d) => d.items.length || d.nombre !== 'Sábado').map((d) => {
      const hechas = d.items.filter((i) => i.estado === 'si').length, nos = d.items.filter((i) => i.estado === 'no' || i.estado === 'sin_visitar').length;
      const esHoy = d.fecha === hoy;
      return `<details class="sec day${esHoy ? ' today' : ''}" ${esHoy ? 'open' : ''}><summary>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-size:16px;font-weight:600">${d.nombre} ${fmt(d.fecha)}${esHoy ? ' · hoy' : ''}</span>
        <span class="pill ${d.items.length && hechas === d.items.length ? 'ok' : nos ? 'warn' : 'idle'}">${d.items.length ? `${hechas} de ${d.items.length}` : 'Sin visitas'}</span></div>
        ${d.barrios.length ? `<div style="font-size:13px;color:var(--muted)">${esc(d.barrios.join(' · '))}</div>` : ''}</summary>
        ${d.items.map((it) => `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line2)">
          <span class="dot ${it.estado}" aria-label="${it.estado === 'si' ? 'Visitado' : it.estado === 'no' ? 'No visitado' : it.estado === 'sin_visitar' ? 'Quedó sin visitar' : 'Pendiente'}"></span><div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${badge(it.client)}<span style="font-weight:600">${esc(it.client.nombre)}</span></div>
          <span style="font-size:13px;color:var(--muted)">${esc(it.client.zona)}${it.motivo ? ' · ' + esc(it.motivo) : ''}</span></div></div>`).join('')}
      </details>`;
    }).join('')}
  </main>`;
}

// ---------- Formulario de visita ----------
function curItem() { return S.items.find((i) => i.item_id === S.curId); }
function formDe(it) {
  if (!S.form[it.item_id]) {
    const v = it.visit;
    S.form[it.item_id] = { estandar: new Set(v?.estandar || []), motivo: v?.motivo_no || '', nota: v?.comment || '', volver: v?.volver_meses != null ? String(v.volver_meses) : '', convertido: !!v?.convertido };
  }
  return S.form[it.item_id];
}

function renderVisita() {
  const it = curItem();
  if (!it) { S.screen = S.plan ? 'lista' : 'inicio'; return render(); }
  const c = it.client, v = it.visit, F = formDe(it);
  const res = it.status === 'si' || it.status === 'no' ? it.status : null;
  const fotoSrc = S.fotoLocal[it.item_id] || v?.photo_url;
  const lista = S.listas[c.tipo === 'serrana' ? 'comentario_serrana' : c.tipo === 'prospecto' ? 'comentario_prospecto' : 'comentario_cliente'] || [];
  const puedeGuardar = (res === 'no' && F.motivo) || (res === 'si' && v?.has_photo);
  root.innerHTML = `<header class="vhead">
      <button class="back" data-act="volver" aria-label="Volver a la recorrida">${BACK}</button>
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${badge(c)}<span style="font-size:18px;font-weight:600">${esc(c.nombre)}</span></div>
        <div style="font-size:14px;color:var(--muted)">${esc(c.direccion)} · ${esc(c.zona)}${c.horario ? ' · ' + esc(c.horario) : ''}</div>
        ${c.contacto || c.telefono ? `<div style="font-size:13px;color:var(--ink2)">${esc(c.contacto)}${c.telefono ? ` · <a href="tel:${esc(c.telefono.replace(/\s/g, ''))}">${esc(c.telefono)}</a>` : ''}</div>` : ''}
      </div></header>
    <main>
      ${it.nota ? `<div class="sec" style="background:var(--orange-bg);border-color:var(--orange-bg)"><div><strong>${it.urgencia ? 'Urgencia' : 'Nota'}:</strong> ${esc(it.nota)}</div></div>` : ''}
      ${it.motivo ? `<div style="font-size:14px;color:${motivoColor(it.motivo)};padding:0 4px">${esc(it.motivo)}</div>` : ''}
      <section class="sec"><h2>¿Visitó?</h2>
        <div class="yn"><button class="s" data-act="res" data-r="si" aria-pressed="${res === 'si'}" ${S.busy ? 'disabled' : ''}>SÍ</button>
        <button class="n" data-act="res" data-r="no" aria-pressed="${res === 'no'}" ${S.busy ? 'disabled' : ''}>NO</button></div>
        ${S.busy === 'gps' ? '<div style="font-size:14px;color:var(--muted)">Registrando hora y ubicación…</div>' : ''}
        ${v ? `<div class="reg"><strong style="color:var(--green-ink)">Registrado automáticamente</strong>
          <span class="mono">${hora(v.arrived_at)}${v.lat != null ? ` · ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}` : ' · sin ubicación (revisá el permiso de ubicación)'}</span></div>` : ''}
      </section>
      ${res === 'no' ? `<section class="sec"><h2>¿Por qué no se hizo?</h2>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${(S.listas.motivo_no || []).map((t) => `<button class="chip" data-act="motivo" data-t="${esc(t)}" aria-pressed="${F.motivo === t}">${esc(t)}</button>`).join('')}</div>
        <div style="font-size:14px;color:var(--orange-ink)">La visita se reprograma para la próxima vez que se recorra ${esc(c.zona)}.</div></section>` : ''}
      ${res === 'si' ? `<section class="sec"><h2>${c.tipo === 'serrana' ? 'Foto de la góndola' : 'Foto del local'}</h2>
        ${fotoSrc ? `<img class="photo" src="${esc(fotoSrc)}" alt="Foto de ${esc(c.nombre)}"><div class="mono" style="font-size:13px;color:var(--muted)">Foto ${hora(v?.photo_at)}</div>` : ''}
        <label class="btn" style="height:52px;border:1.5px solid var(--green);color:var(--green);font-size:16px;position:relative">
          ${S.busy === 'foto' ? 'Subiendo foto…' : fotoSrc ? 'Repetir foto' : 'Sacar foto'}
          <input type="file" accept="image/*" capture="environment" data-act="foto" class="sr" ${S.busy ? 'disabled' : ''}>
        </label></section>
        <section class="sec"><h2>Comentarios</h2>
          <div style="display:flex;flex-wrap:wrap;gap:8px">${lista.map((t) => `<button class="chip" data-act="std" data-t="${esc(t)}" aria-pressed="${F.estandar.has(t)}">${esc(t)}</button>`).join('')}</div>
        </section>
        ${c.tipo === 'prospecto' ? `<section class="sec"><h2>¿Cuándo volver?</h2>
          <div style="display:flex;flex-wrap:wrap;gap:8px">${VOLVER.map(([k, l]) => `<button class="chip" data-act="volverEn" data-k="${k}" aria-pressed="${F.volver === k}">${l}</button>`).join('')}</div>
          <label style="display:flex;gap:10px;align-items:center;font-size:16px;font-weight:600;min-height:44px"><input type="checkbox" data-act="conv" ${F.convertido ? 'checked' : ''} style="width:22px;height:22px"> Pasó a cliente</label>
        </section>` : ''}` : ''}
      ${v ? `<section class="sec"><label for="nota" style="font-size:16px;font-weight:600">Comentario libre</label>
        <textarea id="nota" placeholder="Algo más que quieras dejar anotado">${esc(F.nota)}</textarea></section>` : ''}
    </main>
    <div class="foot"><button class="big" data-act="guardar" style="background:var(--ink);color:#fff" ${!puedeGuardar || S.busy ? 'disabled' : ''}>Guardar visita</button>
    ${res === 'si' && !v?.has_photo ? '<div style="font-size:12px;color:var(--muted);text-align:center">Falta la foto para guardar</div>' : ''}
    ${res === 'no' && !F.motivo ? '<div style="font-size:12px;color:var(--muted);text-align:center">Elegí el motivo para guardar</div>' : ''}</div>`;
  const ta = document.getElementById('nota');
  if (ta) ta.addEventListener('input', () => { F.nota = ta.value; });
}

// ---------- Agregar visita (urgencia o comercio nuevo) ----------
async function abrirAgregar() {
  S.ag = { q: '', sel: null, nuevo: false, urg: true, nota: '', datos: { tipo: 'Prospecto BEC', nombre: '', direccion: '', zona: '', telefono: '' } };
  S.screen = 'agregar'; render();
  try {
    const [cs, bs] = await Promise.all([S.comercios ? S.comercios : api('/api/clients'), S.barrios ? S.barrios : api('/api/barrios')]);
    S.comercios = cs; S.barrios = bs; if (S.screen === 'agregar') render();
  } catch (e) { toast(e.message); }
}

function renderAgregar() {
  const A = S.ag;
  const q = A.q.trim().toLowerCase();
  const res = S.comercios && q.length >= 2 ? S.comercios.filter((c) => `${c.nombre} ${c.direccion} ${c.zona}`.toLowerCase().includes(q)).slice(0, 8) : [];
  const sel = A.sel && S.comercios?.find((c) => c.id === A.sel);
  const D = A.datos;
  root.innerHTML = `<header class="vhead"><button class="back" data-act="cancelarAg" aria-label="Volver">${BACK}</button>
    <div style="font-size:18px;font-weight:600">Agregar visita</div></header><main>
    <section class="sec"><h2>Comercio</h2>
      <div class="vtabs" style="padding:0"><button data-act="agModo" data-m="0" aria-pressed="${!A.nuevo}">Ya cargado</button><button data-act="agModo" data-m="1" aria-pressed="${A.nuevo}">Comercio nuevo</button></div>
      ${!A.nuevo ? (sel ? `<div class="reg" style="background:var(--soft)"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${badge(sel)}<strong>${esc(sel.nombre)}</strong></div><span style="font-size:13px;color:var(--muted)">${esc(sel.direccion)} · ${esc(sel.zona)}</span><button class="btn sm" data-act="agQuitar" style="align-self:flex-start">Cambiar</button></div>`
        : `<label class="f">Buscar por nombre, dirección o barrio<input id="agq" value="${esc(A.q)}" autocomplete="off" placeholder="Ej.: Disco Solymar"></label>
        ${!S.comercios ? '<div class="muted">Cargando comercios…</div>' : res.map((c) => `<button class="stop" data-act="agSel" data-id="${c.id}" style="min-height:56px;padding:10px 12px"><div style="display:flex;flex-direction:column;gap:3px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${badge(c)}<strong>${esc(c.nombre)}</strong></div><span style="font-size:13px;color:var(--muted)">${esc(c.direccion)} · ${esc(c.zona)}</span></div></button>`).join('')}
        ${q.length >= 2 && S.comercios && !res.length ? '<div class="muted" style="font-size:14px">No aparece. Cargalo como comercio nuevo.</div>' : ''}`)
      : `<div id="agf" style="display:flex;flex-direction:column;gap:12px">
        <label class="f">Tipo<select data-d="tipo">${['Prospecto BEC', 'Cliente BEC', 'Serrana'].map((t) => `<option ${D.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="f">Nombre<input data-d="nombre" value="${esc(D.nombre)}"></label>
        <label class="f">Dirección<input data-d="direccion" value="${esc(D.direccion)}"></label>
        <label class="f">Barrio<input data-d="zona" list="dl-b" value="${esc(D.zona)}"></label><datalist id="dl-b">${(S.barrios || []).map((b) => `<option value="${esc(b.nombre)}">`).join('')}</datalist>
        <label class="f">Teléfono (opcional)<input data-d="telefono" inputmode="tel" value="${esc(D.telefono)}"></label></div>`}
    </section>
    <section class="sec"><label for="agn" style="font-size:16px;font-weight:600">¿Qué hay que hacer?</label>
      <textarea id="agn" placeholder="Ej.: pasar a mirar la leña">${esc(A.nota)}</textarea>
      <label style="display:flex;gap:10px;align-items:center;font-size:15px;min-height:44px"><input type="checkbox" id="agu" ${A.urg ? 'checked' : ''} style="width:22px;height:22px"> Es una urgencia (avisa al jefe comercial)</label></section>
  </main>
  <div class="foot"><button class="big" data-act="agOk" style="background:var(--green);color:#fff" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Agregando…' : 'Agregar a la ruta de hoy'}</button></div>`;
  const qi = document.getElementById('agq');
  if (qi) qi.addEventListener('input', () => { A.q = qi.value; const p = qi.selectionStart; render(); const n = document.getElementById('agq'); if (n) { n.focus(); n.setSelectionRange(p, p); } });
  root.querySelectorAll('[data-d]').forEach((i) => i.addEventListener('input', () => { D[i.dataset.d] = i.value; }));
  const ni = document.getElementById('agn'); if (ni) ni.addEventListener('input', () => { A.nota = ni.value; });
  const ui = document.getElementById('agu'); if (ui) ui.addEventListener('change', () => { A.urg = ui.checked; });
}

async function comprimir(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.82));
    return blob || file;
  } catch (_) { return file; }
}

root.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  if (act === 'conv' || act === 'foto') return;
  try {
    if (act === 'salir') {
      if (await confirmar('¿Cerrar sesión?', 'Vas a tener que ingresar de nuevo con tu usuario.', 'Salir')) { await api('/api/logout', { method: 'POST' }); location.href = '/ingresar?a=app'; }
    } else if (act === 'vista') {
      S.vista = el.dataset.v; render();
      if (S.vista === 'semana') { S.semana = await api('/api/semana'); render(); }
    } else if (act === 'iniciar') {
      S.busy = true; render();
      try {
        const pos = await ubicacion();
        aplicarPlan(await api('/api/plan/iniciar', { json: { ...(pos || {}) } }));
        S.screen = 'lista'; S.aviso = '';
        if (!pos) toast('No se pudo obtener tu ubicación. Activá el permiso de ubicación para el navegador.', 5000);
      } finally { S.busy = false; }
      render();
    } else if (act === 'abrirplan') { S.opts = null; S.screen = 'plan'; render(); await cargarOpciones(); render(); }
    else if (act === 'volverinicio') { S.screen = S.plan ? 'lista' : 'inicio'; render(); }
    else if (act === 'zona') { S.zona = el.dataset.z; ajustarN(); estimar(); render(); }
    else if (act === 'menos') { S.n = Math.max(1, S.n - 1); estimar(); render(); }
    else if (act === 'mas') { S.n = Math.min(maxN(), S.n + 1); estimar(); render(); }
    else if (act === 'armar') {
      S.busy = true; render();
      try {
        const pos = await ubicacion();
        aplicarPlan(await api('/api/plan', { json: { zona: S.zona, n: S.n, ...(pos || {}) } }));
        S.screen = 'lista'; S.vista = 'hoy';
        if (!pos) toast('No se pudo obtener tu ubicación. Activá el permiso de ubicación para el navegador.', 5000);
      } finally { S.busy = false; }
      render();
    } else if (act === 'abrir') { S.curId = Number(el.dataset.id); S.screen = 'visita'; render(); window.scrollTo(0, 0); }
    else if (act === 'volver') { S.screen = 'lista'; render(); }
    else if (act === 'res') {
      const it = curItem();
      const r = el.dataset.r;
      if (it.status === r) return;
      S.busy = 'gps'; render();
      try {
        const pos = it.visit ? null : await ubicacion();
        await api('/api/visits', { json: { item_id: it.item_id, result: r, ...(pos || {}) } });
        await recargarPlan();
        if (!it.visit && !pos) toast('No se pudo registrar la ubicación. Revisá el permiso de ubicación.', 5000);
      } finally { S.busy = false; }
      render();
    } else if (act === 'motivo') { formDe(curItem()).motivo = el.dataset.t; render(); }
    else if (act === 'std') { const F = formDe(curItem()); const t = el.dataset.t; if (F.estandar.has(t)) F.estandar.delete(t); else F.estandar.add(t); render(); }
    else if (act === 'volverEn') { const F = formDe(curItem()); F.volver = F.volver === el.dataset.k ? '' : el.dataset.k; render(); }
    else if (act === 'guardar') {
      const it = curItem(), F = formDe(it);
      S.busy = true; render();
      try {
        await api(`/api/visits/${it.visit.id}`, { method: 'PATCH', json: { comment: F.nota, estandar: [...F.estandar], motivo_no: F.motivo, volver_meses: F.volver, convertido: F.convertido } });
        delete S.form[it.item_id];
        await recargarPlan();
        S.screen = 'lista'; S.comercios = null;
        toast(`Visita guardada: ${it.client.nombre}`);
      } finally { S.busy = false; }
      render(); window.scrollTo(0, 0);
    } else if (act === 'agregar') { await abrirAgregar(); }
    else if (act === 'cancelarAg') { S.screen = S.plan ? 'lista' : 'inicio'; render(); }
    else if (act === 'agModo') { S.ag.nuevo = el.dataset.m === '1'; render(); }
    else if (act === 'agSel') { S.ag.sel = Number(el.dataset.id); render(); }
    else if (act === 'agQuitar') { S.ag.sel = null; render(); }
    else if (act === 'agOk') {
      const A = S.ag;
      const body = { nota: A.nota, urgencia: A.urg };
      if (A.nuevo) {
        if (!A.datos.nombre.trim() || !A.datos.zona.trim()) return toast('Completá el nombre y el barrio.');
        body.nuevo = A.datos;
      } else if (A.sel) body.client_id = A.sel;
      else return toast('Buscá y elegí el comercio, o cargá uno nuevo.');
      S.busy = true; render();
      try {
        const pos = S.plan ? null : await ubicacion();
        aplicarPlan(await api('/api/plan/agregar', { json: { ...body, ...(pos || {}) } }));
        S.screen = 'lista'; S.vista = 'hoy'; S.comercios = null;
        toast(A.urg ? 'Agregada a la ruta. Se avisó al jefe comercial.' : 'Agregada a la ruta de hoy.');
      } finally { S.busy = false; }
      render(); window.scrollTo(0, 0);
    } else if (act === 'terminar') {
      const left = S.items.filter((i) => i.status === 'pending').length;
      const ok = await confirmar('¿Terminar la jornada?', `Se registra la hora y tu ubicación actual.${left ? ` Las ${left} visitas sin hacer se reprograman para la próxima vez que se recorra el barrio.` : ''}`, 'Terminar jornada');
      if (!ok) return;
      S.busy = true; render();
      try {
        const pos = await ubicacion();
        const r = await api('/api/plan/end', { json: { ...(pos || {}) } });
        await recargarPlan();
        S.screen = 'inicio';
        S.aviso = `Jornada terminada a las ${hora(r.ended_at)}.${pos ? ' Ubicación de cierre registrada.' : ' No se pudo registrar la ubicación.'}${r.devueltas ? ` ${r.devueltas} ${r.devueltas === 1 ? 'visita se reprograma' : 'visitas se reprograman'}.` : ''}`;
      } finally { S.busy = false; }
      render(); window.scrollTo(0, 0);
    }
  } catch (err) {
    S.busy = false;
    toast(err.message, 5000);
    render();
  }
});

root.addEventListener('change', async (e) => {
  if (e.target.dataset.act === 'conv') { formDe(curItem()).convertido = e.target.checked; return; }
  if (e.target.dataset.act !== 'foto' || !e.target.files[0]) return;
  const it = curItem();
  const file = e.target.files[0];
  S.busy = 'foto'; render();
  try {
    const [blob, pos] = await Promise.all([comprimir(file), ubicacion()]);
    const fd = new FormData();
    fd.append('foto', blob, 'foto.jpg');
    if (pos) { fd.append('lat', pos.lat); fd.append('lng', pos.lng); fd.append('acc', pos.acc); }
    await api(`/api/visits/${it.visit.id}/photo`, { method: 'POST', body: fd });
    S.fotoLocal[it.item_id] = URL.createObjectURL(blob);
    await recargarPlan();
    if (!pos) toast('La foto se guardó sin ubicación. Revisá el permiso de ubicación.', 5000);
  } catch (err) { toast(err.message, 5000); }
  S.busy = false;
  render();
});

cargar().catch((err) => { root.innerHTML = `<main><div class="err">${esc(err.message)}</div><button class="btn" onclick="location.reload()">Reintentar</button></main>`; });
