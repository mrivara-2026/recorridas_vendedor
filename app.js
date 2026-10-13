// App del vendedor (celular)
const S = { me: null, plan: null, items: [], rutas: [], opts: null, zona: null, n: 5, screen: 'cargando', curId: null, notas: {}, aviso: '', busy: false, est: null, fotoLocal: {} };
const root = document.getElementById('root');
const CHIPS = ['Cliente interesado', 'Hizo pedido', 'No estaba el encargado', 'Volver otro día'];

async function cargar() {
  S.me = await api('/api/me');
  const cur = await api('/api/plan/current');
  if (cur.plan) { aplicarPlan(cur); S.screen = S.screen === 'visita' ? 'visita' : 'lista'; }
  else { S.plan = null; S.items = []; await cargarOpciones(); S.screen = 'plan'; }
  render();
}

function aplicarPlan(d) { S.plan = d.plan; S.items = d.items; S.rutas = d.rutas; }

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

function render() {
  if (S.screen === 'plan') return renderPlan();
  if (S.screen === 'lista') return renderLista();
  if (S.screen === 'visita') return renderVisita();
}

function renderPlan() {
  const zonas = S.opts?.zonas || [];
  const m = maxN();
  root.innerHTML = header('¿A qué zona vas hoy?') + `<main>
    ${S.aviso ? `<div class="err" role="status">${esc(S.aviso)}</div>` : ''}
    ${zonas.length ? '' : '<div class="empty">Todavía no hay sucursales cargadas. Pedile al administrador que las cargue desde el panel web.</div>'}
    ${zonas.map((z) => {
      const full = z.disponibles === 0;
      const pv = Math.round(z.visitadas / z.total * 100), pp = Math.round(z.postergadas / z.total * 100);
      return `<button class="zone" data-act="zona" data-z="${esc(z.zona)}" aria-pressed="${S.zona === z.zona}" ${full ? 'disabled' : ''}>
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;width:100%"><span style="font-size:17px;font-weight:600">${esc(z.zona)}</span>
        <span class="mono" style="font-size:13px;color:var(--muted)">${z.visitadas}/${z.total} este mes</span></div>
        <div class="zbar" style="width:100%"><div style="width:${pv}%;background:var(--green)"></div><div style="width:${pp}%;background:var(--orange-mid)"></div></div>
        <div style="font-size:14px;color:var(--ink2)">${full ? 'Zona completa este mes' : `${z.disponibles} por visitar${z.postergadas ? ` · ${z.postergadas} ${z.postergadas === 1 ? 'quedó pendiente' : 'quedaron pendientes'}` : ''}`}</div>
        ${!full && z.urgentes ? `<div style="font-size:13px;color:var(--orange-ink);font-weight:600">${z.urgentes} ${z.urgentes === 1 ? 'supermercado' : 'supermercados'} sin ventas hace tiempo</div>` : ''}
      </button>`;
    }).join('')}
    ${m ? `<div class="sec" style="flex-direction:row;align-items:center;justify-content:space-between;margin-top:6px">
      <div><div style="font-size:16px;font-weight:600">Cantidad de visitas</div><div style="font-size:13px;color:var(--muted)">Hasta ${m} disponibles en ${esc(S.zona)}</div></div>
      <div class="stepper"><button data-act="menos" aria-label="Una visita menos">−</button>
      <div class="mono" style="width:40px;text-align:center;font-size:24px" aria-live="polite" id="n">${S.n}</div>
      <button data-act="mas" aria-label="Una visita más">+</button></div></div>
      <div style="font-size:14px;color:var(--ink2);padding:2px 4px">Tiempo estimado: <strong class="mono" style="font-weight:500">${S.est != null ? minTexto(S.est) : '…'}</strong> con traslados</div>` : ''}
  </main>
  <div class="foot"><button class="big" data-act="armar" style="background:var(--green);color:#fff" ${!m || S.busy ? 'disabled' : ''}>${S.busy ? 'Buscando tu ubicación…' : 'Armar recorrida'}</button></div>`;
}

