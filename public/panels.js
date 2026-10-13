/* NexoDashboard v2 — paneles extendidos (extras.js):
 * Docker, servicios systemd, SMART, procesos con kill, logs journal,
 * uptime checks y quick links CRUD. Cargado DESPUÉS de dashboard.js.
 */
'use strict';

window.NexoPanels = (() => {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = () => window.__nexoState || null;

  function svcBadge(s) {
    if (!s) return '<span class="pill">--</span>';
    if (s.state === 'active') return '<span class="pill online" style="font-size:10px">activo</span>';
    if (s.state === 'not-found') return '<span class="pill" style="font-size:10px">no instalado</span>';
    if (s.state === 'inactive' || s.state === 'failed') return `<span class="pill offline" style="font-size:10px">${esc(s.state)}</span>`;
    return `<span class="pill warn" style="font-size:10px">${esc(s.state || 'desconocido')}</span>`;
  }

  function renderDocker(docker) {
    const pill = document.getElementById('dockerPill');
    const box = document.getElementById('dockerList');
    if (!box) return;
    if (!docker || docker.available === false) {
      if (pill) { pill.textContent = 'no disponible'; pill.className = 'pill'; pill.style.fontSize = '10px'; }
      box.innerHTML = `<div class="empty-state">${esc((docker && docker.reason) || 'Docker no disponible en este equipo')}</div>`;
      return;
    }
    const n = docker.count || 0;
    if (pill) { pill.textContent = `● ${n} contenedor${n === 1 ? '' : 'es'}`; pill.className = 'pill ' + (n ? 'online' : ''); pill.style.fontSize = '10px'; }
    if (!n) { box.innerHTML = '<div class="empty-state">Sin contenedores en ejecución</div>'; return; }
    box.innerHTML = (docker.containers || []).slice(0, 8).map((c) => `
      <div class="flex items-center gap-2.5" style="font-size:12px">
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${c.state === 'running' ? 'var(--status-good)' : 'var(--status-warning)'}"></span>
        <div class="min-w-0 flex-1">
          <div class="font-bold truncate" style="color:var(--ink)">${esc(c.name)}</div>
          <div class="faint truncate" style="font-size:10.5px">${esc(c.image)}${c.status ? ' · ' + esc(c.status) : ''}</div>
        </div>
      </div>`).join('');
  }

  function renderServices(services) {
    const box = document.getElementById('servicesList');
    if (!box) return;
    if (!services || !services.length) { box.innerHTML = '<div class="empty-state">Sin datos de servicios</div>'; return; }
    const up = services.filter((s) => s.state === 'active').length;
    const gwBadge = document.getElementById('navGwCount');
    if (gwBadge) {
      const bad = services.some((s) => s.state === 'failed' || (s.key === 'openclaw' && s.state !== 'active'));
      gwBadge.style.display = bad ? '' : 'none';
    }
    box.innerHTML = services.map((s) => {
      const up2 = s.uptimeSec != null ? (s.uptimeSec >= 3600 ? Math.floor(s.uptimeSec / 3600) + 'h' : Math.floor(s.uptimeSec / 60) + 'm') : '';
      return `<div class="flex items-center gap-2.5" style="font-size:12px">
        <div class="min-w-0 flex-1">
          <div class="font-bold" style="color:var(--ink)">${esc(s.key)}</div>
          <div class="faint truncate" style="font-size:10.5px">${esc(s.unit)}${up2 ? ' · up ' + up2 : ''}${s.memMB != null ? ' · ' + s.memMB + ' MB' : ''}</div>
        </div>
        ${svcBadge(s)}
      </div>`;
    }).join('') + `<div class="faint" style="font-size:11px">${up}/${services.length} activos</div>`;
  }

  function renderSmart(smart) {
    const box = document.getElementById('smartList');
    const mini = document.getElementById('smartMini');
    const pill = document.getElementById('smartPill');
    const devs = (smart && smart.available && smart.devices) || [];
    if (!smart || smart.available === false) {
      const reason = (smart && smart.reason) || 'SMART no disponible';
      if (box) box.innerHTML = `<div class="empty-state">${esc(reason)}</div>`;
      if (mini) mini.textContent = reason;
      if (pill) { pill.textContent = 'SMART --'; pill.className = 'pill'; pill.style.fontSize = '10px'; }
      return;
    }
    const bad = devs.filter((d) => d.health === 'failed').length;
    if (pill) {
      pill.textContent = bad ? `● ${bad} con fallos` : '● Salud OK';
      pill.className = 'pill ' + (bad ? 'offline' : 'online');
      pill.style.fontSize = '10px';
    }
    if (box) {
      box.innerHTML = devs.length ? devs.slice(0, 6).map((d) => `
        <div class="flex items-center gap-2.5" style="font-size:12px">
          <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${d.health === 'passed' ? 'var(--status-good)' : d.health === 'failed' ? 'var(--status-critical)' : 'var(--status-warning)'}"></span>
          <div class="min-w-0 flex-1">
            <div class="font-bold truncate" style="color:var(--ink)">${esc(d.device)}</div>
            <div class="faint truncate" style="font-size:10.5px">${esc(d.model || d.health)}${d.temp != null ? ' · ' + d.temp + '°C' : ''}</div>
          </div>
        </div>`).join('') : '<div class="empty-state">Sin discos detectados</div>';
    }
    if (mini) {
      mini.textContent = devs.length
        ? devs.map((d) => `${d.device}: ${d.health}${d.temp != null ? ` (${d.temp}°C)` : ''}`).join(' · ')
        : 'Sin discos detectados';
    }
  }

  /* ── Procesos con kill ── */
  let procTimer = 0;
  async function loadProcesses() {
    const box = document.getElementById('procsTable');
    const pill = document.getElementById('procsPill');
    const input = document.getElementById('procSearch');
    const query = (input ? input.value : '').trim();
    try {
      const r = await fetch(`/api/processes?sort=cpu&limit=12${query ? '&q=' + encodeURIComponent(query) : ''}`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'error');
      if (pill) { pill.textContent = `${d.total} procesos`; pill.className = 'pill'; pill.style.fontSize = '10px'; }
      if (!d.processes.length) { box.innerHTML = '<div class="empty-state">Sin coincidencias</div>'; return; }
      let html = '<div class="overflow-x-auto"><table class="data-table"><thead><tr><th>Proceso</th><th>CPU</th><th>RAM</th><th></th></tr></thead><tbody>';
      d.processes.forEach((p) => {
        html += `<tr>
          <td style="color:var(--ink)"><div class="font-bold truncate" style="max-width:170px">${esc(p.name)}</div><div class="faint" style="font-size:10px">PID ${esc(p.pid)} · ${esc(p.memRssMB)} MB</div></td>
          <td>${esc(p.cpu)}%</td>
          <td>${esc(p.memPct)}%</td>
          <td style="text-align:right">${p.protected
            ? '<span class="faint" style="font-size:10px" title="Protegido por el sistema">bloq.</span>'
            : `<button class="mini-btn danger" data-kill="${esc(p.pid)}" data-name="${esc(p.name)}" title="Terminar ${esc(p.name)} (${esc(p.pid)})" aria-label="Terminar proceso ${esc(p.pid)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`}</td>
        </tr>`;
      });
      box.innerHTML = html + '</tbody></table></div>';
      box.querySelectorAll('[data-kill]').forEach((b) => {
        b.addEventListener('click', () => {
          if (window.NexoKill) window.NexoKill.open(Number(b.dataset.kill), b.dataset.name);
        });
      });
    } catch {
      box.innerHTML = '<div class="error-state">No se pudo cargar la lista de procesos</div>';
    }
  }

  async function kill(pid) {
    try {
      const r = await fetch('/api/processes/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, confirm: true }),
      });
      const d = await r.json();
      if (d.ok) {
        toast(`Proceso ${pid} terminado (SIGTERM)`, 'ok');
        loadProcesses();
      } else {
        toast(d.error || 'No se pudo terminar el proceso', 'err');
      }
    } catch {
      toast('Error de conexión', 'err');
    }
  }

  /* ── Logs journal ── */
  async function loadLogs() {
    const box = document.getElementById('logBox');
    const unit = document.getElementById('logUnit').value;
    box.textContent = 'Cargando logs de ' + unit + '…';
    try {
      const r = await fetch(`/api/logs?unit=${encodeURIComponent(unit)}&n=120`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'error');
      if (!d.lines || !d.lines.length) {
        box.textContent = d.note || 'Sin registros accesibles para ' + unit;
        return;
      }
      box.textContent = d.lines.slice(-120).join('\n');
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      box.textContent = 'Error: ' + (e.message || 'no se pudo cargar');
    }
  }

  /* ── Checks ── */
  function renderChecks(checks) {
    const box = document.getElementById('checksList');
    const pill = document.getElementById('checksPill');
    if (!box) return;
    const list = checks || [];
    const bad = list.filter((c) => !c.ok).length;
    if (pill) {
      pill.textContent = list.length ? (bad ? `● ${bad} caído${bad === 1 ? '' : 's'}` : `● ${list.length} OK`) : '--';
      pill.className = 'pill ' + (!list.length ? '' : bad ? 'offline' : 'online');
    }
    if (!list.length) { box.innerHTML = '<div class="empty-state">Sin checks configurados</div>'; return; }
    box.innerHTML = list.map((c) => `
      <div class="flex items-center gap-2.5" style="font-size:12px">
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${c.ok ? 'var(--status-good)' : 'var(--status-critical)'}"></span>
        <div class="min-w-0 flex-1">
          <div class="font-bold truncate" style="color:var(--ink)">${esc(c.url.replace(/^https?:\/\//, ''))}</div>
          <div class="faint" style="font-size:10.5px">${c.status != null ? 'HTTP ' + c.status + ' · ' : ''}${c.ms != null ? c.ms + ' ms' : esc(c.error || '')}</div>
        </div>
        <button class="mini-btn danger" data-delcheck="${esc(c.id)}" title="Eliminar check" aria-label="Eliminar check ${esc(c.url)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>`).join('');
    box.querySelectorAll('[data-delcheck]').forEach((b) => {
      b.addEventListener('click', async () => {
        const r = await fetch('/api/checks/' + encodeURIComponent(b.dataset.delcheck), { method: 'DELETE' });
        const d = await r.json();
        toast(d.ok ? 'Check eliminado' : (d.error || 'No se pudo eliminar'), d.ok ? 'ok' : 'err');
        refreshChecks();
      });
    });
  }
  async function refreshChecks() {
    try {
      const r = await fetch('/api/checks');
      const d = await r.json();
      if (d.ok) renderChecks(d.checks);
    } catch { /* reintento en el siguiente ciclo del socket */ }
  }

  /* ── Links CRUD ── */
  function renderLinks(links) {
    const box = document.getElementById('linksList');
    if (!box) return;
    const list = links || [];
    if (!list.length) { box.innerHTML = '<div class="empty-state">Sin enlaces todavía — añade el primero abajo</div>'; return; }
    box.innerHTML = list.map((l) => `
      <div class="link-card">
        <span class="icon-chip tint-accent" style="width:30px;height:30px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>
        <div class="min-w-0 flex-1">
          <a href="${esc(l.url)}" target="_blank" rel="noopener" class="font-bold link-accent truncate block" style="font-size:13px;text-decoration:none">${esc(l.label)}</a>
          <div class="faint truncate" style="font-size:10.5px">${esc(l.url.replace(/^https?:\/\//, '').slice(0, 48))}</div>
        </div>
        <div class="lk-actions">
          <button class="mini-btn" data-editlink="${esc(l.id)}" data-label="${esc(l.label)}" data-url="${esc(l.url)}" title="Editar" aria-label="Editar enlace ${esc(l.label)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>
          <button class="mini-btn danger" data-dellink="${esc(l.id)}" title="Eliminar" aria-label="Eliminar enlace ${esc(l.label)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-dellink]').forEach((b) => {
      b.addEventListener('click', async () => {
        const r = await fetch('/api/links/' + encodeURIComponent(b.dataset.dellink), { method: 'DELETE' });
        const d = await r.json();
        toast(d.ok ? 'Enlace eliminado' : (d.error || 'No se pudo eliminar'), d.ok ? 'ok' : 'err');
        if (d.ok) refreshLinks();
      });
    });
    box.querySelectorAll('[data-editlink]').forEach((b) => {
      b.addEventListener('click', async () => {
        const label = prompt('Nombre del enlace:', b.dataset.label);
        if (label == null) return;
        const url = prompt('URL:', b.dataset.url);
        if (url == null) return;
        const r = await fetch('/api/links/' + encodeURIComponent(b.dataset.editlink), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, url }),
        });
        const d = await r.json();
        toast(d.ok ? 'Enlace actualizado' : (d.error || 'No se pudo actualizar'), d.ok ? 'ok' : 'err');
        if (d.ok) refreshLinks();
      });
    });
  }
  async function refreshLinks() {
    try {
      const r = await fetch('/api/links');
      const d = await r.json();
      if (d.ok) renderLinks(d.links);
    } catch { /* el socket lo reintentará */ }
  }

  function wireForms() {
    const cf = document.getElementById('checkForm');
    if (cf && !cf.dataset.wired) {
      cf.dataset.wired = '1';
      cf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('checkUrl');
        const url = input.value.trim();
        if (!url) return;
        const r = await fetch('/api/checks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        });
        const d = await r.json();
        toast(d.ok ? 'Check añadido' : (d.error || 'No se pudo añadir'), d.ok ? 'ok' : 'err');
        if (d.ok) { input.value = ''; refreshChecks(); }
      });
    }
    const lf = document.getElementById('linkForm');
    if (lf && !lf.dataset.wired) {
      lf.dataset.wired = '1';
      lf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const label = document.getElementById('linkLabel').value.trim();
        const url = document.getElementById('linkUrl').value.trim();
        if (!label || !url) return;
        const r = await fetch('/api/links', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, url }),
        });
        const d = await r.json();
        toast(d.ok ? 'Enlace añadido' : (d.error || 'No se pudo añadir'), d.ok ? 'ok' : 'err');
        if (d.ok) { document.getElementById('linkLabel').value = ''; document.getElementById('linkUrl').value = ''; refreshLinks(); }
      });
    }
    const ps = document.getElementById('procSearch');
    if (ps && !ps.dataset.wired) {
      ps.dataset.wired = '1';
      ps.addEventListener('input', () => { clearTimeout(procTimer); procTimer = setTimeout(loadProcesses, 350); });
    }
    const lr = document.getElementById('logRefresh');
    if (lr && !lr.dataset.wired) {
      lr.dataset.wired = '1';
      lr.addEventListener('click', loadLogs);
      document.getElementById('logUnit').addEventListener('change', loadLogs);
    }
  }

  function render(state) {
    wireForms();
    if (state.docker !== undefined) renderDocker(state.docker);
    if (state.services) renderServices(state.services);
    if (state.smart !== undefined) renderSmart(state.smart);
    if (state.checks) renderChecks(state.checks);
    if (state.links) renderLinks(state.links);
  }

  loadProcesses();
  setInterval(loadProcesses, 15000);

  return { render, kill, loadProcesses, loadLogs, refreshChecks, refreshLinks };
})();
