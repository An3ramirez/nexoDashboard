const express = require('express');
const http = require('http');
const net = require('net');
const path = require('path');
const { Server } = require('socket.io');
const { createProxyMiddleware } = require('http-proxy-middleware');
const si = require('systeminformation');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
// Módulo de funcionalidades extendidas (I/O, docker, servicios, SMART,
// historial persistente, alertas, procesos, logs, checks, quick links).
// Solo AGREGA claves al payload 'stats' y rutas nuevas; no toca lo existente.
const extras = require('./extras');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// Cabeceras de seguridad base. No se pone CSP aquí porque el frontend carga
// Tailwind desde su CDN (script inline + eval de la JIT); ver nota en
// index.html. Estas cuatro son seguras para las rutas propias y para el
// proxy de /oc-panel.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // CSP solo para las páginas propias: /oc-panel es el proxy a la Control UI de
  // OpenClaw, que trae su propio bundle y necesita su política. Los scripts
  // inline se movieron a /dashboard.js y /login.js, y Tailwind se compila a
  // /tailwind.css, así que script-src puede ser 'self' sin unsafe-*.
  if (!req.path.startsWith('/oc-panel')) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      // Los atributos style="..." y el <style> del propio autor siguen siendo
      // inline; no hay inyección de estilos desde datos de usuario.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '));
  }
  next();
});
const server = http.createServer(app);
const io = new Server(server);

// La clave vive en un archivo aparte (no en el código) para que se pueda
// cambiar desde el propio dashboard sin editar índex.js ni reiniciar nada.
const AUTH_STORE_PATH = path.join(__dirname, 'auth.json');

