// extras.js — Funcionalidades extendidas del NexoDashboard (backend).
//
// index.js llama a registerRoutes(app) DESPUÉS de app.use(requireDashAuth),
// así que todos los endpoints aquí quedan protegidos por la sesión.
// pollFast()/pollSlow() los llama el loop de sondeo de index.js y snapshot()
// se mezcla en el payload 'stats' (solo AGREGA claves, nunca renombra).
//
// Regla de degradación: si un binario o servicio no existe en el equipo, la
// fuente responde { available: false, reason: "..." } y nunca rompe el server.
// Toda ejecución de comandos usa execFile con argumentos fijos (nunca exec ni
// shell) y timeouts explícitos — el host de producción es modesto (AMD E-300).

const express = require('express');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const si = require('systeminformation');

const DATA_DIR = path.join(__dirname, 'data');
const LINKS_PATH = path.join(DATA_DIR, 'links.json');
const CHECKS_PATH = path.join(DATA_DIR, 'checks.json');
const SAMPLES_PATH = path.join(DATA_DIR, 'samples.jsonl');

// ===== Utilidades =====

function runCmd(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), error: err?.message || null });
    });
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function isMissingBinary(result) {
  return !result.ok && /ENOENT|not found|command not found/i.test(result.error || result.stderr || '');
}

// ===== 1. I/O de disco + tráfico de red (tasas + mini-historial) =====
// fsStats da bytes/s (rx_sec/wx_sec) y disksIO da IOPS (rIO_sec/wIO_sec).
// networkStats da rx_sec/tx_sec por interfaz desde la llamada anterior.

const HIST_LEN = 30;
const netHist = [];   // { t, rx, tx } en KB/s
const diskHist = [];  // { t, r, w } en KB/s
let ioCache = null;

async function pollFast(sys) {
  let io = ioCache;
  try {
    const [netStats, fsS, dio] = await Promise.all([
      si.networkStats(),
      si.fsStats(),
      si.disksIO(),
    ]);
    const ifaces = (netStats || [])
      .filter((n) => n.iface && n.iface !== 'lo')
      .map((n) => ({
        iface: n.iface,
        rxKBs: Number(((n.rx_sec || 0) / 1024).toFixed(1)),
        txKBs: Number(((n.tx_sec || 0) / 1024).toFixed(1)),
      }));
    const rxKBs = Number(ifaces.reduce((a, n) => a + n.rxKBs, 0).toFixed(1));
    const txKBs = Number(ifaces.reduce((a, n) => a + n.txKBs, 0).toFixed(1));
    const rKBs = Number(((fsS.rx_sec || 0) / 1024).toFixed(1));
    const wKBs = Number(((fsS.wx_sec || 0) / 1024).toFixed(1));
    const now = Date.now();
    netHist.push({ t: now, rx: rxKBs, tx: txKBs });
    if (netHist.length > HIST_LEN) netHist.shift();
    diskHist.push({ t: now, r: rKBs, w: wKBs });
    if (diskHist.length > HIST_LEN) diskHist.shift();
    io = {
      net: { rxKBs, txKBs, ifaces, hist: [...netHist] },
      disk: {
        readKBs: rKBs,
        writeKBs: wKBs,
        readIOPS: Math.round(dio.rIO_sec || 0),
        writeIOPS: Math.round(dio.wIO_sec || 0),
        hist: [...diskHist],
      },
    };
    ioCache = io;
  } catch {
    // se conserva el último ioCache bueno
  }
  const alerts = evalAlerts(sys);
  alertsCache = alerts;
  return { io, alerts };
}

// ===== 6. Alertas por umbral =====

const THRESHOLDS = {
  cpu: { warn: 85, crit: 95 },
  mem: { warn: 85, crit: 95 },
  disk: { warn: 85, crit: 95 },
  temp: { warn: 75, crit: 85 },
};

function alertFor(key, value, label, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const t = THRESHOLDS[key];
  if (value >= t.crit) return { level: 'crit', key, msg: `${label} crítica: ${value}${unit}` };
  if (value >= t.warn) return { level: 'warn', key, msg: `${label} alta: ${value}${unit}` };
  return null;
}

