'use strict';
const $ = (id) => document.getElementById(id);
let fileState = { cleanupEnabled: true, maxBytes: 50 * 1024 * 1024 * 1024, files: [] };
function fmtBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}
function setProgress(percent, label) {
  const value = Math.min(100, Math.max(0, Math.round(percent)));
  $('uploadProgressWrap').classList.remove('hidden');
  $('uploadProgressBar').style.width = `${value}%`;
  $('uploadProgressValue').textContent = `${value}%`;
  $('uploadProgressLabel').textContent = label;
  $('uploadProgressBar').parentElement.setAttribute('aria-valuenow', String(value));
}
function uploadChunk(file, uploadId, index, totalChunks, offset, chunk, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/public-files/chunk');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', file.name);
    xhr.setRequestHeader('X-Upload-Id', uploadId);
    xhr.setRequestHeader('X-Chunk-Index', String(index));
    xhr.setRequestHeader('X-Chunk-Total', String(totalChunks));
    xhr.setRequestHeader('X-File-Size', String(file.size));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(offset + event.loaded, file.size);
    };
    xhr.onerror = () => reject(new Error('La conexión se interrumpió durante la subida.'));
    xhr.onabort = () => reject(new Error('La subida fue cancelada.'));
    xhr.onload = () => {
      const type = xhr.getResponseHeader('content-type') || '';
      let data;
      try { data = type.includes('application/json') ? JSON.parse(xhr.responseText) : null; } catch {}
      if (!data) return reject(new Error(`La carga fue rechazada por un servidor intermedio (HTTP ${xhr.status || 'sin respuesta'}).`));
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || `No se pudo subir el archivo (HTTP ${xhr.status}).`));
      resolve(data);
    };
    xhr.send(chunk);
  });
}
async function uploadFile(file) {
  const chunkSize = 32 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / chunkSize);
  const uploadId = crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '') : Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  let offset = 0;
  let result;
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
    result = await uploadChunk(file, uploadId, index, totalChunks, offset, chunk, (loaded, total) => setProgress((loaded / total) * 100, `Subiendo ${fmtBytes(loaded)} de ${fmtBytes(total)}…`));
    offset += chunk.size;
  }
  return result;
}
function until(ts) { const m = Math.max(0, Math.ceil((ts - Date.now()) / 60000)); return m < 60 ? `${m} min` : `${Math.ceil(m / 60)} h`; }
function expiry(ts) { if (!ts) return 'Sin caducidad'; if (!fileState.cleanupEnabled && ts <= Date.now()) return 'Vencido · borrado automático detenido'; return `Expira en ${until(ts)} · ${new Date(ts).toLocaleString('es-CO', { dateStyle:'short', timeStyle:'short' })}`; }
function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function render() {
  $('maxSize').textContent = `Máx. ${fmtBytes(fileState.maxBytes)}`;
  $('cleanupState').textContent = fileState.cleanupEnabled ? '● Borrado activo' : '○ Borrado detenido';
  $('cleanupState').className = `pill ${fileState.cleanupEnabled ? 'online' : 'warn'}`;
  const list = $('publicFilesList');
  if (!fileState.files.length) { list.innerHTML = '<div class="empty-state">No hay archivos temporales.</div>'; return; }
  list.innerHTML = fileState.files.map((f) => { const link = `${location.origin}/files/${encodeURIComponent(f.id)}`; return `<div class="file-row"><div class="min-w-0"><strong>${esc(f.name)}</strong><span>${fmtBytes(f.size)} · ${expiry(f.expiresAt)}</span><div class="share-link"><input readonly value="${esc(link)}" aria-label="Enlace para compartir ${esc(f.name)}"><button class="mini-btn" type="button" data-copy-link="${esc(link)}" title="Copiar enlace">⧉</button></div></div><a class="btn-ghost icon-btn" href="/files/${encodeURIComponent(f.id)}">Descargar</a></div>`; }).join('');
}
async function load() { const r = await fetch('/api/public-files'); fileState = await r.json(); render(); }
$('uploadInput').addEventListener('change', (e) => { $('fileName').textContent = e.target.files[0]?.name || 'Elige un archivo'; });
$('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const file = $('uploadInput').files[0]; if (!file) return;
  if (file.size > fileState.maxBytes) { $('uploadResult').textContent = 'El archivo excede el tamaño permitido.'; return; }
  const button = e.submitter; button.disabled = true; $('uploadResult').textContent = 'Subiendo…'; setProgress(0, `Preparando ${fmtBytes(file.size)}…`);
  try { const data = await uploadFile(file); setProgress(100, 'Archivo guardado.'); const link = `${location.origin}${data.downloadUrl}`; $('uploadResult').innerHTML = `<strong>Archivo listo.</strong> ${expiry(data.file.expiresAt)}<div class="share-link"><input id="newShareLink" readonly value="${esc(link)}" aria-label="Enlace del archivo subido"><button class="btn-ghost icon-btn" type="button" id="copyNewShareLink">Copiar enlace</button></div>`; $('copyNewShareLink').addEventListener('click', async () => { await navigator.clipboard.writeText(link); $('copyNewShareLink').textContent = 'Copiado'; }); $('uploadForm').reset(); $('fileName').textContent = 'Elige un archivo'; await load(); } catch (err) { $('uploadResult').textContent = err.message || 'No se pudo subir el archivo.'; } finally { button.disabled = false; }
});
function closeModal() { $('cleanupModal').classList.add('hidden'); $('cleanupModal').classList.remove('flex'); }
$('cleanupToggle').addEventListener('click', () => { $('cleanupPassword').value = ''; $('cleanupResult').textContent = ''; $('cleanupCopy').textContent = fileState.cleanupEnabled ? 'Vas a detener el borrado automático. El tiempo de expiración seguirá contando; los archivos vencidos se borrarán al reactivarlo.' : 'Vas a reactivar el borrado automático y eliminar los archivos que ya hayan vencido.'; $('cleanupModal').classList.remove('hidden'); $('cleanupModal').classList.add('flex'); $('cleanupPassword').focus(); });
$('cleanupCancel').addEventListener('click', closeModal);
$('cleanupConfirm').addEventListener('click', async () => { const r = await fetch('/api/public-files/cleanup', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ password:$('cleanupPassword').value, enabled:!fileState.cleanupEnabled }) }); const data = await r.json(); if (!r.ok) { $('cleanupResult').textContent = data.error || 'No se pudo actualizar.'; return; } closeModal(); await load(); });
$('fileTheme').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = next; localStorage.setItem('nexo-theme', next); });
document.addEventListener('click', async (event) => { const button = event.target.closest('[data-copy-link]'); if (!button) return; await navigator.clipboard.writeText(button.dataset.copyLink); const original = button.textContent; button.textContent = '✓'; setTimeout(() => { button.textContent = original; }, 1200); });
document.documentElement.dataset.theme = localStorage.getItem('nexo-theme') || 'dark';
load().catch(() => { $('publicFilesList').innerHTML = '<div class="error-state">No se pudieron cargar los archivos.</div>'; });
