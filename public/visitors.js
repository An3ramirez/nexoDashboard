/* Vista de visitantes aislada: una sesión por dispositivo/navegador, no solo IP. */
'use strict';
window.NexoVisitors = {
  render(state) {
    const vis = state.visitors || { active: [], total: 0 };
    const active = vis.active || [];
    const set = (key, value) => { const el = document.querySelector(`[data-value="${key}"]`); if (el) el.textContent = value; };
    set('visActive', active.length); set('visTotal', vis.total || 0); set('visRequests', active.reduce((n, v) => n + (v.requests || 0), 0));
    const badge = document.getElementById('visitorsBadge'); const nav = document.getElementById('navVisitorsCount');
    if (nav) nav.textContent = active.length;
    if (badge) { badge.textContent = active.length ? `● ${active.length} dispositivos activos` : '● Sin actividad'; badge.className = `pill ${active.length ? 'online' : ''}`; }
    const box = document.getElementById('visitorsContainer'); if (!box) return;
    if (!active.length) { box.innerHTML = '<div class="empty-state">Sin dispositivos activos en el último minuto.</div>'; return; }
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    box.innerHTML = `<div class="overflow-x-auto"><table class="data-table"><thead><tr><th>Red</th><th>Dispositivo / navegador</th><th>URL en tiempo real</th><th>Reqs</th><th>Última señal</th></tr></thead><tbody>${active.slice(0, 30).map((v) => `<tr><td><span class="domain-tag">${esc(v.ip)}</span><div class="faint" style="font-size:10.5px;margin-top:3px">${esc(v.host || v.domain)}</div></td><td>${esc(v.device)}<div class="faint" style="font-size:10.5px;margin-top:3px">${esc(v.browser || 'Navegador desconocido')}</div></td><td class="muted" style="max-width:360px;word-break:break-all">${esc(v.lastUri || '/')}</td><td>${esc(v.requests)}</td><td style="color:var(--status-good)">● ahora</td></tr>`).join('')}</tbody></table></div>`;
  },
};