function evalAlerts(sys) {
  if (!sys) return [];
  return [
    alertFor('cpu', sys.cpu, 'CPU', '%'),
    alertFor('mem', sys.memUsed, 'RAM', '%'),
    alertFor('disk', sys.diskUsedPct, 'Disco', '%'),
    alertFor('temp', sys.cpuTemp, 'Temperatura', '°C'),
  ].filter(Boolean);
}

let alertsCache = [];

// ===== 2. Contenedores Docker =====

let dockerCache = { available: false, reason: 'sin datos todavía' };

async function getDocker() {
  const r = await runCmd('docker', ['ps', '--format', '{{json .}}'], 8000);
  if (!r.ok) {
    dockerCache = isMissingBinary(r)
      ? { available: false, reason: 'docker no está instalado en este equipo' }
      : { available: false, reason: `docker falló: ${r.error || r.stderr || 'desconocido'}` };
    return dockerCache;
  }
  const containers = r.stdout.split('\n').filter(Boolean).map((line) => {
    try {
      const c = JSON.parse(line);
      return { name: c.Names || '?', image: c.Image || '?', state: c.State || '?', status: c.Status || '' };
    } catch {
      return null;
    }
  }).filter(Boolean);
  dockerCache = { available: true, count: containers.length, containers };
  return dockerCache;
}

// ===== 3. Servicios systemd (estado + uptime) =====

const SERVICES = [
  { key: 'nexodashboard', unit: 'nexodashboard.service', user: false },
  { key: 'openclaw', unit: 'openclaw-gateway.service', user: true },
  { key: 'cloudflared', unit: 'cloudflared.service', user: false },
  { key: 'postgresql', unit: 'postgresql.service', user: false },
  { key: 'nginx', unit: 'nginx.service', user: false },
];
const XDG_ENV = { ...process.env, XDG_RUNTIME_DIR: '/run/user/1000' };

function getServiceState(svc) {
  return new Promise((resolve) => {
    const args = [
      ...(svc.user ? ['--user'] : []),
      'show', svc.unit, '--no-page',
      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState',
      '-p', 'MainPID', '-p', 'ActiveEnterTimestamp', '-p', 'MemoryCurrent',
    ];
    execFile('systemctl', args, { timeout: 5000, env: XDG_ENV }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({ key: svc.key, unit: svc.unit, state: 'unknown', reason: 'systemctl no respondió' });
      }
      const out = {};
      stdout.split('\n').forEach((line) => {
        const idx = line.indexOf('=');
        if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
      });
      if (out.LoadState === 'not-found') {
        return resolve({ key: svc.key, unit: svc.unit, state: 'not-found', reason: 'unidad no instalada' });
      }
      let uptimeSec = null;
      if (out.ActiveEnterTimestamp) {
        const ts = Date.parse(out.ActiveEnterTimestamp);
        if (!Number.isNaN(ts)) uptimeSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
      }
      resolve({
        key: svc.key,
        unit: svc.unit,
        state: out.ActiveState || 'unknown',
        subState: out.SubState || null,
        pid: out.MainPID && out.MainPID !== '0' ? Number(out.MainPID) : null,
        uptimeSec,
        memMB: out.MemoryCurrent && out.MemoryCurrent !== '[not set]' ? Math.round(Number(out.MemoryCurrent) / 1048576) : null,
      });
    });
  });
}

let servicesCache = [];

async function getServices() {
  try {
    servicesCache = await Promise.all(SERVICES.map(getServiceState));
  } catch {
    // se conserva el último bueno
  }
  return servicesCache;
}

// ===== 4. Salud de disco (SMART) — caché larga, cambia poco =====

let smartCache = { available: false, reason: 'sin datos todavía' };
let smartCacheAt = 0;
const SMART_TTL_MS = 10 * 60 * 1000;