// Falla cerrado: sin un auth.json utilizable el dashboard NO arranca. Antes
// caía a una clave fija escrita aquí, así que si el archivo se perdía el panel
// quedaba accesible con una clave conocida. Se acepta el formato nuevo
// {salt, hash} y, para migrar, el viejo {password} en claro (se convierte y se
// reescribe el archivo).
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
}
function loadAuth() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(AUTH_STORE_PATH, 'utf8'));
  } catch {
    console.error(`[auth] Falta o es inválido ${AUTH_STORE_PATH}; configura una clave antes de arrancar.`);
    process.exit(1);
  }
  if (raw && typeof raw.salt === 'string' && typeof raw.hash === 'string') return raw;
  if (raw && typeof raw.password === 'string' && raw.password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const store = { salt, hash: hashPassword(raw.password, salt) };
    fs.writeFileSync(AUTH_STORE_PATH, JSON.stringify(store), { mode: 0o600 });
    return store;
  }
  console.error(`[auth] ${AUTH_STORE_PATH} no contiene una clave utilizable.`);
  process.exit(1);
}
let authStore = loadAuth();
function verifyPassword(password) {
  if (typeof password !== 'string') return false;
  const candidate = Buffer.from(hashPassword(password, authStore.salt), 'hex');
  const expected = Buffer.from(authStore.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ===== Intercambio público de archivos =====
// Los ficheros no viven bajo /public: se sirven únicamente mediante un id
// aleatorio y se eliminan al caducar. Así no se pueden adivinar rutas ni usar
// nombres suministrados por el navegador para escapar del directorio.
// En producción se fija PUBLIC_FILES_DIR fuera del checkout para que las
// cargas no se mezclen con el código ni se pierdan al actualizarlo. Localmente
// se conserva una carpeta de desarrollo dentro del proyecto.
const PUBLIC_FILES_DIR = path.resolve(process.env.PUBLIC_FILES_DIR || path.join(__dirname, 'data', 'public-files'));
const PUBLIC_FILES_META = path.join(PUBLIC_FILES_DIR, 'index.json');
// Las cargas grandes se escriben en streaming (nunca se concentran en RAM).
// El límite es 50 GiB binarios; la UI lo comunica como 50 GB.
const PUBLIC_FILE_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const PUBLIC_FILE_CHUNK_MAX_BYTES = 40 * 1024 * 1024;
const PUBLIC_FILE_TTL_MIN = 24 * 60;
let publicFiles = [];
const activePublicUploads = new Map();
let publicFileCleanupEnabled = true;
let publicPersistenceKeys = [];
let publicFileDefaultTtlMinutes = 60;

function loadPublicFiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(PUBLIC_FILES_META, 'utf8'));
    publicFiles = Array.isArray(raw.files) ? raw.files : [];
    publicFileCleanupEnabled = raw.cleanupEnabled !== false;
    publicPersistenceKeys = Array.isArray(raw.persistenceKeys) ? raw.persistenceKeys : [];
    publicFileDefaultTtlMinutes = Math.min(PUBLIC_FILE_TTL_MIN, Math.max(5, Number(raw.defaultTtlMinutes) || 60));
  } catch { publicFiles = []; }
}
function savePublicFiles() {
  fs.mkdirSync(PUBLIC_FILES_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${PUBLIC_FILES_META}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ cleanupEnabled: publicFileCleanupEnabled, defaultTtlMinutes: publicFileDefaultTtlMinutes, persistenceKeys: publicPersistenceKeys, files: publicFiles }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PUBLIC_FILES_META);
}
function isPublicFileExpired(file, now = Date.now()) {
  return !file.persistent && Number(file.expiresAt) > 0 && Number(file.expiresAt) <= now;
}
function cleanPublicFiles() {
  if (!publicFileCleanupEnabled) return;
  const now = Date.now();
  const expired = publicFiles.filter((file) => isPublicFileExpired(file, now));
  if (!expired.length) return;
  const original = publicFiles;
  const removedIds = new Set();
  for (const file of expired) {
    if (!/^[a-f0-9]{36}$/.test(String(file.id || ''))) {
      console.error('[public-files] cleanup skipped an invalid file id');
      continue;
    }
    try {
      fs.unlinkSync(path.join(PUBLIC_FILES_DIR, `${file.id}.bin`));
      removedIds.add(file.id);
    } catch (error) {
      if (error.code === 'ENOENT') removedIds.add(file.id);
      else console.error(`[public-files] cleanup could not delete ${file.name || file.id}: ${error.code || error.message}`);
    }
  }
  if (!removedIds.size) return;
  publicFiles = original.filter((file) => !removedIds.has(file.id));
  try {
    savePublicFiles();
  } catch (error) {
    publicFiles = original;
    console.error(`[public-files] cleanup could not save metadata: ${error.code || error.message}`);
  }
}
function safeUploadName(value) {
  const name = path.basename(String(value || 'archivo')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
  return name || 'archivo';
}
function hashPersistenceKey(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function findPersistenceKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const candidate = Buffer.from(hashPersistenceKey(value), 'hex');
  return publicPersistenceKeys.find((key) => {
    if (key.revokedAt || !/^[a-f0-9]{64}$/i.test(String(key.hash || ''))) return false;
    return crypto.timingSafeEqual(Buffer.from(key.hash, 'hex'), candidate);
  }) || null;
}
function getUploadOrigin(req) {
  const forwarded = String(req.get('cf-connecting-ip') || req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  return forwarded.slice(0, 80) || 'desconocido';
}
loadPublicFiles();
cleanPublicFiles();
setInterval(cleanPublicFiles, 60 * 1000).unref();

app.get('/files', (req, res) => res.sendFile('files.html', { root: path.join(__dirname, 'public') }));
app.get('/files.js', (req, res) => res.sendFile('files.js', { root: path.join(__dirname, 'public') }));
app.get('/api/public-files', (req, res) => {
  cleanPublicFiles();
  const availableFiles = publicFiles.filter((file) => !publicFileCleanupEnabled || !isPublicFileExpired(file));
  res.json({ ok: true, cleanupEnabled: publicFileCleanupEnabled, defaultTtlMinutes: publicFileDefaultTtlMinutes, maxBytes: PUBLIC_FILE_MAX_BYTES, files: availableFiles.map(({ id, name, size, createdAt, expiresAt, persistent }) => ({ id, name, size, createdAt, expiresAt, persistent })) });
});
app.post('/api/public-files', (req, res) => {
  cleanPublicFiles();
  const declaredSize = Number(req.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > PUBLIC_FILE_MAX_BYTES) {
    req.resume();
    return res.status(413).json({ ok: false, error: 'El archivo supera el límite de 50 GB.' });
  }
  const ttlMinutes = publicFileDefaultTtlMinutes;
  const id = crypto.randomBytes(18).toString('hex');
  const tempPath = path.join(PUBLIC_FILES_DIR, `${id}.upload`);
  const finalPath = path.join(PUBLIC_FILES_DIR, `${id}.bin`);
  let received = 0;
  let done = false;
  const finishWithError = (status, error) => {
    if (done) return;
    done = true;
    try { fs.unlinkSync(tempPath); } catch {}
    if (!res.headersSent) res.status(status).json({ ok: false, error });
  };
  try {
    fs.mkdirSync(PUBLIC_FILES_DIR, { recursive: true, mode: 0o700 });
  } catch { return res.status(500).json({ ok: false, error: 'No se pudo preparar el almacenamiento.' }); }
  const output = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > PUBLIC_FILE_MAX_BYTES && !done) {
      req.unpipe(output); output.destroy(); req.resume();
      finishWithError(413, 'El archivo supera el límite de 50 GB.');
    }
  });
  req.once('aborted', () => finishWithError(400, 'La subida fue cancelada.'));
  req.once('error', () => finishWithError(400, 'La subida falló.'));
  output.once('error', () => finishWithError(500, 'No se pudo guardar el archivo.'));
  output.once('finish', () => {
    if (done) return;
    if (!received) return finishWithError(400, 'Selecciona un archivo no vacío.');
    const item = {
      id, name: safeUploadName(req.get('X-File-Name')), size: received, createdAt: Date.now(),
      expiresAt: Date.now() + ttlMinutes * 60 * 1000,
      persistent: false, persistenceKeyId: null,
      uploader: { ip: getUploadOrigin(req), userAgent: String(req.get('user-agent') || 'desconocido').slice(0, 220) },
    };
    try {
      fs.renameSync(tempPath, finalPath);
      publicFiles.push(item); savePublicFiles();
      done = true;
      res.status(201).json({ ok: true, file: item, downloadUrl: `/files/${id}` });
    } catch { finishWithError(500, 'No se pudo finalizar el archivo.'); }
  });
  req.pipe(output);
});
// Las redes intermedias suelen limitar una petición individual (aunque el
// servidor admita 50 GB). Esta ruta recibe fragmentos pequeños y los concatena
// directamente en el archivo temporal del disco.
app.post('/api/public-files/chunk', (req, res) => {
  cleanPublicFiles();
  const uploadId = String(req.get('X-Upload-Id') || '');
  const index = Number(req.get('X-Chunk-Index'));
  const totalChunks = Number(req.get('X-Chunk-Total'));
  const declaredSize = Number(req.get('X-File-Size'));
  if (!/^[a-f0-9]{24,64}$/.test(uploadId) || !Number.isInteger(index) || !Number.isInteger(totalChunks) || index < 0 || index >= totalChunks || !Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > PUBLIC_FILE_MAX_BYTES) {
    req.resume();
    return res.status(400).json({ ok: false, error: 'Datos de fragmento inválidos.' });
  }
  const existing = activePublicUploads.get(uploadId);
  if (index === 0 && existing) return res.status(409).json({ ok: false, error: 'La carga ya está en curso.' });
  if (index > 0 && (!existing || existing.nextIndex !== index || existing.totalChunks !== totalChunks || existing.totalSize !== declaredSize)) {
    req.resume();
    return res.status(409).json({ ok: false, error: 'Fragmento fuera de orden; reinicia la carga.' });
  }
  const state = existing || (() => {
    const id = crypto.randomBytes(18).toString('hex');
    const created = { id, nextIndex: 0, totalChunks, totalSize: declaredSize, received: 0, ttlMinutes: publicFileDefaultTtlMinutes, tempPath: path.join(PUBLIC_FILES_DIR, `${id}.upload`), finalPath: path.join(PUBLIC_FILES_DIR, `${id}.bin`), name: safeUploadName(req.get('X-File-Name')), uploader: { ip: getUploadOrigin(req), userAgent: String(req.get('user-agent') || 'desconocido').slice(0, 220) } };
    try { fs.mkdirSync(PUBLIC_FILES_DIR, { recursive: true, mode: 0o700 }); } catch { return null; }
    activePublicUploads.set(uploadId, created);
    return created;
  })();
  if (!state) { req.resume(); return res.status(500).json({ ok: false, error: 'No se pudo preparar el almacenamiento.' }); }
  let chunkBytes = 0;
  let finished = false;
  const output = fs.createWriteStream(state.tempPath, { flags: index === 0 ? 'wx' : 'a', mode: 0o600 });
  const fail = (status, error) => {
    if (finished) return;
    finished = true;
    activePublicUploads.delete(uploadId);
    try { fs.unlinkSync(state.tempPath); } catch {}
    if (!res.headersSent) res.status(status).json({ ok: false, error });
  };
  req.on('data', (part) => {
    chunkBytes += part.length;
    if (chunkBytes > PUBLIC_FILE_CHUNK_MAX_BYTES && !finished) {
      req.unpipe(output); output.destroy(); req.resume(); fail(413, 'El fragmento supera el límite permitido.');
    }
  });
  req.once('aborted', () => fail(400, 'La subida fue cancelada.'));
  req.once('error', () => fail(400, 'La subida falló.'));
  output.once('error', () => fail(500, 'No se pudo guardar el fragmento.'));
  output.once('finish', () => {
    if (finished) return;
    state.received += chunkBytes;
    state.nextIndex += 1;
    if (state.nextIndex < state.totalChunks) {
      finished = true;
      return res.json({ ok: true, done: false, received: state.received });
    }
    if (state.received !== state.totalSize) return fail(400, 'El tamaño recibido no coincide con el archivo.');
    const createdAt = Date.now();
    const item = { id: state.id, name: state.name, size: state.received, createdAt, expiresAt: createdAt + state.ttlMinutes * 60 * 1000, persistent: false, persistenceKeyId: null, uploader: state.uploader };
    try {
      fs.renameSync(state.tempPath, state.finalPath);
      publicFiles.push(item); savePublicFiles(); activePublicUploads.delete(uploadId); finished = true;
      res.status(201).json({ ok: true, done: true, file: item, downloadUrl: `/files/${state.id}` });
    } catch { fail(500, 'No se pudo finalizar el archivo.'); }
  });
  req.pipe(output);
});
app.get('/files/:id', (req, res, next) => {
  if (req.params.id === 'js') return next();
  cleanPublicFiles();
  const item = publicFiles.find((f) => f.id === req.params.id);
  if (!item) return res.status(404).send('Archivo no encontrado o caducado.');
  if (publicFileCleanupEnabled && isPublicFileExpired(item)) return res.status(410).send('El archivo caducó y está pendiente de eliminación.');
  res.setHeader('Cache-Control', 'private, no-store');
  res.download(path.join(PUBLIC_FILES_DIR, `${item.id}.bin`), item.name);
});
app.post('/api/public-files/cleanup', express.json(), (req, res) => {
  if (!verifyPassword(req.body?.password)) return res.status(403).json({ ok: false, error: 'Clave incorrecta.' });
  publicFileCleanupEnabled = req.body?.enabled !== false;
  try { savePublicFiles(); } catch { return res.status(500).json({ ok: false, error: 'No se pudo guardar el ajuste.' }); }
  res.json({ ok: true, cleanupEnabled: publicFileCleanupEnabled });
});
const ocTokens = new Map();
const OC_PANEL_TARGET = 'http://127.0.0.1:18789';
const OC_CONFIG_PATH = '/home/andres/.openclaw/openclaw.json';
const GATEWAY_UNIT = 'openclaw-gateway.service';
const XDG_ENV = { ...process.env, XDG_RUNTIME_DIR: '/run/user/1000' };

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ocTokens) if (now - v > 3600000) ocTokens.delete(k);
}, 300000);

// ===== Sesión del dashboard (protege todo el sitio, misma clave que /oc-panel) =====
const dashSessions = new Map();
const DASH_SESSION_TTL = 24 * 3600 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dashSessions) if (now - v > DASH_SESSION_TTL) dashSessions.delete(k);
}, 3600000);

