/* Administración autenticada de los archivos publicados. */
'use strict';
(function () {
  const list = document.getElementById('fileAdminList');
  if (!list) return;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const bytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
  const date = (t) => t ? new Date(t).toLocaleString('es-CO', { dateStyle:'short', timeStyle:'short' }) : 'sin caducidad';
  function ask(title, message) {
    return new Promise((resolve) => {
      const modal = document.createElement('div'); modal.className = 'fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4';
      modal.innerHTML = `<div class="modal-card rounded-2xl p-6 w-full max-w-sm"><h2 class="font-bold" style="font-size:16px">${esc(title)}</h2><p class="muted mt-2" style="font-size:13px;line-height:1.55">${esc(message)}</p><div class="flex gap-2 mt-5"><button class="btn-ghost rounded-xl px-4 py-2.5 flex-1" data-answer="no">Cancelar</button><button class="btn-primary rounded-xl px-4 py-2.5 flex-1" data-answer="yes">Confirmar</button></div></div>`;
      modal.addEventListener('click', (event) => { const answer = event.target.closest('[data-answer]')?.dataset.answer; if (!answer) return; modal.remove(); resolve(answer === 'yes'); }); document.body.appendChild(modal);
    });
  }
  async function load() {
    const r = await fetch('/api/public-files/admin'); const data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.error || 'No se pudo cargar el inventario.');
    try { state.publicFiles = data.files; window.NexoInsights?.render(state); } catch {}
    $('fileAdminCount').textContent = data.files.length;
    $('fileAdminSize').textContent = bytes(data.files.reduce((sum, f) => sum + (f.size || 0), 0));
    $('fileDefaultTtl').value = String(data.defaultTtlMinutes || 60);
    $('fileCleanupPill').textContent = data.cleanupEnabled ? '● Borrado activo' : '○ Borrado detenido'; $('fileCleanupPill').className = `pill ${data.cleanupEnabled ? 'online' : 'warn'}`;
    list.innerHTML = data.files.length ? `<div class="overflow-x-auto"><table class="data-table"><thead><tr><th>Archivo</th><th>Estado</th><th>Subido por</th><th>Fecha</th><th></th></tr></thead><tbody>${data.files.map((f) => `<tr><td><a class="link-accent" href="/files/${encodeURIComponent(f.id)}">${esc(f.name)}</a><div class="faint" style="font-size:10.5px;margin-top:3px">${bytes(f.size)}</div></td><td>${f.persistent ? '<span class="pill online">Persistente</span>' : `<span class="pill">Caduca: ${date(f.expiresAt)}</span>`}</td><td>${esc(f.uploader?.ip || 'Sin registro')}<div class="faint" style="font-size:10.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(f.uploader?.userAgent || 'Sin navegador')}</div></td><td>${date(f.createdAt)}</td><td><button class="mini-btn danger" data-delete-file="${esc(f.id)}" title="Eliminar archivo" aria-label="Eliminar ${esc(f.name)}">×</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No hay archivos en el inventario.</div>';
  }
  $('fileAdminRefresh').addEventListener('click', () => load().catch((e) => { list.textContent = e.message; }));
  $('fileTtlForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const r = await fetch('/api/public-files/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ defaultTtlMinutes:Number($('fileDefaultTtl').value) }) }); if (r.ok) load();
  });
  document.addEventListener('click', async (event) => {
    const del = event.target.closest('[data-delete-file]');
    if (del && await ask('Eliminar archivo', 'El archivo se eliminará de forma permanente y su enlace dejará de funcionar.')) { await fetch(`/api/public-files/${encodeURIComponent(del.dataset.deleteFile)}`, {method:'DELETE'}); load(); }
  });
  load().catch((e) => { list.textContent = e.message; });
})();