async function getSmart(force = false) {
  if (!force && Date.now() - smartCacheAt < SMART_TTL_MS) return smartCache;
  const scan = await runCmd('smartctl', ['--scan-open', '-j'], 10000);
  if (!scan.ok) {
    smartCache = isMissingBinary(scan)
      ? { available: false, reason: 'smartctl no está instalado en este equipo' }
      : { available: false, reason: `smartctl falló: ${scan.error || scan.stderr || 'desconocido'}` };
    smartCacheAt = Date.now();
    return smartCache;
  }
  let devices = [];
  try {
    devices = (JSON.parse(scan.stdout).devices || []).map((d) => d.name).filter(Boolean);
  } catch {
    smartCache = { available: false, reason: 'salida de smartctl ilegible' };
    smartCacheAt = Date.now();
    return smartCache;
  }
  if (!devices.length) {
    smartCache = { available: true, devices: [], note: 'sin discos detectados' };
    smartCacheAt = Date.now();
    return smartCache;
  }
  const infos = await Promise.all(devices.slice(0, 8).map(async (dev) => {
    const r = await runCmd('smartctl', ['-H', '-A', '-j', dev], 10000);
    if (!r.ok) return { device: dev, health: 'unknown', reason: r.error || 'sin permiso de lectura' };
    try {
      const j = JSON.parse(r.stdout);
      const passed = j.smart_status?.passed;
      let temp = j.temperature?.current ?? null;
      if (temp === null && Array.isArray(j.ata_smart_attributes?.table)) {
        const t = j.ata_smart_attributes.table.find((a) => a.id === 194 || a.id === 190);
        temp = t ? t.raw?.value ?? t.value ?? null : null;
      }
      return {
        device: dev,
        model: j.model_name || j.device?.model_name || null,
        health: passed === true ? 'passed' : passed === false ? 'failed' : 'unknown',
        temp: typeof temp === 'number' ? temp : null,
      };
    } catch {
      return { device: dev, health: 'unknown' };
    }
  }));
  smartCache = { available: true, devices: infos };
  smartCacheAt = Date.now();
  return smartCache;
}

// ===== 5. Historial persistente (muestras 60 s → series 24h/7d + CSV) =====
// Solo se muestrea si el archivo es escribible; el intervalo corre siempre
// (una muestra por minuto es despreciable incluso en el E-300).

const SAMPLE_EVERY_MS = 60 * 1000;
const MAX_SAMPLE_LINES = 11000; // ~7.6 días a 1 muestra/min

function appendSample(sample) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(SAMPLES_PATH, JSON.stringify(sample) + '\n');
  } catch {
    // disco lleno o sin permiso: el monitoreo en vivo sigue funcionando
  }
}

