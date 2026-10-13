'use strict';
(function () {
  const list = document.getElementById('auditList');
  const refresh = document.getElementById('auditRefresh');
  if (!list || !refresh) return;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c]));
  async function loadAudit() {
    refresh.disabled = true;
    try {
      const r = await fetch('/api/actions/audit'); const data = await r.json();
      if (!data.ok) throw new Error();
      if (!data.entries.length) { list.innerHTML = '<div class="empty-state">Aún no hay acciones registradas.</div>'; return; }
      list.innerHTML = `<div class="overflow-x-auto"><table class="data-table"><thead><tr><th>Hora</th><th>Operación</th><th>Resultado</th><th>Detalle</th></tr></thead><tbody>${data.entries.map((e) => `<tr><td>${new Date(e.at).toLocaleString('es-CO',{dateStyle:'short',timeStyle:'short'})}</td><td>${esc(e.action)}</td><td style="color:${e.ok ? 'var(--status-good)' : 'var(--status-critical)'}">${e.ok ? 'Correcta' : 'Falló'}</td><td class="muted">${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>`;
    } catch { list.innerHTML = '<div class="error-state">No se pudo cargar la bitácora.</div>'; } finally { refresh.disabled = false; }
  }
  refresh.addEventListener('click', loadAudit); loadAudit();
})();
