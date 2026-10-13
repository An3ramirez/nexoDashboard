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
  function askForPersistenceKey() {
    return new Promise((resolve) => {
      const modal = document.createElement('div'); modal.className = 'fixed inset-0 modal-backdrop flex items-center justify-center z-50 p-4';
      modal.innerHTML = '<div class="modal-card rounded-2xl p-6 w-full max-w-sm"><h2 class="font-bold" style="font-size:16px">Hacer persistente</h2><p class="muted mt-2" style="font-size:13px;line-height:1.55">Ingresa una clave activa de persistencia. El archivo dejará de caducar automáticamente.</p><label class="label block mt-4 mb-1.5" for="persistenceKeyInput">Clave</label><input id="persistenceKeyInput" class="field" type="password" autocomplete="off"><p class="muted mt-2" id="persistenceKeyError" role="status"></p><div class="flex gap-2 mt-4"><button class="btn-ghost rounded-xl px-4 py-2.5 flex-1" data-answer="no" type="button">Cancelar</button><button class="btn-primary rounded-xl px-4 py-2.5 flex-1" data-answer="yes" type="button">Confirmar</button></div></div>';
      modal.addEventListener('click', (event) => {
        const answer = event.target.closest('[data-answer]')?.dataset.answer;
        if (!answer) return;
        if (answer === 'no') { modal.remove(); resolve(null); return; }
        const value = modal.querySelector('#persistenceKeyInput').value.trim();
        if (!value) { modal.querySelector('#persistenceKeyError').textContent = 'Ingresa la clave para continuar.'; return; }
        modal.remove(); resolve(value);
      });
      document.body.appendChild(modal);
      modal.querySelector('#persistenceKeyInput').focus();
    });
  }
  function renderKeys(keys) {
    const container = $('fileKeysList');
    if (!container) return;
    if (!keys.length) { container.innerHTML = '<div class="empty-state">Todavía no hay claves de persistencia.</div>'; return; }
    container.innerHTML = `<div class="overflow-x-auto"><table class="data-table"><thead><tr><th>Clave</th><th>Creada</th><th>Estado</th><th></th></tr></thead><tbody>${keys.map((key) => `<tr><td style="color:var(--ink)">${esc(key.label)}</td><td>${date(key.createdAt)}</td><td>${key.revokedAt ? '<span class="pill warn">Revocada</span>' : '<span class="pill online">Activa</span>'}</td><td>${key.revokedAt ? '' : `<button class="mini-btn danger" data-revoke-key="${esc(key.id)}" title="Revocar clave" aria-label="Revocar ${esc(key.label)}">Revocar</button>`}</td></tr>`).join('')}</tbody></table></div>`;
  }
  async function load() {
    const r = await fetch('/api/public-files/admin'); const data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.error || 'No se pudo cargar el inventario.');
    try { state.publicFiles = data.files; window.NexoInsights?.render(state); } catch {}
    $('fileAdminCount').textContent = data.files.length;
    $('fileAdminSize').textContent = bytes(data.files.reduce((sum, f) => sum + (f.size || 0), 0));
    $('fileDefaultTtl').value = String(data.defaultTtlMinutes || 60);
    $('fileCleanupPill').textContent = data.cleanupEnabled ? '● Borrado activo' : '○ Borrado detenido'; $('fileCleanupPill').className = `pill ${data.cleanupEnabled ? 'online' : 'warn'}`;
    const keyLabel = (id) => data.keys.find((key) => key.id === id)?.label;
    list.innerHTML = data.files.length ? `<div class="overflow-x-auto"><table class="data-table"><thead><tr><th>Archivo</th><th>Estado</th><th>Subido por</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>${data.files.map((f) => { const expired = !f.persistent && Number(f.expiresAt) > 0 && Number(f.expiresAt) <= Date.now(); const status = f.persistent ? `<span class="pill online">Persistente${keyLabel(f.persistenceKeyId) ? ` · ${esc(keyLabel(f.persistenceKeyId))}` : ''}</span>` : expired ? '<span class="pill warn">Vencido · borrado pendiente</span>' : `<span class="pill">Caduca: ${date(f.expiresAt)}</span>`; return `<tr><td><a class="link-accent" href="/files/${encodeURIComponent(f.id)}">${esc(f.name)}</a><div class="faint" style="font-size:10.5px;margin-top:3px">${bytes(f.size)}</div></td><td>${status}</td><td>${esc(f.uploader?.ip || 'Sin registro')}<div class="faint" style="font-size:10.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(f.uploader?.userAgent || 'Sin navegador')}</div></td><td>${date(f.createdAt)}</td><td><div class="flex gap-1">${f.persistent ? `<button class="mini-btn" data-set-persistent="false" data-file-id="${esc(f.id)}" title="Volver a activar vencimiento">Temporal</button>` : `<button class="mini-btn" data-set-persistent="true" data-file-id="${esc(f.id)}" title="Proteger de borrado automático">Persistir</button>`}<button class="mini-btn danger" data-delete-file="${esc(f.id)}" title="Eliminar archivo" aria-label="Eliminar ${esc(f.name)}">×</button></div></td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty-state">No hay archivos en el inventario.</div>';
    renderKeys(data.keys || []);
  }
  $('fileAdminRefresh').addEventListener('click', () => load().catch((e) => { list.textContent = e.message; }));
  $('fileTtlForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const r = await fetch('/api/public-files/settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ defaultTtlMinutes:Number($('fileDefaultTtl').value) }) }); if (r.ok) load();
  });
  $('fileKeyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('fileKeyForm').querySelector('[type="submit"]'); if (button) button.disabled = true;
    try {
      const r = await fetch('/api/public-files/keys', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ label:$('fileKeyLabel').value }) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'No se pudo generar la clave.');
      const key = data.key.value;
      $('fileKeyResult').innerHTML = `<div class="rounded-xl p-3" style="background:var(--overlay);border:1px solid var(--border)"><strong>Guarda esta clave ahora; no volverá a mostrarse.</strong><div class="share-link mt-2"><input id="newPersistenceKey" readonly value="${esc(key)}" aria-label="Nueva clave de persistencia"><button id="copyPersistenceKey" class="btn-ghost icon-btn" type="button">Copiar</button></div></div>`;
      $('fileKeyLabel').value = '';
      await load();
    } catch (error) { $('fileKeyResult').textContent = error.message; }
    finally { if (button) button.disabled = false; }
  });
  document.addEventListener('click', async (event) => {
    const persist = event.target.closest('[data-set-persistent]');
    if (persist) {
      const makePersistent = persist.dataset.setPersistent === 'true';
      const key = makePersistent ? await askForPersistenceKey() : null;
      if (makePersistent && !key) return;
      if (!makePersistent && !await ask('Reactivar vencimiento', 'El archivo volverá a ser temporal y vencerá según la duración predeterminada actual.')) return;
      const r = await fetch(`/api/public-files/${encodeURIComponent(persist.dataset.fileId)}/persistence`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ persistent:makePersistent, key }) });
      const data = await r.json();
      if (!r.ok) { $('fileKeyResult').textContent = data.error || 'No se pudo cambiar la persistencia.'; return; }
      await load(); return;
    }
    if (event.target.closest('#copyPersistenceKey')) {
      await navigator.clipboard.writeText($('newPersistenceKey').value);
      event.target.closest('#copyPersistenceKey').textContent = 'Copiada'; return;
    }
    const revoke = event.target.closest('[data-revoke-key]');
    if (revoke && await ask('Revocar clave', 'No podrá persistir más archivos. Los archivos que ya protegió seguirán persistentes hasta que se reactiven sus vencimientos.')) {
      const r = await fetch(`/api/public-files/keys/${encodeURIComponent(revoke.dataset.revokeKey)}`, { method:'DELETE' });
      if (!r.ok) { $('fileKeyResult').textContent = 'No se pudo revocar la clave.'; return; }
      await load(); return;
    }
    const del = event.target.closest('[data-delete-file]');
    if (del && await ask('Eliminar archivo', 'El archivo se eliminará de forma permanente y su enlace dejará de funcionar.')) { await fetch(`/api/public-files/${encodeURIComponent(del.dataset.deleteFile)}`, {method:'DELETE'}); load(); }
  });
  load().catch((e) => { list.textContent = e.message; });
})();