function readSamples() {
  let text = '';
  try {
    text = fs.readFileSync(SAMPLES_PATH, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((s) => s && typeof s.t === 'number');
}

function compactSamplesIfNeeded() {
  try {
    const lines = fs.readFileSync(SAMPLES_PATH, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_SAMPLE_LINES + 1000) {
      fs.writeFileSync(SAMPLES_PATH, lines.slice(-MAX_SAMPLE_LINES).join('\n') + '\n');
    }
  } catch {
    // si no hay archivo, nada que compactar
  }
}

async function takeSample() {
  try {
    const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
    const memUsed = Number(((mem.active / mem.total) * 100).toFixed(1));
    appendSample({ t: Date.now(), cpu: Number(cpu.currentLoad.toFixed(1)), ram: memUsed });
  } catch {
    // sin muestra esta vez
  }
}

function downsample(samples, bucketMs, maxPoints) {
  if (!samples.length) return [];
  const buckets = new Map();
  for (const s of samples) {
    const b = Math.floor(s.t / bucketMs);
    const acc = buckets.get(b) || { t: b * bucketMs, cpu: 0, ram: 0, n: 0 };
    acc.cpu += s.cpu || 0;
    acc.ram += s.ram || 0;
    acc.n++;
    buckets.set(b, acc);
  }
  return [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .slice(-maxPoints)
    .map((b) => ({ t: b.t, cpu: Number((b.cpu / b.n).toFixed(1)), ram: Number((b.ram / b.n).toFixed(1)) }));
}

function getHistorySeries(range) {
  const now = Date.now();
  const windowMs = range === '7d' ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
  const samples = readSamples().filter((s) => now - s.t <= windowMs);
  const bucketMs = range === '7d' ? 30 * 60 * 1000 : 5 * 60 * 1000;
  return { range: range === '7d' ? '7d' : '24h', points: downsample(samples, bucketMs, 400), samples: samples.length };
}

function historyToCsv() {
  const samples = readSamples();
  const rows = ['timestamp,cpu_pct,ram_pct'];
  for (const s of samples) {
    rows.push(`${new Date(s.t).toISOString()},${s.cpu ?? ''},${s.ram ?? ''}`);
  }
  return rows.join('\n') + '\n';
}

// ===== 7. Gestor de procesos: listar + terminar con salvaguardas =====

const BLOCKED_NAMES = new Set([
  'systemd', 'init', 'sshd', 'sudo', 'dbus-daemon', 'dbus-broker',
  'systemd-journald', 'systemd-logind', 'systemd-udevd',
  'reboot', 'shutdown', 'poweroff', 'halt',
]);

function isProtectedProcess(p) {
  if (!p) return true;
  if (p.pid <= 1 || p.pid === process.pid) return true;
  if (BLOCKED_NAMES.has(p.name)) return true;
  const params = `${p.params || ''} ${p.path || ''}`;
  if (/nexodash(board)?|index\.js/.test(params) && p.name === 'node') return true;
  return false;
}

async function listProcesses({ sort = 'cpu', order = 'desc', q = '', limit = 25 } = {}) {
  const data = await si.processes();
  const needle = String(q || '').toLowerCase();
  let list = (data.list || []).map((p) => ({
    pid: p.pid,
    name: p.name,
    cpu: Number((p.cpu || 0).toFixed(1)),
    memPct: Number((p.mem || 0).toFixed(1)),
    memRssMB: Math.round((p.memRss || 0) / 1024),
    cmd: String(p.params || '').slice(0, 120),
    protected: isProtectedProcess(p),
  }));
  if (needle) {
    list = list.filter((p) => p.name.toLowerCase().includes(needle) || p.cmd.toLowerCase().includes(needle));
  }
  const key = sort === 'mem' ? 'memPct' : 'cpu';
  list.sort((a, b) => (order === 'asc' ? a[key] - b[key] : b[key] - a[key]));
  const n = Math.min(100, Math.max(1, Number(limit) || 25));
  return { total: list.length, processes: list.slice(0, n) };
}

async function killProcess(pid, confirm) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { status: 400, body: { ok: false, error: 'PID inválido' } };
  }
  let target = null;
  try {
    const data = await si.processes();
    target = (data.list || []).find((p) => p.pid === pid) || null;
  } catch {
    return { status: 503, body: { ok: false, error: 'no se pudo leer la lista de procesos' } };
  }
  if (!target) return { status: 404, body: { ok: false, error: `no existe el PID ${pid}` } };
  const info = { pid: target.pid, name: target.name, cpu: target.cpu, memRssMB: Math.round((target.memRss || 0) / 1024) };
  if (isProtectedProcess(target)) {
    return { status: 403, body: { ok: false, error: 'proceso protegido por el sistema, no se puede terminar', process: info } };
  }
  if (confirm !== true) {
    return { status: 400, body: { ok: false, needConfirm: true, error: 'falta confirmación', process: info } };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { status: 500, body: { ok: false, error: `no se pudo terminar: ${e.message}`, process: info } };
  }
  return { status: 200, body: { ok: true, signal: 'SIGTERM', process: info } };
}

// ===== 8. Visor de logs (allowlist de unidades journal) =====

const LOG_UNITS = {
  nexodashboard: { unit: 'nexodashboard.service', user: false },
  openclaw: { unit: 'openclaw-gateway.service', user: true },
  cloudflared: { unit: 'cloudflared.service', user: false },
  nginx: { unit: 'nginx.service', user: false },
  postgresql: { unit: 'postgresql.service', user: false },
};

async function tailLogs(key, n) {
  const entry = LOG_UNITS[key];
  if (!entry) {
    return { status: 400, body: { ok: false, error: `unidad no permitida (usa: ${Object.keys(LOG_UNITS).join(', ')})` } };
  }
  const lines = Math.min(500, Math.max(10, Number(n) || 100));
  const args = [
    ...(entry.user ? ['--user'] : []),
    '-u', entry.unit, '-n', String(lines), '--no-pager', '-o', 'cat',
  ];
  const r = await runCmd('journalctl', args, 8000);
  if (!r.ok) {
    if (isMissingBinary(r)) {
      return { status: 503, body: { ok: false, error: 'journalctl no disponible en este equipo' } };
    }
    return { status: 200, body: { ok: true, unit: key, lines: [], note: r.error || 'sin registros accesibles' } };
  }
  return { status: 200, body: { ok: true, unit: key, lines: r.stdout.split('\n').filter(Boolean) } };
}

// ===== 9. Uptime/checks HTTP periódicos =====

let checksConfig = [];
let checksCache = [];

function loadChecksConfig() {
  const raw = readJson(CHECKS_PATH, null);
  if (Array.isArray(raw)) {
    checksConfig = raw.filter((c) => c && typeof c.url === 'string');
  } else {
    checksConfig = [{ id: 'corposoft', url: 'https://corposoft.net' }];
    try {
      writeJson(CHECKS_PATH, checksConfig);
    } catch {
      // arranca igual con la config en memoria
    }
  }
}

function fetchUrl(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lib;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return resolve({ ok: false, status: null, ms: null, error: 'solo http(s)' });
      }
      lib = u.protocol === 'https:' ? https : http;
    } catch {
      return resolve({ ok: false, status: null, ms: null, error: 'URL inválida' });
    }
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, ms: Date.now() - start }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, ms: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: null, ms: null, error: e.message }));
  });
}