function parseCookie(cookieHeader, name) {
  const cookies = cookieHeader || '';
  const match = cookies.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function getCookie(req, name) {
  return parseCookie(req.headers.cookie, name);
}

// sendFile sin `root` revisa cada segmento de la ruta absoluta en busca de
// "dotfiles" — como este proyecto vive bajo ~/.openclaw/, esa carpeta con
// punto lo hacía responder 404 siempre. Con `root`, solo se valida la ruta
// relativa a esa raíz.
app.get('/login', (req, res) => res.sendFile('login.html', { root: path.join(__dirname, 'public') }));
app.get('/app-icon.png', (req, res) => res.sendFile('app-icon.png', { root: path.join(__dirname, 'public') }));
app.get('/theme.css', (req, res) => res.sendFile('theme.css', { root: path.join(__dirname, 'public') }));
// Tailwind compilado y los scripts extraídos: son estáticos, sin datos, y los
// necesita el navegador ANTES de tener sesión (la página de login usa CSS y JS).
// Sin estas rutas quedaban detrás de requireDashAuth y el navegador recibía un
// 302 al propio /login: ni los estilos ni el JS cargaban.
app.get('/tailwind.css', (req, res) => res.sendFile('tailwind.css', { root: path.join(__dirname, 'public') }));
app.get('/fonts.css', (req, res) => res.sendFile('fonts.css', { root: path.join(__dirname, 'public') }));
app.get('/dashboard.js', (req, res) => res.sendFile('dashboard.js', { root: path.join(__dirname, 'public') }));
app.get('/panels.js', (req, res) => res.sendFile('panels.js', { root: path.join(__dirname, 'public') }));
app.get('/login.js', (req, res) => res.sendFile('login.js', { root: path.join(__dirname, 'public') }));
// Fuentes Inter self-hosted (subset latino .woff2): las pide el CSS antes de la sesión.
app.get('/fonts/:file', (req, res) => {
  if (!/^inter-[45678]00\.woff2$/.test(req.params.file)) return res.status(404).end();
  res.sendFile(req.params.file, { root: path.join(__dirname, 'public', 'fonts') });
});
app.get('/favicon.svg', (req, res) => res.sendFile('favicon.svg', { root: path.join(__dirname, 'public') }));

// ===== Salud del propio dashboard =====
// Para que el servicio pueda avisar cuando se rompe: si el proceso está vivo
// pero el último poll falla, /health lo delata. Si el proceso muere, deja de
// responder y el job de alertas lo detecta por HTTP.

// Pública a propósito: la consulta el job de alertas, que corre fuera del
// navegador y sin sesión (detrás de requireDashAuth daría 401 y el chequeo
// nunca vería un fallo). No expone datos: solo estado y edades.
let lastSysOkAtMs = 0;
let lastGatewayOkAtMs = 0;
app.get('/health', (req, res) => {
    const now = Date.now();
    const ageSys = lastSysOkAtMs ? now - lastSysOkAtMs : null;
    const ageGw = lastGatewayOkAtMs ? now - lastGatewayOkAtMs : null;
    // El sondeo rápido solo corre cuando hay un cliente conectado (para no
    // gastar CPU en vacío). Sin clientes, el proceso sano NO debe dar 503:
    // solo se exige muestra fresca cuando de verdad hay alguien mirando.
    const hasClients = clientCount > 0;
    const freshEnough = ageSys !== null && ageSys < 60000;
    const healthy = process.uptime() > 2 && (!hasClients || freshEnough);
    res.status(healthy ? 200 : 503).json({
        ok: healthy,
        uptimeSec: Math.round(process.uptime()),
        clients: clientCount,
        lastSysSampleAgoSec: ageSys === null ? null : Math.round(ageSys / 1000),
        lastGatewayOkAgoSec: ageGw === null ? null : Math.round(ageGw / 1000),
        gatewayOk: ocStatusCache?.gatewayOk === true,
    });
});

// Rate limit del login: 5 intentos fallidos por IP, luego bloqueo de 15 min.
// Sin esto, la clave (por fuerte que sea) queda expuesta a fuerza bruta desde
// un endpoint público sin ningún otro freno.
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of loginAttempts) if (now - a.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
}, 300000);

