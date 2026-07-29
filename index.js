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

const app = express();
app.set('trust proxy', 'loopback');
const server = http.createServer(app);
const io = new Server(server);

// La clave vive en un archivo aparte (no en el código) para que se pueda
// cambiar desde el propio dashboard sin editar índex.js ni reiniciar nada.
const AUTH_STORE_PATH = path.join(__dirname, 'auth.json');
function loadOCKey() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_STORE_PATH, 'utf8')).password;
  } catch {
    return 'z7xs3kGh7qKcTN4ADyEiDB';
  }
}
let OC_KEY = loadOCKey();
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
app.get('/theme.css', (req, res) => res.sendFile('theme.css', { root: path.join(__dirname, 'public') }));

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
  if (req.body?.password !== OC_KEY) {
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

app.post('/api/change-password', express.json(), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (currentPassword !== OC_KEY) {
    return res.status(403).json({ ok: false, error: 'Clave actual incorrecta' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ ok: false, error: 'La clave nueva debe tener al menos 8 caracteres' });
  }
  OC_KEY = newPassword;
  try {
    fs.writeFileSync(AUTH_STORE_PATH, JSON.stringify({ password: newPassword }), { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'No se pudo guardar la clave nueva' });
  }
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
        pollingActive: clientCount > 0,
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

const ocPanelProxy = createProxyMiddleware({
  target: OC_PANEL_TARGET,
  changeOrigin: true,
  ws: true,
  pathRewrite: { '^/oc-panel': '' },
});
app.use('/oc-panel', requireOCPanelAuth, ocPanelProxy);

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

app.post('/api/actions/restart-openclaw', express.json(), async (req, res) => {
  const r = await runCmd('systemctl', ['--user', 'restart', GATEWAY_UNIT], { env: XDG_ENV });
  if (r.ok) { ocFailures.status = undefined; delete ocFailures.status; }
  res.json(r);
});

app.post('/api/actions/free-ram', express.json(), async (req, res) => {
  const before = sysCache?.memAvailGB ?? null;
  const r = await runCmd('sudo', ['sh', '-c', 'sync; echo 1 > /proc/sys/vm/drop_caches']);
  const sys = await getSysStats();
  res.json({ ...r, beforeGB: before, afterGB: sys.memAvailGB ?? null });
});

app.post('/api/actions/reboot', express.json(), async (req, res) => {
  if (req.body?.password !== OC_KEY) return res.status(403).json({ ok: false, error: 'Clave incorrecta' });
  res.json({ ok: true, message: 'Reiniciando el servidor…' });
  setTimeout(() => execFile('sudo', ['reboot'], () => {}), 1500);
});

app.post('/api/actions/shutdown', express.json(), async (req, res) => {
  if (req.body?.password !== OC_KEY) return res.status(403).json({ ok: false, error: 'Clave incorrecta' });
  const hours = Math.min(24, Math.max(1, Number(req.body?.hours) || 1));
  const wakeAt = Math.floor(Date.now() / 1000) + hours * 3600;
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
let sysCache = null;
let pingCache = null;
let processesCache = [];
let ocStatusCache = null;
let sessionsCache = null;
let gatewayLogsCache = [];
let gatewayVersionCache = null;
let playerCache = { ok: false };
let bluetoothCache = { connected: false };
const memHistory = [];
const cpuHistory = [];

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
        cpuHistory.push(stats.cpu);
        if (cpuHistory.length > HISTORY_LEN) cpuHistory.shift();
        memHistory.push(memUsedPct);
        if (memHistory.length > HISTORY_LEN) memHistory.shift();
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
let ivFast = null, ivProcs = null, ivGateway = null, ivGatewayLogs = null, ivSessions = null, ivPing = null, ivBluetooth = null;

function startPolling() {
    if (ivFast) return;
    ivFast = setInterval(async () => {
        const sys = await getSysStats();
        const player = await getPlayerStatus();
        playerCache = player;
        io.emit('stats', { sys, memHistory, cpuHistory, player });
    }, 2000);
    ivProcs = setInterval(async () => {
        const processes = await getTopProcesses();
        io.emit('stats', { processes });
    }, 5000);
    ivGateway = setInterval(pollGateway, 8000);
    ivGatewayLogs = setInterval(pollGatewayLogs, 20000);
    ivSessions = setInterval(pollSessions, 90000);
    ivPing = setInterval(pollPing, 10000);
    ivBluetooth = setInterval(async () => {
        bluetoothCache = await getBluetoothInfo();
        io.emit('stats', { bluetooth: bluetoothCache });
    }, 20000);
    getSysStats().then(sys => io.emit('stats', { sys, memHistory, cpuHistory }));
    getTopProcesses().then(processes => io.emit('stats', { processes }));
    getPlayerStatus().then(player => { playerCache = player; io.emit('stats', { player }); });
    getBluetoothInfo().then(bt => { bluetoothCache = bt; io.emit('stats', { bluetooth: bt }); });
    pollGateway();
    pollGatewayLogs();
    pollSessions();
    pollPing();
}

function stopPolling() {
    clearInterval(ivFast); clearInterval(ivProcs); clearInterval(ivGateway);
    clearInterval(ivGatewayLogs); clearInterval(ivSessions); clearInterval(ivPing);
    clearInterval(ivBluetooth);
    ivFast = ivProcs = ivGateway = ivGatewayLogs = ivSessions = ivPing = ivBluetooth = null;
}

io.on('connection', (socket) => {
  clientCount++;
  if (clientCount === 1) startPolling();

  socket.emit('stats', {
      sys: sysCache || {},
      memHistory, cpuHistory,
      processes: processesCache,
      oc: buildOCPayload(),
      models: getModels(),
      ping: pingCache,
      gatewayLogs: gatewayLogsCache,
      player: playerCache,
      bluetooth: bluetoothCache,
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