async function runChecks() {
  const results = await Promise.all(checksConfig.map(async (c) => {
    const r = await fetchUrl(c.url);
    return { id: c.id, url: c.url, ...r, at: Date.now() };
  }));
  checksCache = results;
  return results;
}

function addCheck(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { status: 400, body: { ok: false, error: 'URL inválida' } };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { status: 400, body: { ok: false, error: 'solo se permiten URLs http(s)' } };
  }
  if (checksConfig.some((c) => c.url === u.href)) {
    return { status: 409, body: { ok: false, error: 'esa URL ya está en la lista' } };
  }
  const entry = { id: crypto.randomBytes(4).toString('hex'), url: u.href };
  checksConfig.push(entry);
  try {
    writeJson(CHECKS_PATH, checksConfig);
  } catch {
    return { status: 500, body: { ok: false, error: 'no se pudo guardar la configuración' } };
  }
  fetchUrl(entry.url).then((r) => {
    checksCache.push({ ...entry, ...r, at: Date.now() });
  });
  return { status: 200, body: { ok: true, check: entry } };
}

function removeCheck(id) {
  const idx = checksConfig.findIndex((c) => c.id === id);
  if (idx === -1) return { status: 404, body: { ok: false, error: 'check no encontrado' } };
  const [removed] = checksConfig.splice(idx, 1);
  checksCache = checksCache.filter((c) => c.id !== id);
  try {
    writeJson(CHECKS_PATH, checksConfig);
  } catch {
    return { status: 500, body: { ok: false, error: 'no se pudo guardar la configuración' } };
  }
  return { status: 200, body: { ok: true, removed } };
}

// ===== 10. Quick links configurables (persistidos en disco) =====

let linksCache = [];

function loadLinks() {
  const raw = readJson(LINKS_PATH, null);
  linksCache = Array.isArray(raw) ? raw.filter((l) => l && l.label && l.url) : [];
}

function saveLinks() {
  writeJson(LINKS_PATH, linksCache);
}

function validateLink(label, url) {
  if (typeof label !== 'string' || !label.trim() || label.length > 60) {
    return 'el nombre debe tener entre 1 y 60 caracteres';
  }
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return 'URL inválida';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'solo se permiten URLs http(s)';
  if (String(url).length > 500) return 'URL demasiado larga';
  return null;
}

// ===== Ciclo de vida =====

function boot() {
  loadLinks();
  loadChecksConfig();
  compactSamplesIfNeeded();
  takeSample();
  runChecks();
  setInterval(takeSample, SAMPLE_EVERY_MS);
  setInterval(runChecks, 60 * 1000);
}