app.post('/api/login', express.json(), (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.count >= LOGIN_MAX_ATTEMPTS && (now - attempt.firstAt) < LOGIN_WINDOW_MS) {
    const waitMin = Math.ceil((LOGIN_WINDOW_MS - (now - attempt.firstAt)) / 60000);
    return res.status(429).json({ ok: false, error: `Demasiados intentos. Espera ${waitMin} min.` });
  }
  if (!verifyPassword(req.body?.password)) {
    if (!attempt || (now - attempt.firstAt) > LOGIN_WINDOW_MS) loginAttempts.set(ip, { count: 1, firstAt: now });
    else attempt.count++;
    return res.status(403).json({ ok: false, error: 'Clave incorrecta' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  dashSessions.set(token, Date.now());
  res.setHeader('Set-Cookie', `dash_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DASH_SESSION_TTL / 1000}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = getCookie(req, 'dash_session');
  if (token) dashSessions.delete(token);
  res.setHeader('Set-Cookie', 'dash_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

function requireDashAuth(req, res, next) {
  const token = getCookie(req, 'dash_session');
  if (!token || !dashSessions.has(token)) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'no autenticado' });
    return res.redirect('/login');
  }
  next();
}

io.use((socket, next) => {
  const token = parseCookie(socket.handshake.headers.cookie, 'dash_session');
  if (token && dashSessions.has(token)) return next();
  next(new Error('unauthorized'));
});

app.use(requireDashAuth);

// Administración privada del intercambio público. Las claves se muestran una
// sola vez al crearse; en disco solo se almacena su hash para poder validarlas.
app.get('/api/public-files/admin', (req, res) => {
  cleanPublicFiles();
  res.json({ ok: true, cleanupEnabled: publicFileCleanupEnabled, defaultTtlMinutes: publicFileDefaultTtlMinutes, files: publicFiles, keys: publicPersistenceKeys.map(({ hash, ...key }) => key) });
});
app.put('/api/public-files/settings', express.json(), (req, res) => {
  const minutes = Math.round(Number(req.body?.defaultTtlMinutes));
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > PUBLIC_FILE_TTL_MIN) return res.status(400).json({ ok: false, error: 'La duración debe estar entre 5 minutos y 24 horas.' });
  publicFileDefaultTtlMinutes = minutes;
  try { savePublicFiles(); } catch { return res.status(500).json({ ok: false, error: 'No se pudo guardar la duración.' }); }
  res.json({ ok: true, defaultTtlMinutes: publicFileDefaultTtlMinutes });
});
app.post('/api/public-files/keys', express.json(), (req, res) => {
  const label = String(req.body?.label || 'Clave persistente').trim().slice(0, 60) || 'Clave persistente';
  const rawKey = `nexo_${crypto.randomBytes(18).toString('base64url')}`;
  const key = { id: crypto.randomBytes(8).toString('hex'), label, hash: hashPersistenceKey(rawKey), createdAt: Date.now(), revokedAt: null };
  publicPersistenceKeys.unshift(key);
  try { savePublicFiles(); } catch { publicPersistenceKeys.shift(); return res.status(500).json({ ok: false, error: 'No se pudo guardar la clave.' }); }
  res.status(201).json({ ok: true, key: { ...key, hash: undefined, value: rawKey } });
});
app.delete('/api/public-files/keys/:id', (req, res) => {
  const key = publicPersistenceKeys.find((item) => item.id === req.params.id);
  if (!key) return res.status(404).json({ ok: false, error: 'Clave no encontrada.' });
  const previousRevokedAt = key.revokedAt;
  key.revokedAt = Date.now();
  try { savePublicFiles(); } catch {
    key.revokedAt = previousRevokedAt;
    return res.status(500).json({ ok: false, error: 'No se pudo revocar la clave.' });
  }
  res.json({ ok: true });
});
app.put('/api/public-files/:id/persistence', express.json(), (req, res) => {
  const file = publicFiles.find((item) => item.id === req.params.id);
  if (!file) return res.status(404).json({ ok: false, error: 'Archivo no encontrado.' });
  const persistent = req.body?.persistent === true;
  const key = persistent ? findPersistenceKey(req.body?.key) : null;
  if (persistent && !key) return res.status(403).json({ ok: false, error: 'La clave de persistencia no es válida.' });
  const previous = { persistent: file.persistent, persistenceKeyId: file.persistenceKeyId, expiresAt: file.expiresAt };
  file.persistent = persistent;
  file.persistenceKeyId = key?.id || null;
  file.expiresAt = persistent ? null : Date.now() + publicFileDefaultTtlMinutes * 60 * 1000;
  try { savePublicFiles(); } catch (error) {
    Object.assign(file, previous);
    return res.status(500).json({ ok: false, error: 'No se pudo actualizar la persistencia del archivo.' });
  }
  res.json({ ok: true, file });
});
app.delete('/api/public-files/:id', (req, res) => {
  const index = publicFiles.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ ok: false, error: 'Archivo no encontrado.' });
  const [file] = publicFiles.splice(index, 1);
  if (!/^[a-f0-9]{36}$/.test(String(file.id || ''))) {
    publicFiles.splice(index, 0, file);
    return res.status(400).json({ ok: false, error: 'El identificador del archivo no es válido.' });
  }
  try {
    try { fs.unlinkSync(path.join(PUBLIC_FILES_DIR, `${file.id}.bin`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    savePublicFiles();
  } catch (error) {
    publicFiles.splice(index, 0, file);
    console.error(`[public-files] manual delete failed for ${file.name || file.id}: ${error.code || error.message}`);
    return res.status(500).json({ ok: false, error: 'No se pudo eliminar el archivo; se conserva en el inventario para volver a intentarlo.' });
  }
  res.json({ ok: true });
});

// Vistas de primer nivel: comparten la sesión y los datos en vivo, pero cada
// URL muestra un área de trabajo concreta para evitar una página interminable.
const DASHBOARD_PAGES = new Set(['/', '/overview', '/performance', '/network', '/visitors', '/gateway', '/infrastructure', '/media', '/processes', '/actions', '/sessions']);
app.get(Array.from(DASHBOARD_PAGES), (req, res) => res.sendFile('index.html', { root: path.join(__dirname, 'public') }));

// Funcionalidades extendidas (extras.js): sus rutas quedan tras
// requireDashAuth, así que exigen sesión como todo lo demás.
extras.registerRoutes(app);
extras.boot();

app.post('/api/change-password', express.json(), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword)) {
    return res.status(403).json({ ok: false, error: 'Clave actual incorrecta' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: 'La clave nueva debe tener al menos 8 caracteres' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  authStore = { salt, hash: hashPassword(newPassword, salt) };
  try {
    fs.writeFileSync(AUTH_STORE_PATH, JSON.stringify(authStore), { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'No se pudo guardar la clave nueva' });
  }
  // Rotar la clave invalida todo lo emitido con la anterior: sesiones del
  // dashboard (hasta 24 h) y sesiones del panel de OpenClaw.
  dashSessions.clear();
  ocTokens.clear();
  res.json({ ok: true });
});

app.use(express.static('public', {
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
}));

app.get('/api/stats', (req, res) => {
    res.json({
        sys: sysCache || {},
        oc: buildOCPayload(),
        models: getModels(),
        ping: pingCache,
        memHistory,
        cpuHistory,
        processes: processesCache,
        gatewayLogs: gatewayLogsCache,
        player: playerCache,
        bluetooth: bluetoothCache,
        history: { short: shortHistory, daily: dailyHistory },
        pollingActive: clientCount > 0,
        // Claves NUEVAS (extras.js) — lo anterior se mantiene intacto.
        ...extras.snapshot(),
    });
});

// ===== Acceso a /oc-panel =====
// requireDashAuth ya corrió (esta ruta se registra después de app.use(requireDashAuth)),
// así que llegar aquí ya prueba que el visitante conoce la clave — no hace falta
// pedirla otra vez. Solo se emite la sesión propia de /oc-panel y se reenvía el
// token del gateway por si la consola de OpenClaw lo necesita para su propio login.
app.get('/oc-panel-login', (req, res) => {
  let gatewayToken;
  try {
    gatewayToken = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, 'utf8'))?.gateway?.auth?.token;
  } catch {}
  if (!gatewayToken) {
    return res.status(503).send('Token del Gateway no configurado');
  }
  const token = crypto.randomBytes(24).toString('hex');
  ocTokens.set(token, Date.now());
  res.setHeader('Set-Cookie', `oc_session=${encodeURIComponent(token)}; Path=/oc-panel; HttpOnly; SameSite=Strict; Max-Age=3600`);
  // Con barra final: la app del gateway usa rutas relativas ("./assets/...")
  // en su HTML — sin el "/" final, el navegador las resuelve como si fueran
  // hermanas de /oc-panel en vez de estar debajo, y el bundle nunca carga.
  // El "?token=" es el token REAL del gateway (no nuestra sesión) — la app de
  // OpenClaw lo necesita para su propio handshake de conexión; nuestra propia
  // auth se valida aparte, solo con la cookie oc_session.
  res.redirect(`/oc-panel/?token=${encodeURIComponent(gatewayToken)}`);
});

function requireOCPanelAuth(req, res, next) {
  const token = getCookie(req, 'oc_session');
  if (!token || !ocTokens.has(token)) {
    return res.status(401).send('OpenClaw Console: autenticación requerida');
  }
  next();
}

// La Control UI de OpenClaw genera URLs absolutas contra su basePath
// ("/oc-panel/assets/...", "/oc-panel/control-ui-config.json", y el WebSocket
// bajo "/oc-panel"). Por eso NO se recorta el prefijo: se reenvía tal cual y el
// Gateway lo sirve con gateway.controlUi.basePath = "/oc-panel".
const ocPanelProxy = createProxyMiddleware({
  target: OC_PANEL_TARGET,
  changeOrigin: true,
  ws: true,
  pathFilter: (pathname) => pathname === '/oc-panel' || pathname.startsWith('/oc-panel/'),
});
app.use('/oc-panel', requireOCPanelAuth);
app.use(ocPanelProxy);

// Los eventos 'upgrade' (WebSocket) no pasan por el pipeline de middleware de
// Express — hay que engancharlos aparte y repetir la validación de auth a mano
// (requireOCPanelAuth nunca se ejecuta para estos). Sin esto, la consola web
// de OpenClaw (que es WebSocket-only) nunca lograba conectar.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/oc-panel')) return;
  const token = parseCookie(req.headers.cookie, 'oc_session');
  if (!token || !ocTokens.has(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  ocPanelProxy.upgrade(req, socket, head);
});

// ===== Acciones del servidor =====
// Requieren sesión (ya validada por requireDashAuth); reboot/shutdown además
// piden la clave otra vez en el body, como segunda confirmación para acciones
// que afectan al servidor completo, no solo al dashboard.
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), error: err?.message });
    });
  });
}

// Bitácora local, acotada a las últimas 200 operaciones. No guarda claves ni
// parámetros sensibles: sirve para saber qué se ejecutó, cuándo y si funcionó.
const ACTION_AUDIT_PATH = path.join(__dirname, 'data', 'action-audit.json');
function readActionAudit() {
  try { const raw = JSON.parse(fs.readFileSync(ACTION_AUDIT_PATH, 'utf8')); return Array.isArray(raw) ? raw : []; } catch { return []; }
}
function auditAction(action, ok, detail) {
  const rows = readActionAudit();
  rows.unshift({ id: crypto.randomBytes(6).toString('hex'), at: Date.now(), action, ok: !!ok, detail: String(detail || '').slice(0, 180) });
  try { fs.mkdirSync(path.dirname(ACTION_AUDIT_PATH), { recursive: true }); fs.writeFileSync(ACTION_AUDIT_PATH, JSON.stringify(rows.slice(0, 200), null, 2), { mode: 0o600 }); } catch {}
}
app.get('/api/actions/audit', (req, res) => res.json({ ok: true, entries: readActionAudit().slice(0, 50) }));

app.post('/api/actions/restart-openclaw', express.json(), async (req, res) => {
  const r = await runCmd('systemctl', ['--user', 'restart', GATEWAY_UNIT], { env: XDG_ENV });
  if (r.ok) { ocFailures.status = undefined; delete ocFailures.status; }
  auditAction('Reiniciar OpenClaw', r.ok, r.ok ? 'Gateway reiniciado' : (r.error || r.stderr));
  res.json(r);
});

app.post('/api/actions/free-ram', express.json(), async (req, res) => {
  const before = sysCache?.memAvailGB ?? null;
  // Sin `sh -c`: solo estas dos órdenes concretas están en sudoers, así que
  // no queda un shell con privilegios ejecutando texto.
  await runCmd('sync');
  const r = await runCmd('sudo', ['/usr/sbin/sysctl', '-w', 'vm.drop_caches=1']);
  const sys = await getSysStats();
  auditAction('Liberar RAM', r.ok, r.ok ? `Disponible: ${before ?? '?'} GB → ${sys.memAvailGB ?? '?'} GB` : r.error || r.stderr);
  res.json({ ...r, beforeGB: before, afterGB: sys.memAvailGB ?? null });
});

app.post('/api/actions/free-swap', express.json(), async (req, res) => {
  const beforeMiB = Math.round((sysCache?.swapUsedMB ?? 0));
  const off = await runCmd('sudo', ['/sbin/swapoff', '-a'], { timeout: 60000 });
  const on = await runCmd('sudo', ['/sbin/swapon', '-a'], { timeout: 60000 });
  const r = off.ok && on.ok ? on : { ok: false, error: off.error || on.error };
  const sys = await getSysStats();
  const afterMiB = Math.round((sys.swapUsedMB ?? 0));
  auditAction('Liberar swap', r.ok, r.ok ? `${beforeMiB} MiB → ${afterMiB} MiB` : r.error || r.stderr);
  res.json({ ...r, beforeMiB, afterMiB });
});

app.post('/api/actions/doctor-fix', express.json(), async (req, res) => {
  const r = await runCmd('openclaw', ['doctor', '--fix'], { env: XDG_ENV, timeout: 120000 });
  if (r.ok) { ocFailures.status = undefined; delete ocFailures.status; }
  auditAction('Doctor Fix', r.ok, r.ok ? 'Finalizado' : r.error || r.stderr);
  res.json(r);
});

app.post('/api/actions/reboot', express.json(), async (req, res) => {
  if (!verifyPassword(req.body?.password)) return res.status(403).json({ ok: false, error: 'Clave incorrecta' });
  auditAction('Reiniciar servidor', true, 'Reinicio programado');
  res.json({ ok: true, message: 'Reiniciando el servidor…' });
  setTimeout(() => execFile('sudo', ['reboot'], () => {}), 1500);
});

app.post('/api/actions/shutdown', express.json(), async (req, res) => {
  if (!verifyPassword(req.body?.password)) return res.status(403).json({ ok: false, error: 'Clave incorrecta' });
  const hours = Math.min(24, Math.max(1, Number(req.body?.hours) || 1));
  const wakeAt = Math.floor(Date.now() / 1000) + hours * 3600;
  auditAction('Apagar servidor', true, `Apagado programado; despertar en ${hours} h`);
  res.json({ ok: true, message: `Apagando — despertará en ${hours}h`, wakeAt });
  setTimeout(() => execFile('sudo', ['rtcwake', '-m', 'off', '-t', String(wakeAt)], () => {}), 1500);
});

// ===== Control del reproductor (MPD) =====
app.post('/api/player/toggle', express.json(), async (req, res) => {
  try {
    const status = await mpdCommand('status');
    await mpdCommand(status.state === 'play' ? 'pause 1' : 'play');
    res.json({ ok: true });
  } catch (e) { res.status(503).json({ ok: false, error: 'MPD no disponible' }); }
});

app.post('/api/player/next', express.json(), async (req, res) => {
  try { await mpdCommand('next'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false, error: 'MPD no disponible' }); }
});

app.post('/api/player/prev', express.json(), async (req, res) => {
  try { await mpdCommand('previous'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false, error: 'MPD no disponible' }); }
});

app.post('/api/player/volume', express.json(), async (req, res) => {
  const vol = Math.min(100, Math.max(0, Number(req.body?.volume)));
  if (Number.isNaN(vol)) return res.status(400).json({ ok: false, error: 'volumen inválido' });
  try { await mpdCommand(`setvol ${vol}`); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false, error: 'MPD no disponible' }); }
});

app.post('/api/player/random', express.json(), async (req, res) => {
  try { await mpdCommand(`random ${req.body?.enabled ? 1 : 0}`); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false, error: 'MPD no disponible' }); }
});

app.get('/api/player/art', async (req, res) => {
  try {
    const song = await mpdCommand('currentsong');
    if (!song.file) return res.status(404).end();
    const art = await fetchAlbumArt(song.file);
    if (!art || !art.length) return res.status(404).end();
    const contentType = (art[0] === 0x89 && art[1] === 0x50) ? 'image/png' : 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(art);
  } catch {
    res.status(404).end();
  }
});

app.get('/api/player/queue', async (req, res) => {
  try {
    const status = await mpdCommand('status');
    const total = Number(status.playlistlength) || 0;
    const curPos = Number(status.song) || 0;
    const start = Math.max(0, curPos - 5);
    const end = Math.min(total, curPos + 35);
    const items = total ? await mpdCommandList(`playlistinfo ${start}:${end}`, 5000) : [];
    res.json({
      ok: true,
      currentPos: curPos,
      total,
      start,
      items: items.map((s) => ({
        pos: Number(s.Pos),
        id: Number(s.Id),
        title: s.Title || (s.file ? s.file.split('/').pop().replace(/\.[^./]+$/, '') : '?'),
        artist: s.Artist || null,
        duration: Number(s.duration || s.Time) || 0,
      })),
    });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/player/playid', express.json(), async (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
  try { await mpdCommand(`playid ${id}`); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false, error: 'MPD no disponible' }); }
});

// ===== OpenClaw CLI: single-flight + process-group kill + circuit breaker =====
// El CLI de openclaw arranca un runtime Node completo por invocación (varios
// segundos de CPU real) y resultó ser poco fiable en este equipo (se cuelga
// incluso invocado en aislado). Sin estas guardas, timeouts dejaban procesos
// huérfanos (sudo -i abre una sesión propia que sobrevive al SIGTERM del
// padre) y se acumulaban sin límite hasta agotar la RAM del servidor. Solo se
// usa ya para "sessions list" — el estado del gateway se lee de systemd/HTTP.
const OC_MAX_CONCURRENT = 1;
let ocActiveCount = 0;
const ocInFlight = {};
const ocFailures = {};

function isCircuitOpen(key) {
  const f = ocFailures[key];
  return !!(f && Date.now() < f.nextAllowedAt);
}

function recordFailure(key) {
  const f = ocFailures[key] || { count: 0, nextAllowedAt: 0 };
  f.count++;
  if (f.count >= 3) {
    const backoff = Math.min(120000, 5000 * Math.pow(2, f.count - 3));
    f.nextAllowedAt = Date.now() + backoff;
  }
  ocFailures[key] = f;
}

function recordSuccess(key) {
  delete ocFailures[key];
}

function runOC(argsArr, timeoutMs, key) {
  if (ocInFlight[key]) return ocInFlight[key];
  if (isCircuitOpen(key)) return Promise.resolve(null);
  if (ocActiveCount >= OC_MAX_CONCURRENT) return Promise.resolve(null);

  ocActiveCount++;
  const p = new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn('openclaw', argsArr, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      ocActiveCount--;
      return resolve(null);
    }

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});

    const timer = setTimeout(() => {
      if (settled) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      finish(null);
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ocActiveCount--;
      resolve(result);
    }

    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0 || !out.trim()) return finish(null);
      try { finish(JSON.parse(out)); }
      catch { finish(null); }
    });
  });

  ocInFlight[key] = p.finally(() => { delete ocInFlight[key]; });
  ocInFlight[key].then((result) => {
    if (result === null) recordFailure(key); else recordSuccess(key);
  });

  return ocInFlight[key];
}

function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      done = true;
      const ms = Date.now() - start;
      socket.destroy();
      resolve(ms);
    });
    socket.once('error', () => { if (!done) { done = true; resolve(null); } });
    socket.once('timeout', () => { if (!done) { done = true; socket.destroy(); resolve(null); } });
    socket.connect(port, host);
  });
}

// ===== MPD (reproductor de música, sale por Bluetooth vía PulseAudio) =====
const MPD_HOST = '127.0.0.1';
const MPD_PORT = 6600;

function parseMpdResponse(raw) {
  const lines = raw.replace(/\n+$/, '').split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (last.startsWith('ACK ')) throw new Error(last);
  const dataLines = last === 'OK' ? lines.slice(0, -1) : lines;
  const obj = {};
  dataLines.forEach((line) => {
    const idx = line.indexOf(': ');
    if (idx > 0) obj[line.slice(0, idx)] = line.slice(idx + 2);
  });
  return obj;
}

// playlistinfo (y similares) repiten la clave "file" una vez por canción —
// no es un objeto plano como "status", es una lista; cada "file:" nuevo
// marca el inicio de un registro distinto.
function parseMpdList(raw) {
  const lines = raw.replace(/\n+$/, '').split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (last.startsWith('ACK ')) throw new Error(last);
  const dataLines = last === 'OK' ? lines.slice(0, -1) : lines;
  const items = [];
  let current = null;
  dataLines.forEach((line) => {
    const idx = line.indexOf(': ');
    if (idx <= 0) return;
    const key = line.slice(0, idx);
    const val = line.slice(idx + 2);
    if (key === 'file') {
      if (current) items.push(current);
      current = {};
    }
    if (!current) current = {};
    current[key] = val;
  });
  if (current) items.push(current);
  return items;
}

function mpdRaw(cmd, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(MPD_PORT, MPD_HOST);
    let buffer = '';
    let gotGreeting = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('mpd timeout')); }, timeoutMs);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!gotGreeting) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        gotGreeting = true;
        buffer = buffer.slice(nl + 1);
        socket.write(cmd + '\n');
        return;
      }
      const lastLine = buffer.replace(/\n+$/, '').split('\n').pop();
      if (lastLine === 'OK' || lastLine.startsWith('ACK ')) {
        clearTimeout(timer);
        socket.end();
        resolve(buffer);
      }
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function mpdCommand(cmd, timeoutMs) {
  return mpdRaw(cmd, timeoutMs).then(parseMpdResponse);
}

function mpdCommandList(cmd, timeoutMs) {
  return mpdRaw(cmd, timeoutMs).then(parseMpdList);
}

async function getPlayerStatus() {
  try {
    const [status, song] = await Promise.all([mpdCommand('status'), mpdCommand('currentsong')]);
    const fileName = song.file ? song.file.split('/').pop().replace(/\.[^./]+$/, '') : null;
    return {
      ok: true,
      state: status.state || 'stop',
      volume: Number(status.volume) || 0,
      elapsed: Number(status.elapsed) || 0,
      duration: Number(status.duration || song.duration) || 0,
      random: status.random === '1',
      repeat: status.repeat === '1',
      title: song.Title || fileName,
      artist: song.Artist || null,
      album: song.Album || null,
    };
  } catch {
    return { ok: false };
  }
}

// albumart/readpicture devuelven metadata de texto seguida de bytes binarios
// crudos (la carátula) — no se puede tratar como texto plano como el resto de
// comandos MPD, hay que leer el buffer sin decodificar y cortar por offsets.
function mpdBinaryChunk(command, uri, offset, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(MPD_PORT, MPD_HOST);
    let buf = Buffer.alloc(0);
    let gotGreeting = false;
    let headerParsed = false;
    let total = 0, chunkSize = 0, dataStart = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('mpd art timeout')); }, timeoutMs);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!gotGreeting) {
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        gotGreeting = true;
        buf = buf.slice(nl + 1);
        socket.write(`${command} "${uri}" ${offset}\n`);
        return;
      }
      if (!headerParsed) {
        const headStr = buf.slice(0, Math.min(buf.length, 200)).toString('latin1');
        if (headStr.startsWith('ACK ')) { clearTimeout(timer); socket.destroy(); return resolve(null); }
        const sizeMatch = headStr.match(/^size: (\d+)\n/);
        const binMatch = headStr.match(/binary: (\d+)\n/);
        if (!sizeMatch || !binMatch) return;
        total = Number(sizeMatch[1]);
        chunkSize = Number(binMatch[1]);
        dataStart = headStr.indexOf(binMatch[0]) + binMatch[0].length;
        headerParsed = true;
      }
      if (buf.length < dataStart + chunkSize) return;
      clearTimeout(timer);
      socket.end();
      resolve({ data: buf.slice(dataStart, dataStart + chunkSize), total, chunkSize });
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function fetchAlbumArt(uri) {
  for (const cmd of ['albumart', 'readpicture']) {
    try {
      const chunks = [];
      let offset = 0, total = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await mpdBinaryChunk(cmd, uri, offset, 2000);
        if (!result || result.total === 0) break;
        chunks.push(result.data);
        total = result.total;
        offset += result.chunkSize;
        if (result.chunkSize === 0 || offset >= total) break;
      }
      if (chunks.length && total > 0) return Buffer.concat(chunks);
    } catch { /* probar el siguiente comando */ }
  }
  return null;
}

// El MAC se saca del sink por defecto de PulseAudio en vez de estar fijo en
// código — si algún día se empareja otro parlante, sigue funcionando solo.
function getBluetoothMac(timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile('pactl', ['get-default-sink'], { timeout: timeoutMs, env: XDG_ENV }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/bluez_sink\.([0-9A-Fa-f_]+)\./);
      resolve(m ? m[1].replace(/_/g, ':') : null);
    });
  });
}

async function getBluetoothInfo() {
  const mac = await getBluetoothMac();
  if (!mac) return { connected: false };
  return new Promise((resolve) => {
    execFile('bluetoothctl', ['info', mac], { timeout: 3000, env: XDG_ENV }, (err, stdout) => {
      if (err || !stdout) return resolve({ connected: false });
      const name = (stdout.match(/Name: (.+)/) || [])[1] || null;
      const connected = /Connected: yes/.test(stdout);
      const battMatch = stdout.match(/Battery Percentage: 0x[0-9a-fA-F]+ \((\d+)\)/);
      resolve({
        connected,
        name,
        battery: battMatch ? Number(battMatch[1]) : null,
      });
    });
  });
}

function checkGatewayHealth(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get({ host: '127.0.0.1', port: 18789, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let ok = false;
        try { ok = JSON.parse(body)?.ok === true; } catch {}
        resolve({ ok, latencyMs: Date.now() - start });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, latencyMs: null }); });
    req.on('error', () => resolve({ ok: false, latencyMs: null }));
  });
}

function getSystemctlShow(unit, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile('systemctl', [
        '--user', 'show', unit, '--no-page',
        '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
        '-p', 'NRestarts', '-p', 'MemoryCurrent', '-p', 'TasksCurrent',
      ], { timeout: timeoutMs, env: XDG_ENV }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const out = {};
        stdout.split('\n').forEach((line) => {
          const idx = line.indexOf('=');
          if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
        });
        resolve(out);
      });
  });
}

function getGatewayLogs(timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile('journalctl', [
        '--user', '-u', GATEWAY_UNIT, '-n', '12', '--no-pager', '-o', 'cat',
      ], { timeout: timeoutMs, env: XDG_ENV }, (err, stdout) => {
        resolve(err ? [] : stdout.split('\n').filter(Boolean));
      });
  });
}

// ===== Sistema =====
const HISTORY_LEN = 30;
// Historial en memoria complementado con muestras persistentes al arrancar.
const SHORT_WINDOW_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const startupSamples = extras.getSamples().filter(sample =>
    Number.isFinite(sample.t) && Number.isFinite(Number(sample.cpu)) && Number.isFinite(Number(sample.ram))
).map(sample => ({ t: sample.t, cpu: Number(sample.cpu), ram: Number(sample.ram) })).sort((a, b) => a.t - b.t);
const startupNow = Date.now();
const shortHistory = startupSamples.filter(sample => startupNow - sample.t <= SHORT_WINDOW_MS);
const dailyHistory = startupSamples.filter(sample => startupNow - sample.t <= DAILY_WINDOW_MS);
let lastDailySampleMs = dailyHistory.length ? dailyHistory[dailyHistory.length - 1].t : 0;
let sysCache = null;
let pingCache = null;
let processesCache = [];
let ocStatusCache = null;
let sessionsCache = null;
let gatewayLogsCache = [];
let gatewayVersionCache = null;
let playerCache = { ok: false };
let bluetoothCache = { connected: false };
let visitorsCache = { active: [], total: 0, windowSec: 0 };
const memHistory = [];
const cpuHistory = [];

// ===== Visitantes en tiempo real (desde el access log de nginx) =====
// El tráfico entra por Cloudflare Tunnel (cloudflared) → nginx, así que
// $remote_addr siempre es 127.0.0.1. La IP real del visitante viene en el
// header CF-Connecting-IP, que el log_format `main_cf` registra como
// segundo campo (formato: remote|cfip|time|method|uri|status|ua).
const NGINX_ACCESS_LOG = '/var/log/nginx/access.log';
const VISITOR_WINDOW_MS = 5 * 60 * 1000; // se considera "activo" si tocó algo en los últimos 5 min
const VISITOR_IDLE_MS = 60 * 1000; // si no hay actividad en 1 min, se marca como inactivo

function parseNginxTime(t) {
    // Formato: "02/Aug/2026:11:56:55 -0500"
    const m = String(t).match(/(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const mo = MONTHS[m[2]];
    if (mo === undefined) return null;
    return new Date(Number(m[3]), mo, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

function parseUserAgent(ua) {
    const s = String(ua || '');
    let device = 'Desconocido';
    let browser = '';
    if (/iPhone|iPad|iPod/.test(s)) device = '📱 iOS';
    else if (/Android/.test(s)) device = /Mobile/.test(s) ? '📱 Android' : '📱 Android Tablet';
    else if (/Windows/.test(s)) device = '💻 Windows';
    else if (/Macintosh|Mac OS X/.test(s)) device = '💻 macOS';
    else if (/Linux/.test(s)) device = '🐧 Linux';
    else if (/curl|wget|python|Go-http|bot|spider|crawl/i.test(s)) device = '🤖 Bot';
    if (/Chrome\/([\d.]+)/.test(s)) browser = 'Chrome ' + s.match(/Chrome\/([\d.]+)/)[1];
    else if (/Firefox\/([\d.]+)/.test(s)) browser = 'Firefox ' + s.match(/Firefox\/([\d.]+)/)[1];
    else if (/Safari\/([\d.]+)/.test(s) && !/Chrome/.test(s)) browser = 'Safari';
    else if (/Edg\/([\d.]+)/.test(s)) browser = 'Edge ' + s.match(/Edg\/([\d.]+)/)[1];
    else if (/curl\/([\d.]+)/.test(s)) browser = 'curl ' + s.match(/curl\/([\d.]+)/)[1];
    return { device, browser };
}

// Devuelve el dominio principal (registrable-ish) de un host: quita el ultimo
// segmento de subdominio. app.corposoft.net -> corposoft.net ; corposoft.net -> corposoft.net.
// Es heuristico (no usa la Public Suffix List) pero suficiente para hosts propios.
function baseDomainOf(host) {
    const h = String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
    if (!h) return null;
    const labels = h.split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    return labels.slice(-2).join('.');
}

function readAccessLogTail(maxBytes = 4 * 1024 * 1024) {
    try {
        const fd = fs.openSync(NGINX_ACCESS_LOG, 'r');
        const stat = fs.fstatSync(fd);
        const size = stat.size;
        const start = Math.max(0, size - maxBytes);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        // Cortar en el primer salto de línea para no partir una línea a la mitad
        let text = buf.toString('utf8');
        const firstNl = text.indexOf('\n');
        if (firstNl > 0) text = text.slice(firstNl + 1);
        return text;
    } catch {
        return '';
    }
}

// Dominio principal del proyecto: toda visita a *.corposoft.net se etiqueta
// con este dominio y su subdominio ("" = dominio raíz).
const PRIMARY_DOMAIN = 'corposoft.net';

function splitDomain(host) {
    const h = String(host || '').trim().toLowerCase().split(':')[0];
    if (!h) return { host: '', domain: PRIMARY_DOMAIN, subdomain: '' };
    if (h === PRIMARY_DOMAIN || h.endsWith('.' + PRIMARY_DOMAIN)) {
        const sub = h === PRIMARY_DOMAIN ? '' : h.slice(0, -(PRIMARY_DOMAIN.length + 1));
        return { host: h, domain: PRIMARY_DOMAIN, subdomain: sub };
    }
    return { host: h, domain: h, subdomain: '' };
}

async function getVisitors() {
    const now = Date.now();
    // Una IP no representa una persona ni un dispositivo: una casa/oficina
    // puede compartir IP. Conservamos sesiones separadas por IP + navegador
    // (User-Agent) + host para mostrar móvil y escritorio por separado.
    const byVisitor = new Map();
    try {
        const text = readAccessLogTail();
        const lines = text.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            // Formato nuevo: ip|cfip|host|time|method|uri|status|ua
            // (acepta el formato viejo de 7 campos sin host para no romper logs previos)
            const parts = line.split('|');
            let ip = null, ts = null, method = null, uri = null, status = null, ua = null, host = null;
            if (parts.length >= 8) {
                ip = (parts[1] || '').trim();
                host = (parts[2] || '').trim() || null;
                ts = parseNginxTime(parts[3]);
                method = parts[4];
                uri = parts[5];
                status = parts[6];
                ua = parts.slice(7).join('|');
            } else if (parts.length >= 7) {
                ip = (parts[1] || '').trim();
                ts = parseNginxTime(parts[2]);
                method = parts[3];
                uri = parts[4];
                status = parts[5];
                ua = parts.slice(6).join('|');
            } else {
                // Formato viejo (combinado): 127.0.0.1 - - [ts] "GET /x HTTP/1.1" 200 n "ref" "ua"
                const m = line.match(/^([\d.]+) - - \[([^\]]+)\] "(\w+) ([^ ]+)/);
                if (!m) continue;
                ip = m[1];
                ts = parseNginxTime(m[2]);
                method = m[3];
                uri = m[4];
                const uaMatch = line.match(/"([^"]*)"$/);
                ua = uaMatch ? uaMatch[1] : '';
                status = null;
            }
            if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') continue;
            if (!ts || now - ts > VISITOR_WINDOW_MS) continue;
            const rec = byIp.get(ip) || { ip, firstSeen: ts, lastSeen: ts, requests: 0, lastUri: uri, lastStatus: status, ua, hosts: new Set() };
            rec.requests++;
            if (host) rec.hosts.add(host);
            if (ts > rec.lastSeen) { rec.lastSeen = ts; rec.lastUri = uri; rec.lastStatus = status; rec.ua = ua; if (host) rec.lastHost = host; else rec.lastHost = rec.lastHost || null; }
            if (ts < rec.firstSeen) rec.firstSeen = ts;
            byVisitor.set(key, rec);
        }
    } catch {}
    const active = Array.from(byVisitor.values())
        .map(r => {
            const { device, browser } = parseUserAgent(r.ua);
            const idleMs = now - r.lastSeen;
            const hosts = Array.from(r.hosts || []).sort();
            const lastHost = r.lastHost || hosts[hosts.length - 1] || null;
            // Dominio principal = ultimo segmento con TLD (p.ej. app.corposoft.net -> corposoft.net)
            const baseDomain = lastHost ? baseDomainOf(lastHost) : null;
            return {
                ip: r.ip,
                host: r.host || r.domain,
                domain: r.domain,
                subdomain: r.subdomain || '',
                device,
                browser,
                requests: r.requests,
                lastSeen: r.lastSeen,
                lastUri: r.lastUri || '/',
                lastStatus: r.lastStatus,
                host: lastHost,
                baseDomain,
                hosts,
                subdomain: lastHost && baseDomain && lastHost !== baseDomain
                    ? lastHost.slice(0, -(baseDomain.length + 1)) : null,
                active: idleMs < VISITOR_IDLE_MS,
                idleSec: Math.round(idleMs / 1000),
            };
        })
        .sort((a, b) => b.lastSeen - a.lastSeen);
    visitorsCache = {
        active: active.filter(v => v.active),
        total: active.length,
        windowSec: VISITOR_WINDOW_MS / 1000,
    };
    return visitorsCache;
}

async function pollVisitors() {
    await getVisitors();
    io.emit('stats', { visitors: visitorsCache });
}

// Guarda una muestra en los dos buffers y descarta lo que salga de la ventana.
function recordHistory(cpu, ram, now) {
    shortHistory.push({ t: now, cpu, ram });
    while (shortHistory.length && now - shortHistory[0].t > SHORT_WINDOW_MS) shortHistory.shift();
    if (now - lastDailySampleMs >= 60000) {
        lastDailySampleMs = now;
        dailyHistory.push({ t: now, cpu, ram });
        while (dailyHistory.length && now - dailyHistory[0].t > DAILY_WINDOW_MS) dailyHistory.shift();
    }
}

async function getSysStats() {
    try {
        const [cpu, mem, temp, osInfo, fsSize, netStats] = await Promise.all([
            si.currentLoad(), si.mem(), si.cpuTemperature(), si.osInfo(),
            si.fsSize(), si.networkStats()
        ]);
        const timeData = si.time();
        const rootFs = fsSize.find(d => d.mount === '/') || fsSize[0];
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
            .split('\n').reduce((acc, line) => {
                const m = line.match(/^(\w+):\s+(\d+)\s+kB$/);
                if (m) acc[m[1]] = Number(m[2]);
                return acc;
            }, {});
        const memTotalKB = meminfo.MemTotal;
        const memAvailKB = meminfo.MemAvailable;
        const swapTotalKB = meminfo.SwapTotal;
        const swapFreeKB = meminfo.SwapFree;
        const memAvailPct = (memAvailKB && memTotalKB) ? (memAvailKB / memTotalKB * 100) : null;
        const swapUsedPct = (swapTotalKB > 0) ? ((swapTotalKB - (swapFreeKB || 0)) / swapTotalKB * 100) : null;
        const memUsedPct = Number(((mem.active / mem.total) * 100).toFixed(1));

        const stats = {
            cpu: Number(cpu.currentLoad.toFixed(1)),
            cpuCores: (cpu.cpus || []).map(c => Number(c.load.toFixed(1))),
            cpuTemp: temp.main || null,
            memUsed: memUsedPct,
            memTotalGB: Number((mem.total / 1024 ** 3).toFixed(1)),
            memUsedGB: Number((mem.active / 1024 ** 3).toFixed(1)),
            memAvailGB: memAvailKB ? Number((memAvailKB * 1024 / 1024 ** 3).toFixed(1)) : null,
            memAvailPct: memAvailPct !== null ? Number(memAvailPct.toFixed(1)) : null,
            swapUsedPct: swapUsedPct !== null ? Number(swapUsedPct.toFixed(1)) : null,
            swapUsedMB: (swapTotalKB && swapFreeKB) ? Math.round((swapTotalKB - swapFreeKB) / 1024) : 0,
            swapTotalMB: swapTotalKB ? Math.round(swapTotalKB / 1024) : 0,
            swapFreeMB: swapFreeKB ? Math.round(swapFreeKB / 1024) : 0,
            diskUsedPct: rootFs ? Number(rootFs.use.toFixed(1)) : null,
            diskUsedGB: rootFs ? Number((rootFs.used / 1e9).toFixed(1)) : null,
            diskTotalGB: rootFs ? Number((rootFs.size / 1e9).toFixed(1)) : null,
            netRx: netStats?.[0]?.rx_sec ?? 0,
            netTx: netStats?.[0]?.tx_sec ?? 0,
            uptime: timeData.uptime,
            hostname: osInfo.hostname,
            osDistro: osInfo.distro,
        };
        sysCache = stats;
        lastSysOkAtMs = Date.now();
        cpuHistory.push(stats.cpu);
        if (cpuHistory.length > HISTORY_LEN) cpuHistory.shift();
        memHistory.push(memUsedPct);
        if (memHistory.length > HISTORY_LEN) memHistory.shift();
        recordHistory(stats.cpu, memUsedPct, Date.now());
        return stats;
    } catch {
        return sysCache || {};
    }
}

async function getTopProcesses() {
    try {
        const data = await si.processes();
        processesCache = (data.list || [])
            .slice()
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 6)
            .map(p => ({
                pid: p.pid,
                name: p.name,
                cpu: Number((p.cpu || 0).toFixed(1)),
                memRss: Number((p.memRss || 0) / 1024).toFixed(0),
            }));
    } catch {}
    return processesCache;
}

async function pollGateway() {
    const [health, svc] = await Promise.all([
        checkGatewayHealth(),
        getSystemctlShow(GATEWAY_UNIT),
    ]);
    if (!gatewayVersionCache) {
        try {
            gatewayVersionCache = JSON.parse(
                fs.readFileSync('/usr/lib/node_modules/openclaw/package.json', 'utf8')
            ).version;
        } catch {}
    }
    ocStatusCache = {
        pid: svc?.MainPID ?? '?',
        status: svc?.SubState ?? (health.ok ? 'running' : 'desconocido'),
        activeState: svc?.ActiveState ?? '?',
        memMB: (svc?.MemoryCurrent && svc.MemoryCurrent !== '[not set]') ? Math.round(Number(svc.MemoryCurrent) / 1024 / 1024) : '?',
        tasks: svc?.TasksCurrent ?? '?',
        nRestarts: svc?.NRestarts ?? '?',
        version: gatewayVersionCache ?? '?',
        gatewayOk: health.ok,
        healthLatencyMs: health.latencyMs,
    };
    if (health.ok) lastGatewayOkAtMs = Date.now();
    io.emit('stats', { oc: buildOCPayload(), models: getModels() });
}

async function pollGatewayLogs() {
    gatewayLogsCache = await getGatewayLogs();
    io.emit('stats', { gatewayLogs: gatewayLogsCache });
}

async function pollSessions() {
    const sd = await runOC(['sessions', 'list', '--json', '--limit', '10'], 6000, 'sessions');
    if (sd?.sessions) {
        sessionsCache = sd.sessions.map(s => ({
            agentId: s.agentId || '?',
            model: (s.model || '').split('/').pop() || '?',
            status: s.status || '?',
            duration: ((s.runtimeMs || 0) / 1000).toFixed(0) + 's',
            startedAt: s.startedAt,
            channel: s.lastChannel || s.channel || '',
        }));
    }
    io.emit('stats', { oc: buildOCPayload() });
}

function buildOCPayload() {
    return {
        ...(ocStatusCache || { gatewayOk: false, status: 'desconocido' }),
        sessionsActive: (sessionsCache || []).length,
        sessions: sessionsCache || [],
        sessionsCircuitOpen: isCircuitOpen('sessions'),
    };
}

function getModels() {
    try {
        const cfg = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, 'utf8'));
        const defs = cfg?.agents?.defaults;
        return { primary: defs?.model?.primary ?? null, fallbacks: defs?.model?.fallbacks ?? [] };
    } catch { return {}; }
}

async function pollPing() {
    pingCache = await tcpPing('1.1.1.1', 443, 2000);
    io.emit('stats', { ping: pingCache });
}

// ===== Poll global (una sola vez para todos los clientes conectados) =====
let clientCount = 0;
let ivFast = null, ivProcs = null, ivGateway = null, ivGatewayLogs = null, ivSessions = null, ivPing = null, ivBluetooth = null, ivVisitors = null, ivExtrasSlow = null;

function startPolling() {
    if (ivFast) return;
    ivFast = setInterval(async () => {
        const sys = await getSysStats();
        const player = await getPlayerStatus();
        playerCache = player;
        const { io: ioStats, alerts } = await extras.pollFast(sys);
        io.emit('stats', { sys, memHistory, cpuHistory, player, history: { short: shortHistory, daily: dailyHistory }, io: ioStats, alerts });
    }, 2000);
    ivProcs = setInterval(async () => {
        const processes = await getTopProcesses();
        io.emit('stats', { processes });
    }, 5000);
    ivGateway = setInterval(pollGateway, 8000);
    ivGatewayLogs = setInterval(pollGatewayLogs, 20000);
    ivSessions = setInterval(pollSessions, 90000);
    ivPing = setInterval(pollPing, 10000);
    ivVisitors = setInterval(pollVisitors, 5000);
    ivBluetooth = setInterval(async () => {
        bluetoothCache = await getBluetoothInfo();
        io.emit('stats', { bluetooth: bluetoothCache });
    }, 20000);
    // Fuentes pesadas de extras (docker, servicios systemd, SMART, checks):
    // cada 30 s bastan y cuidan la CPU del E-300.
    ivExtrasSlow = setInterval(async () => {
        const extra = await extras.pollSlow();
        io.emit('stats', extra);
    }, 30000);
    getSysStats().then(sys => io.emit('stats', { sys, memHistory, cpuHistory }));
    getTopProcesses().then(processes => io.emit('stats', { processes }));
    getPlayerStatus().then(player => { playerCache = player; io.emit('stats', { player }); });
    getBluetoothInfo().then(bt => { bluetoothCache = bt; io.emit('stats', { bluetooth: bt }); });
    pollGateway();
    pollGatewayLogs();
    pollSessions();
    pollPing();
    pollVisitors();
    extras.pollSlow().then((extra) => io.emit('stats', extra));
}

function stopPolling() {
    clearInterval(ivFast); clearInterval(ivProcs); clearInterval(ivGateway);
    clearInterval(ivGatewayLogs); clearInterval(ivSessions); clearInterval(ivPing);
    clearInterval(ivBluetooth); clearInterval(ivVisitors); clearInterval(ivExtrasSlow);
    ivFast = ivProcs = ivGateway = ivGatewayLogs = ivSessions = ivPing = ivBluetooth = ivVisitors = ivExtrasSlow = null;
}

io.on('connection', (socket) => {
  clientCount++;
  if (clientCount === 1) startPolling();

  socket.emit('stats', {
      sys: sysCache || {},
      memHistory, cpuHistory,
      history: { short: shortHistory, daily: dailyHistory },
      processes: processesCache,
      oc: buildOCPayload(),
      models: getModels(),
      ping: pingCache,
      gatewayLogs: gatewayLogsCache,
      player: playerCache,
      bluetooth: bluetoothCache,
      visitors: visitorsCache,
      ...extras.snapshot(),
  });

  socket.on('disconnect', () => {
      clientCount--;
      if (clientCount === 0) stopPolling();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '127.0.0.1', () => {
    console.log(`🔗 NexoDashboard on :${PORT}`);
});