function renderLista() {
  const done = S.items.filter((i) => i.status !== 'pending').length;
  const left = S.items.length - done;
  const pct = S.items.length ? Math.round(done / S.items.length * 100) : 0;
  const rutas = S.rutas.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${S.rutas.map((r) => `<a class="btn sm" style="background:#F3F2EE;border:none" href="${esc(r.url)}" target="_blank" rel="noopener">Ruta en Maps${S.rutas.length > 1 ? ` (${r.desde}–${r.hasta})` : ''}</a>`).join('')}</div>` : '';
  root.innerHTML = header(S.plan.zona, `<div class="bar"><div style="width:${pct}%"></div></div>
      <div class="row"><div style="font-size:14px;color:#D5DBD7">${done}/${S.items.length} paradas · orden sugerido</div></div>${rutas}`) + `<main>
    ${S.items.map((it) => {
      const c = it.client;
      const tag = it.status === 'si' ? `<div style="font-size:13px;color:var(--green-ink)">Visita SÍ · ${hora(it.visit?.arrived_at)}${it.visit?.saved_at ? '' : ' · falta guardar'}</div>`
        : it.status === 'no' ? `<div style="font-size:13px;color:var(--orange-ink)">Visita NO · vuelve a sugerirse${it.visit?.saved_at ? '' : ' · falta guardar'}</div>`
        : it.carried ? '<div style="font-size:13px;color:var(--orange-ink)">Quedó pendiente la vez anterior</div>' : '';
      const urg = it.status === 'pending' && it.urgencia?.nivel ? `<div style="font-size:13px;color:var(--orange-ink);font-weight:600">${esc(it.urgencia.texto)} · prioridad</div>` : '';
      return `<button class="stop" data-act="abrir" data-id="${it.item_id}">
        <div class="num ${it.status === 'si' ? 'si' : it.status === 'no' ? 'no' : ''}">${it.position}</div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;align-items:center;gap:8px"><span class="badge ${c.empresa}">${c.empresa}</span><span style="font-size:16px;font-weight:600">${esc(c.nombre)}</span></div>
          <div style="font-size:14px;color:var(--muted)">${esc(c.direccion)}${c.horario ? ' · ' + esc(c.horario) : ''}</div>${tag}${urg}
        </div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8A918C" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>`;
    }).join('')}
  </main>
  <div class="foot"><button class="big" data-act="terminar" style="background:#fff;border:1.5px solid var(--ink);color:var(--ink)" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Registrando ubicación…' : 'Terminar jornada'}</button>
  <div style="font-size:12px;color:var(--muted);text-align:center">Registra hora y ubicación de cierre${left ? ` · las ${left} sin visitar vuelven a sugerirse` : ''}</div></div>`;
}

function curItem() { return S.items.find((i) => i.item_id === S.curId); }

function renderVisita() {
  const it = curItem();
  if (!it) { S.screen = 'lista'; return render(); }
  const c = it.client, v = it.visit;
  const res = it.status === 'si' || it.status === 'no' ? it.status : null;
  const nota = S.notas[it.item_id] ?? v?.comment ?? '';
  const fotoSrc = S.fotoLocal[it.item_id] || v?.photo_url;
  const puedeGuardar = res === 'no' || (res === 'si' && v?.has_photo);
  root.innerHTML = `<header class="vhead">
      <button class="back" data-act="volver" aria-label="Volver a la recorrida"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
      <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
        <div style="display:flex;align-items:center;gap:8px"><span class="badge ${c.empresa}">${c.empresa}</span><span style="font-size:18px;font-weight:600">${esc(c.nombre)}</span></div>
        <div style="font-size:14px;color:var(--muted)">${esc(c.direccion)}${c.horario ? ' · ' + esc(c.horario) : ''}</div>
      </div></header>
    <main>
      <section class="sec"><h2>¿Se realizó la visita?</h2>
        <div class="yn"><button class="s" data-act="res" data-r="si" aria-pressed="${res === 'si'}" ${S.busy ? 'disabled' : ''}>SÍ</button>
        <button class="n" data-act="res" data-r="no" aria-pressed="${res === 'no'}" ${S.busy ? 'disabled' : ''}>NO</button></div>
        ${S.busy === 'gps' ? '<div style="font-size:14px;color:var(--muted)">Registrando hora y ubicación…</div>' : ''}
        ${res === 'no' ? '<div style="font-size:14px;color:var(--orange-ink)">Esta sucursal vuelve a las sugerencias de la zona.</div>' : ''}
        ${v ? `<div class="reg"><strong style="color:var(--green-ink)">Registrado automáticamente</strong>
          <span class="mono">${hora(v.arrived_at)}${v.lat != null ? ` · ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}` : ' · sin ubicación (revisá el permiso de ubicación)'}</span></div>` : ''}
      </section>
      ${res === 'si' ? `<section class="sec"><h2>${c.empresa === 'MAN' ? 'Foto de la góndola' : 'Foto del local'}</h2>
        ${fotoSrc ? `<img class="photo" src="${esc(fotoSrc)}" alt="Foto de ${esc(c.nombre)}"><div class="mono" style="font-size:13px;color:var(--muted)">Foto ${hora(v?.photo_at)}</div>` : ''}
        <label class="btn" style="height:52px;border:1.5px solid var(--green);color:var(--green);font-size:16px;position:relative">
          ${S.busy === 'foto' ? 'Subiendo foto…' : fotoSrc ? 'Repetir foto' : 'Sacar foto'}
          <input type="file" accept="image/*" capture="environment" data-act="foto" class="sr" ${S.busy ? 'disabled' : ''}>
        </label></section>` : ''}
      ${v ? `<section class="sec"><label for="nota" style="font-size:16px;font-weight:600">Comentarios</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${CHIPS.map((t) => `<button class="chip" data-act="chip" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <textarea id="nota" placeholder="Ej.: cliente interesado en la nueva línea">${esc(nota)}</textarea></section>` : ''}
    </main>
    <div class="foot"><button class="big" data-act="guardar" style="background:var(--ink);color:#fff" ${!puedeGuardar || S.busy ? 'disabled' : ''}>Guardar visita</button>
    ${res === 'si' && !v?.has_photo ? '<div style="font-size:12px;color:var(--muted);text-align:center">Falta la foto para guardar</div>' : ''}</div>`;
  const ta = document.getElementById('nota');
  if (ta) ta.addEventListener('input', () => { S.notas[it.item_id] = ta.value; });
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

async function recargarPlan() {
  const cur = await api('/api/plan/current');
  if (cur.plan) aplicarPlan(cur);
}

root.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  try {
    if (act === 'salir') {
      if (await confirmar('¿Cerrar sesión?', 'Vas a tener que ingresar de nuevo con tu usuario.', 'Salir')) { await api('/api/logout', { method: 'POST' }); location.href = '/ingresar?a=app'; }
    } else if (act === 'zona') { S.zona = el.dataset.z; S.aviso = ''; ajustarN(); estimar(); render(); }
    else if (act === 'menos') { S.n = Math.max(1, S.n - 1); estimar(); render(); }
    else if (act === 'mas') { S.n = Math.min(maxN(), S.n + 1); estimar(); render(); }
    else if (act === 'armar') {
      S.busy = true; render();
      const pos = await ubicacion();
      try {
        const d = await api('/api/plan', { json: { zona: S.zona, n: S.n, ...(pos || {}) } });
        aplicarPlan(d); S.screen = 'lista'; S.aviso = '';
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
    } else if (act === 'chip') {
      const it = curItem();
      const ta = document.getElementById('nota');
      const cur = (ta?.value || '').trim();
      S.notas[it.item_id] = cur ? `${cur}. ${el.dataset.t}` : el.dataset.t;
      render();
    } else if (act === 'guardar') {
      const it = curItem();
      const ta = document.getElementById('nota');
      S.busy = true; render();
      try {
        await api(`/api/visits/${it.visit.id}`, { method: 'PATCH', json: { comment: ta ? ta.value : (S.notas[it.item_id] || '') } });
        delete S.notas[it.item_id];
        await recargarPlan();
        S.screen = 'lista';
        toast(`Visita guardada: ${it.client.nombre}`);
      } finally { S.busy = false; }
      render(); window.scrollTo(0, 0);
    } else if (act === 'terminar') {
      const left = S.items.filter((i) => i.status === 'pending').length;
      const ok = await confirmar('¿Terminar la jornada?', `Se registra la hora y tu ubicación actual.${left ? ` Las ${left} paradas sin visitar vuelven a sugerirse la próxima vez que vayas a ${S.plan.zona}.` : ''}`, 'Terminar jornada');
      if (!ok) return;
      S.busy = true; render();
      try {
        const pos = await ubicacion();
        const r = await api('/api/plan/end', { json: { ...(pos || {}) } });
        S.plan = null; S.items = [];
        await cargarOpciones();
        S.screen = 'plan';
        S.aviso = `Jornada terminada a las ${hora(r.ended_at)}.${pos ? ' Ubicación de cierre registrada.' : ' No se pudo registrar la ubicación.'}${r.devueltas ? ` ${r.devueltas} ${r.devueltas === 1 ? 'sucursal vuelve' : 'sucursales vuelven'} a las sugerencias de ${r.zona}.` : ''}`;
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