async function pollSlow() {
  const [docker, services, smart] = await Promise.all([
    getDocker(),
    getServices(),
    getSmart(),
  ]);
  return { docker, services, smart, checks: checksCache, links: linksCache };
}

function snapshot() {
  return {
    io: ioCache,
    docker: dockerCache,
    services: servicesCache,
    smart: smartCache,
    alerts: alertsCache,
    checks: checksCache,
    links: linksCache,
  };
}

// ===== Rutas (protegidas por requireDashAuth desde index.js) =====

function registerRoutes(app) {
  const json = () => express.json();

  app.get('/api/io', async (req, res) => {
    const { io } = await pollFast(null);
    res.json({ ok: true, io });
  });

  app.get('/api/docker', async (req, res) => {
    res.json({ ok: true, ...(await getDocker()) });
  });

  app.get('/api/services', async (req, res) => {
    res.json({ ok: true, services: await getServices() });
  });

  app.get('/api/smart', async (req, res) => {
    res.json({ ok: true, ...(await getSmart(true)) });
  });

  app.get('/api/history', (req, res) => {
    const range = req.query.range === '7d' ? '7d' : '24h';
    res.json({ ok: true, ...getHistorySeries(range) });
  });

  app.get('/api/history/export', (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="nexodashboard-history.csv"');
    res.send(historyToCsv());
  });

  app.get('/api/processes', async (req, res) => {
    try {
      const { sort, order, q, limit } = req.query;
      res.json({ ok: true, ...(await listProcesses({ sort, order, q, limit })) });
    } catch {
      res.status(503).json({ ok: false, error: 'no se pudo leer la lista de procesos' });
    }
  });

  app.post('/api/processes/kill', json(), async (req, res) => {
    const { status, body } = await killProcess(Number(req.body?.pid), req.body?.confirm);
    res.status(status).json(body);
  });

  app.get('/api/logs', async (req, res) => {
    const { status, body } = await tailLogs(req.query.unit, req.query.n);
    res.status(status).json(body);
  });

  app.get('/api/checks', (req, res) => {
    res.json({ ok: true, checks: checksCache });
  });

  app.post('/api/checks', json(), (req, res) => {
    const { status, body } = addCheck(req.body?.url);
    res.status(status).json(body);
  });

  app.delete('/api/checks/:id', (req, res) => {
    const { status, body } = removeCheck(req.params.id);
    res.status(status).json(body);
  });

  app.get('/api/links', (req, res) => {
    res.json({ ok: true, links: linksCache });
  });

  app.post('/api/links', json(), (req, res) => {
    const err = validateLink(req.body?.label, req.body?.url);
    if (err) return res.status(400).json({ ok: false, error: err });
    const link = { id: crypto.randomBytes(4).toString('hex'), label: req.body.label.trim(), url: String(req.body.url) };
    linksCache.push(link);
    try {
      saveLinks();
    } catch {
      linksCache.pop();
      return res.status(500).json({ ok: false, error: 'no se pudo guardar' });
    }
    res.json({ ok: true, link });
  });

  app.put('/api/links/:id', json(), (req, res) => {
    const link = linksCache.find((l) => l.id === req.params.id);
    if (!link) return res.status(404).json({ ok: false, error: 'enlace no encontrado' });
    const err = validateLink(req.body?.label, req.body?.url);
    if (err) return res.status(400).json({ ok: false, error: err });
    link.label = req.body.label.trim();
    link.url = String(req.body.url);
    try {
      saveLinks();
    } catch {
      return res.status(500).json({ ok: false, error: 'no se pudo guardar' });
    }
    res.json({ ok: true, link });
  });

  app.delete('/api/links/:id', (req, res) => {
    const idx = linksCache.findIndex((l) => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'enlace no encontrado' });
    const [removed] = linksCache.splice(idx, 1);
    try {
      saveLinks();
    } catch {
      linksCache.splice(idx, 0, removed);
      return res.status(500).json({ ok: false, error: 'no se pudo guardar' });
    }
    res.json({ ok: true, removed });
  });
}

module.exports = { registerRoutes, boot, pollFast, pollSlow, snapshot };
