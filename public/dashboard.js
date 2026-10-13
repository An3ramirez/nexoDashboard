/* NexoDashboard v2 — núcleo: tema, socket.io, gráficas SVG propias,
 * reproductor MPD, visitantes con dominio, acciones, modales, toasts.
 * panels.js (cargado después) añade Docker/servicios/SMART/procesos/logs/checks/links.
 */
'use strict';

const q = (s) => document.querySelector(`[data-value="${s}"]`);
// Escapa antes de interpolar en innerHTML. Los datos vienen de procesos,
// sesiones y del User-Agent/IP/host de los visitantes — el UA y el Host los
// controla quien visita, así que sin esto una petición maliciosa se ejecuta aquí.
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  sys: {}, oc: {}, models: {}, ping: null,
  processes: [], gatewayLogs: [], player: {}, bluetooth: {},
  history: { short: [], daily: [] }, range: 'short',
  histRange: '24h', histData: null,
  io: null, alerts: [], docker: null, services: [], smart: null,
  checks: [], links: [],
  procQuery: '',
};
let lastArtKey = null;

/* ══════════ Tema claro/oscuro (persistente) ══════════ */
const THEME_KEY = 'nexo-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const light = t === 'light';
  document.getElementById('themeIconSun').classList.toggle('hidden', light);
  document.getElementById('themeIconMoon').classList.toggle('hidden', !light);
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  drawAllCharts();
}
function initTheme() {
  let t = 'dark';
  try { t = localStorage.getItem(THEME_KEY) || 'dark'; } catch {}
  if (t !== 'light' && t !== 'dark') t = 'dark';
  document.documentElement.dataset.theme = t;
  const light = t === 'light';
  document.getElementById('themeIconSun').classList.toggle('hidden', light);
  document.getElementById('themeIconMoon').classList.toggle('hidden', !light);
}
document.getElementById('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  toast('Tema ' + (document.documentElement.dataset.theme === 'light' ? 'claro' : 'oscuro') + ' activado', 'info');
});

/* ══════════ Toasts ══════════ */
const TOAST_ICONS = {
  ok: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  err: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
};
function toast(msg, kind) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'info');
  el.innerHTML = `<span class="t-ic">${TOAST_ICONS[kind] || TOAST_ICONS.info}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
  while (box.children.length > 4) box.firstChild.remove();
}

/* ══════════ Formato ══════════ */
function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  return m + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
}
function fmtBytes(b) {
  if (b == null) return '?';
  return b > 1e9 ? (b / 1e9).toFixed(1) + 'G' : b > 1e6 ? (b / 1e6).toFixed(1) + 'M' : b > 1e3 ? (b / 1e3).toFixed(0) + 'K' : Math.round(b) + 'B';
}
function fmtUptime(sec) {
  if (sec == null) return '--';
  const d = Math.floor(sec / 86400);
  sec %= 86400;
  return d + 'd ' + Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}
function fmtClock(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// good / warning / critical — paleta de estado fija, nunca como color categórico
function statusLevel(value, warnAt, critAt) {
  if (value == null) return 'good';
  return value >= critAt ? 'critical' : value >= warnAt ? 'warning' : 'good';
}
const STATUS_CSS = { good: 'var(--status-good)', warning: 'var(--status-warning)', critical: 'var(--status-critical)' };
function applyStatus(key, value, warnAt, critAt) {
  const el = document.querySelector(`[data-color="${key}"]`);
  if (!el) return;
  el.classList.remove('status-good', 'status-warning', 'status-critical');
  el.classList.add(`status-${statusLevel(value, warnAt, critAt)}`);
}
function setUsageBar(id, value, warnAt, critAt, baseColor) {
  const el = document.getElementById(id);
  if (!el || value == null) return;
  el.style.width = Math.min(value, 100) + '%';
  el.style.background = STATUS_CSS[statusLevel(value, warnAt, critAt)] || baseColor;
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ══════════ Gráficas SVG propias ══════════
 * Líneas de 2px, puntos ≥4px, grid recesiva, tooltip con crosshair.
 * Leyenda obligatoria con ≥2 series (en el HTML) + etiquetas directas.
 * Colores por entidad fija (CPU siempre azul, RAM siempre ámbar…), nunca por rango.
 */
function chartSurface() { return document.documentElement.dataset.theme === 'light' ? '#ffffff' : '#1a1917'; }

function drawLineChart(svg, opts) {
  // opts: { series: [{values:[{t,v}], color, label, fmt}], ymin, ymax, yLabel }
  if (!svg) return;
  const W = 600, H = 200, PL = 34, PR = 8, PT = 10, PB = 22;
  const iw = W - PL - PR, ih = H - PT - PB;
  const all = opts.series.flatMap((s) => s.values.map((p) => p.v)).filter((v) => v != null);
  let ymin = opts.ymin != null ? opts.ymin : Math.min(0, ...all);
  let ymax = opts.ymax != null ? opts.ymax : Math.max(...all, 1);
  if (ymax - ymin < 1e-6) ymax = ymin + 1;
  const NS = 'http://www.w3.org/2000/svg';
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const X = (t) => {
    const ts = opts.series.flatMap((s) => s.values.map((p) => p.t));
    const lo = Math.min(...ts), hi = Math.max(...ts);
    return hi <= lo ? PL : PL + ((t - lo) / (hi - lo)) * iw;
  };
  const Y = (v) => PT + (1 - (v - ymin) / (ymax - ymin)) * ih;
  // Grid + etiquetas Y
  const grid = document.createElementNS(NS, 'g');
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = ymin + ((ymax - ymin) * i) / steps;
    const y = Y(v);
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', PL); ln.setAttribute('x2', W - PR);
    ln.setAttribute('y1', y); ln.setAttribute('y2', y);
    ln.setAttribute('class', 'chart-grid');
    grid.appendChild(ln);
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('x', PL - 6); tx.setAttribute('y', y + 3);
    tx.setAttribute('text-anchor', 'end'); tx.setAttribute('class', 'chart-axis');
    tx.textContent = (opts.yLabel || ((n) => n))(v);
    grid.appendChild(tx);
  }
  svg.appendChild(grid);
  // Etiquetas X (primera / última hora)
  const ts = opts.series.flatMap((s) => s.values.map((p) => p.t));
  if (ts.length) {
    const lo = Math.min(...ts), hi = Math.max(...ts);
    [[lo, 'start'], [hi, 'end']].forEach(([t, anchor]) => {
      const tx = document.createElementNS(NS, 'text');
      tx.setAttribute('x', anchor === 'start' ? PL : W - PR);
      tx.setAttribute('y', H - 6); tx.setAttribute('text-anchor', anchor);
      tx.setAttribute('class', 'chart-axis');
      tx.textContent = fmtClock(t);
      svg.appendChild(tx);
    });
  }
  // Series: área sutil + línea 2px + punto final
  opts.series.forEach((s) => {
    const pts = s.values.filter((p) => p.v != null);
    if (pts.length < 2) return;
    const line = pts.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    const area = document.createElementNS(NS, 'polygon');
    area.setAttribute('points', `${X(pts[0].t).toFixed(1)},${Y(ymin).toFixed(1)} ${line} ${X(pts[pts.length - 1].t).toFixed(1)},${Y(ymin).toFixed(1)}`);
    area.setAttribute('fill', s.color); area.setAttribute('opacity', '0.13');
    svg.appendChild(area);
    const pl = document.createElementNS(NS, 'polyline');
    pl.setAttribute('points', line); pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', s.color); pl.setAttribute('stroke-width', '2');
    pl.setAttribute('stroke-linecap', 'round'); pl.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pl);
    const last = pts[pts.length - 1];
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', X(last.t)); dot.setAttribute('cy', Y(last.v));
    dot.setAttribute('r', '4'); dot.setAttribute('fill', s.color);
    dot.setAttribute('stroke', chartSurface()); dot.setAttribute('stroke-width', '2');
    svg.appendChild(dot);
  });
  // Crosshair + tooltip
  const cross = document.createElementNS(NS, 'line');
  cross.setAttribute('y1', PT); cross.setAttribute('y2', H - PB);
  cross.setAttribute('class', 'chart-cross'); cross.style.display = 'none';
  svg.appendChild(cross);
  const tip = document.querySelector(`[data-tip="${svg.dataset.chart}"]`);
  svg.onmousemove = (ev) => {
    const r = svg.getBoundingClientRect();
    const fx = PL + (((ev.clientX - r.left) / r.width) * W - PL);
    let best = null, bestD = 1e9;
    opts.series.forEach((s) => s.values.forEach((p) => { const d = Math.abs(X(p.t) - fx); if (d < bestD) { bestD = d; best = p; } }));
    if (!best || !tip) return;
    cross.style.display = '';
    cross.setAttribute('x1', X(best.t)); cross.setAttribute('x2', X(best.t));
    tip.style.display = 'block';
    tip.innerHTML = `<span class="tt">${fmtClock(best.t)}</span><br>` + opts.series.map((s) => {
      const p = s.values.reduce((a, b) => (Math.abs(b.t - best.t) < Math.abs(a.t - best.t) ? b : a));
      return `<span style="color:${s.color}">●</span> ${esc(s.label)} <b>${esc(s.fmt ? s.fmt(p.v) : p.v)}</b>`;
    }).join('<br>');
    const wrap = svg.parentElement.getBoundingClientRect();
    let lx = ev.clientX - wrap.left + 14, ly = ev.clientY - wrap.top - 10;
    lx = Math.min(lx, wrap.width - 150);
    tip.style.left = Math.max(4, lx) + 'px';
    tip.style.top = Math.max(4, ly) + 'px';
  };
  svg.onmouseleave = () => { cross.style.display = 'none'; if (tip) tip.style.display = 'none'; };
}

function activeSeries() {
  const hist = state.history || {};
  const daily = hist.daily || [], short = hist.short || [];
  if (state.range === 'daily' && daily.length >= 2) return daily;
  if (short.length >= 2) return short;
  return daily;
}
function toPoints(samples, key) { return (samples || []).map((s) => ({ t: s.t, v: s[key] })); }

function drawAllCharts() {
  const series = activeSeries();
  drawLineChart(document.querySelector('[data-chart="cpu"]'), {
    series: [{ values: toPoints(series, 'cpu'), color: cssVar('--s-cpu'), label: 'CPU', fmt: (v) => v.toFixed(1) + '%' }],
    ymin: 0, ymax: 100, yLabel: (v) => Math.round(v) + '%',
  });
  drawLineChart(document.querySelector('[data-chart="ram"]'), {
    series: [{ values: toPoints(series, 'ram'), color: cssVar('--s-ram'), label: 'RAM', fmt: (v) => v.toFixed(1) + '%' }],
    ymin: 0, ymax: 100, yLabel: (v) => Math.round(v) + '%',
  });
  const io = state.io || {};
  if (io.net && io.net.hist) {
    const h = io.net.hist;
    drawLineChart(document.querySelector('[data-chart="net"]'), {
      series: [
        { values: h.map((p) => ({ t: p.t, v: p.rx })), color: cssVar('--s-net-rx'), label: 'Bajada', fmt: (v) => v.toFixed(1) + ' KB/s' },
        { values: h.map((p) => ({ t: p.t, v: p.tx })), color: cssVar('--s-net-tx'), label: 'Subida', fmt: (v) => v.toFixed(1) + ' KB/s' },
      ],
      ymin: 0, yLabel: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'M' : Math.round(v)),
    });
  }
  if (io.disk && io.disk.hist) {
    const h = io.disk.hist;
    drawLineChart(document.querySelector('[data-chart="dio"]'), {
      series: [
        { values: h.map((p) => ({ t: p.t, v: p.r })), color: cssVar('--s-disk-r'), label: 'Lectura', fmt: (v) => v.toFixed(1) + ' KB/s' },
        { values: h.map((p) => ({ t: p.t, v: p.w })), color: cssVar('--s-disk-w'), label: 'Escritura', fmt: (v) => v.toFixed(1) + ' KB/s' },
      ],
      ymin: 0, yLabel: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'M' : Math.round(v)),
    });
  }
  drawHistoryChart();
  // Puntos de leyenda con el color real del tema
  const legend = { cpu: '--s-cpu', ram: '--s-ram', rx: '--s-net-rx', tx: '--s-net-tx', dr: '--s-disk-r', dw: '--s-disk-w' };
  Object.entries(legend).forEach(([k, v]) => {
    const el = document.querySelector(`[data-legend="${k}"]`);
    if (el) el.style.background = cssVar(v);
  });
}

function drawHistoryChart() {
  const svg = document.querySelector('[data-chart="history"]');
  if (!svg) return;
  const d = state.histData;
  if (!d || !d.points || d.points.length < 2) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const NS = 'http://www.w3.org/2000/svg';
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('x', 300); tx.setAttribute('y', 100);
    tx.setAttribute('text-anchor', 'middle'); tx.setAttribute('class', 'chart-axis');
    tx.textContent = 'Recopilando histórico… (una muestra por minuto)';
    svg.appendChild(tx);
    return;
  }
  drawLineChart(svg, {
    series: [
      { values: d.points.map((p) => ({ t: p.t, v: p.cpu })), color: cssVar('--s-cpu'), label: 'CPU', fmt: (v) => v.toFixed(1) + '%' },
      { values: d.points.map((p) => ({ t: p.t, v: p.ram })), color: cssVar('--s-ram'), label: 'RAM', fmt: (v) => v.toFixed(1) + '%' },
    ],
    ymin: 0, ymax: 100, yLabel: (v) => Math.round(v) + '%',
  });
  const meta = document.getElementById('histMeta');
  if (meta) meta.textContent = `${d.points.length} puntos · ${d.samples} muestras`;
}

async function loadHistory() {
  try {
    const r = await fetch(`/api/history?range=${state.histRange}`);
    const d = await r.json();
    if (d.ok) { state.histData = d; drawHistoryChart(); }
  } catch { /* el socket seguirá intentándolo en vivo */ }
}

/* ══════════ Render principal ══════════ */
function setPlayerPill(mode, text) {
  const pill = document.getElementById('playerStatePill');
  if (!pill) return;
  if (!text) { pill.classList.add('hidden'); return; }
  pill.classList.remove('hidden');
  pill.textContent = text;
  pill.className = 'pill flex-shrink-0 ' + (mode === 'play' ? 'online' : mode === 'pause' ? 'warn' : '');
  pill.style.cssText = 'font-size:10px;padding:2px 9px';
}

function render() {
  const sys = state.sys || {};
  const oc = state.oc || {};
  const player = state.player || {};
  const bt = state.bluetooth || {};

  // Hero
  if (sys.hostname) {
    document.getElementById('hostnameTag').textContent = sys.hostname;
    document.getElementById('heroHost').textContent = sys.hostname;
  }
  if (sys.osDistro) document.getElementById('heroOs').textContent = sys.osDistro;
  if (sys.uptime != null) {
    document.getElementById('heroUptime').textContent = fmtUptime(sys.uptime);
    if (q('uptime')) q('uptime').textContent = fmtUptime(sys.uptime);
  }
  if (sys.cpu != null) { q('cpuHero').textContent = sys.cpu + '%'; applyStatus('cpuHero', sys.cpu, 70, 90); }
  if (sys.memUsed != null) { q('ramHero').textContent = sys.memUsed + '%'; applyStatus('ramHero', sys.memUsed, 80, 92); }
  if (sys.diskUsedPct != null) { q('diskHero').textContent = sys.diskUsedPct + '%'; applyStatus('diskHero', sys.diskUsedPct, 85, 95); }
  if (sys.cpuTemp != null) q('tempHero').textContent = sys.cpuTemp + '°C';
  if (sys.swapUsedPct != null) { q('swapHero').textContent = sys.swapUsedPct.toFixed(1) + '%'; applyStatus('swapHero', sys.swapUsedPct, 40, 75); }
  const heroStatus = document.getElementById('heroStatus');
  heroStatus.textContent = socket.connected ? '● En línea' : '● Sin conexión';
  heroStatus.className = 'pill ' + (socket.connected ? 'online' : 'offline');
  const badge = document.getElementById('serverBadge');
  badge.textContent = socket.connected ? '● Online' : '● Offline';
  badge.className = 'pill ' + (socket.connected ? 'online' : 'offline');
  badge.style.cssText = 'width:100%;justify-content:center';

  // Salud operacional: el estado no puede quedarse verde solo porque el socket
  // sigue conectado. Prioriza las alertas críticas y muestra el siguiente paso.
  const alerts = state.alerts || [];
  const critical = alerts.filter((a) => a.level === 'crit');
  const warning = alerts.filter((a) => a.level === 'warn');
  const healthLevel = document.getElementById('healthLevel');
  const healthTitle = document.getElementById('healthTitle');
  const healthCopy = document.getElementById('healthCopy');
  if (healthLevel && healthTitle && healthCopy) {
    const level = critical.length ? 'critical' : warning.length ? 'warning' : 'good';
    healthLevel.className = 'pill ' + (level === 'critical' ? 'offline' : level === 'warning' ? 'warn' : 'online');
    healthLevel.textContent = level === 'critical' ? '● Atención inmediata' : level === 'warning' ? '● Requiere revisión' : '● Salud normal';
    healthTitle.textContent = level === 'critical' ? 'Hay métricas críticas activas' : level === 'warning' ? 'Hay métricas cerca del umbral' : 'El servidor opera dentro de sus umbrales';
    healthCopy.textContent = level === 'critical' ? `${critical.map((a) => a.msg).join(' · ')}. Revisa Rendimiento antes de ejecutar una acción.` : level === 'warning' ? warning.map((a) => a.msg).join(' · ') : 'CPU, memoria, disco, temperatura y gateway no reportan alertas.';
    q('healthCpu').textContent = sys.cpu != null ? `${sys.cpu}%` : '--';
    q('healthTemp').textContent = sys.cpuTemp != null ? `${sys.cpuTemp}°C` : '--';
    q('healthSwap').textContent = sys.swapUsedPct != null ? `${sys.swapUsedPct.toFixed(1)}% (${sys.swapUsedMB || 0}/${sys.swapTotalMB || 0} MB)` : 'N/A';
    q('healthAlerts').textContent = String(alerts.length);
  }

  // Bluetooth
  const btPill = document.getElementById('btPill');
  const btBody = document.getElementById('btBody');
  if (bt.connected) {
    btPill.textContent = '● Conectado';
    btPill.className = 'pill online';
    btPill.style.fontSize = '10px';
    const pct = bt.battery;
    btBody.innerHTML = `
      <div class="font-bold truncate" style="font-size:14px">${esc(bt.name || 'Dispositivo Bluetooth')}</div>
      ${pct != null ? `
      <div class="flex items-end justify-between mt-3">
        <div class="stat-value" style="font-size:26px">${esc(pct)}<span style="font-size:14px;color:var(--muted)">%</span></div>
        <div class="label">batería</div>
      </div>
      <div class="usage-track mt-2"><div style="width:${Math.min(pct, 100)}%;background:${STATUS_CSS[statusLevel(100 - pct, 70, 85)]}"></div></div>` : '<div class="muted mt-2" style="font-size:12px">Batería no disponible</div>'}`;
  } else {
    btPill.textContent = 'Desconectado';
    btPill.className = 'pill';
    btPill.style.fontSize = '10px';
    btBody.innerHTML = '<div class="empty-state">Sin conexión Bluetooth</div>';
  }

  // Reproductor
  if (player.ok) {
    q('playerTitle').textContent = player.title || 'Sin reproducción';
    q('playerArtist').textContent = player.artist || player.album || '--';
    q('playerElapsed').textContent = fmtTime(player.elapsed);
    q('playerDuration').textContent = fmtTime(player.duration);
    const pct = player.duration ? Math.min(100, (player.elapsed / player.duration) * 100) : 0;
    document.getElementById('playerProgress').style.width = pct + '%';
    const use = document.getElementById('playerToggleUse');
    if (use) use.setAttribute('href', player.state === 'play' ? '#i-pause' : '#i-play');
    document.getElementById('playerToggle').setAttribute('aria-label', player.state === 'play' ? 'Pausar' : 'Reproducir');
    setPlayerPill(player.state,
      player.state === 'play' ? '● Reproduciendo' :
      player.state === 'pause' ? '❚❚ En pausa' :
      player.state ? '■ Detenido' : null);
    const randomBtn = document.getElementById('playerRandom');
    const on = !!player.random;
    randomBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    randomBtn.classList.toggle('armed', on);
    randomBtn.style.background = on ? 'var(--accent)' : '';
    randomBtn.style.color = on ? '#fff' : '';
    randomBtn.style.borderColor = on ? 'var(--accent)' : '';
    if (!isVolumeGuarded()) setVolumeUI(player.volume);
    const artKey = (player.title || '') + '|' + (player.artist || '');
    if (artKey !== lastArtKey) {
      lastArtKey = artKey;
      const img = document.getElementById('playerArt');
      const icon = document.getElementById('playerIcon');
      img.onload = () => { img.style.display = 'block'; icon.style.display = 'none'; };
      img.onerror = () => { img.style.display = 'none'; icon.style.display = 'flex'; };
      img.src = '/api/player/art?t=' + Date.now();
    }
  } else {
    q('playerTitle').textContent = 'MPD no disponible';
    q('playerArtist').textContent = '--';
    setPlayerPill(null, null);
  }

  // Métricas
  if (sys.cpu != null) { q('cpu').textContent = sys.cpu + '%'; applyStatus('cpu', sys.cpu, 70, 90); }
  if (sys.cpuTemp) q('temp').textContent = sys.cpuTemp + '°C';
  if (sys.memUsed != null) {
    q('ram').textContent = sys.memUsed + '%';
    applyStatus('ram', sys.memUsed, 80, 92);
    setUsageBar('ramBar', sys.memUsed, 80, 92, 'var(--s-ram)');
  }
  if (sys.memUsedGB) q('ramUsedLabel').textContent = sys.memUsedGB + ' GB usados';
  if (sys.memTotalGB) q('ramTotalLabel').textContent = sys.memTotalGB + ' GB total';
  if (sys.diskUsedPct != null) {
    q('disk').textContent = sys.diskUsedPct + '%';
    applyStatus('disk', sys.diskUsedPct, 85, 95);
    setUsageBar('diskBar', sys.diskUsedPct, 85, 95, 'var(--s-disk-r)');
    q('diskUsedLabel').textContent = (sys.diskUsedGB || '?') + ' GB usados';
    q('diskTotalLabel').textContent = (sys.diskTotalGB || '?') + ' GB total';
  }
  if (sys.netRx != null) {
    q('netDown').textContent = fmtBytes(sys.netRx) + '/s';
    q('netUp').textContent = fmtBytes(sys.netTx) + '/s';
  }
  if (sys.osDistro) q('osDistro').textContent = sys.osDistro;
  if (sys.swapUsedPct != null) {
    q('swapLabel').textContent = `${sys.swapUsedPct.toFixed(1)}% · ${sys.swapUsedMB || 0}/${sys.swapTotalMB || 0} MB`;
    applyStatus('swap', sys.swapUsedPct, 40, 75);
  } else {
    q('swapLabel').textContent = 'N/A';
  }
  if (Array.isArray(sys.cpuCores) && sys.cpuCores.length) {
    document.getElementById('coreBars').innerHTML = sys.cpuCores.map((load, i) => {
      const level = statusLevel(load, 70, 90);
      return `<div class="core-row">
        <span class="core-name">C${i + 1}</span>
        <div class="core-bar-track"><div class="core-bar-fill" style="width:${Math.min(load, 100)}%;background:${STATUS_CSS[level]}"></div></div>
        <span class="core-pct">${Math.round(load)}%</span>
      </div>`;
    }).join('');
  }

  // I/O en vivo
  const io = state.io;
  if (io && io.net) {
    document.getElementById('ifaceList').innerHTML = (io.net.ifaces || []).slice(0, 4).map((n) => `
      <div class="flex items-center gap-2" style="font-size:11.5px">
        <span class="font-bold" style="min-width:70px">${esc(n.iface)}</span>
        <span style="color:var(--s-net-rx)">↓ ${esc(n.rxKBs)} KB/s</span>
        <span style="color:var(--s-net-tx)">↑ ${esc(n.txKBs)} KB/s</span>
      </div>`).join('') || '<div class="faint" style="font-size:11.5px">Sin interfaces</div>';
  }
  if (io && io.disk) {
    q('diskRead').textContent = fmtBytes(io.disk.readKBs * 1024) + '/s';
    q('diskWrite').textContent = fmtBytes(io.disk.writeKBs * 1024) + '/s';
    q('diskIops').textContent = (io.disk.readIOPS || 0) + (io.disk.writeIOPS || 0);
  }

  drawAllCharts();

  // Gateway
  const ok = oc.gatewayOk === true;
  q('ocStatusDot').style.background = ok ? 'var(--status-good)' : 'var(--status-critical)';
  q('ocStatusText').textContent = ok ? 'Conectado' : (oc.status || 'Desconocido');
  if (oc.pid != null) q('ocPid').textContent = oc.pid;
  if (oc.memMB != null) q('ocMem').textContent = oc.memMB + ' MB';
  if (oc.tasks != null) q('ocTasks').textContent = oc.tasks;
  if (oc.version) q('ocVersion').textContent = oc.version;
  if (oc.sessionsActive != null) q('ocSessions').textContent = oc.sessionsActive;
  if (oc.nRestarts != null) q('ocRestarts').textContent = oc.nRestarts;
  const latBadge = document.getElementById('latencyBadge');
  if (oc.healthLatencyMs != null) {
    latBadge.textContent = oc.healthLatencyMs + ' ms';
    latBadge.className = 'pill ' + (ok ? 'online' : 'offline');
  }
  if (state.models && state.models.primary) q('ocModel').textContent = state.models.primary.split('/').pop();
  if (state.ping != null) document.getElementById('pingTag').textContent = 'Ping: ' + state.ping + ' ms';

  // Sesiones
  const sList = oc.sessions || [];
  const sessionsContainer = document.getElementById('sessionsContainer');
  if (sList.length > 0) {
    let html = '<div class="overflow-x-auto"><table class="data-table">';
    html += '<thead><tr><th>Agente</th><th>Modelo</th><th>Estado</th><th>Duración</th><th class="hidden md:table-cell">Canal</th></tr></thead><tbody>';
    sList.slice(0, 8).forEach((s) => {
      const live = (s.status === 'active' || s.status === 'running');
      html += `<tr>
        <td style="color:var(--ink)">${esc(s.agentId || '?')}</td>
        <td>${esc(s.model || '?')}</td>
        <td style="${live ? 'color:var(--status-good)' : ''}">${esc(s.status || '?')}</td>
        <td>${esc(s.duration || '?')}</td>
        <td class="hidden md:table-cell">${esc(s.channel || '-')}</td>
      </tr>`;
    });
    sessionsContainer.innerHTML = html + '</tbody></table></div>';
  } else if ((state.gatewayLogs || []).length > 0) {
    const note = oc.sessionsCircuitOpen
      ? 'Lista de sesiones no disponible por ahora — actividad reciente del gateway:'
      : 'Sin sesiones activas — actividad reciente del gateway:';
    sessionsContainer.innerHTML = `<div class="faint mb-2" style="font-size:12px">${note}</div>` +
      `<div class="log-box" style="max-height:190px">${state.gatewayLogs.map((l) => esc(l)).join('\n')}</div>`;
  }

  // Top proceso (sistema)
  if ((state.processes || []).length > 0) {
    const top = state.processes[0];
    q('topProc').textContent = `${top.name} (${top.cpu}%)`;
  }

  if (window.NexoVisitors) window.NexoVisitors.render(state);
  if (window.NexoInsights) window.NexoInsights.render(state);
  renderAlerts();
  if (window.NexoPanels) window.NexoPanels.render(state);
}

/* ══════════ Visitantes (con dominio principal + subdominio) ══════════ */
function renderVisitors() {
  const vis = state.visitors || { active: [], total: 0 };
  const visActive = vis.active || [];
  const visTotal = vis.total || 0;
  q('visActive').textContent = visActive.length;
  q('visTotal').textContent = visTotal;
  q('visRequests').textContent = visActive.reduce((a, v) => a + (v.requests || 0), 0);
  const badge = document.getElementById('visitorsBadge');
  if (visActive.length > 0) {
    badge.textContent = '● ' + visActive.length + ' en línea';
    badge.className = 'pill online';
  } else {
    badge.textContent = '● Sin actividad';
    badge.className = 'pill';
  }
  const navCount = document.getElementById('navVisitorsCount');
  if (navCount) navCount.textContent = visActive.length;
  const box = document.getElementById('visitorsContainer');
  if (!visActive.length) {
    box.innerHTML = '<div class="empty-state">Sin visitantes en los últimos 5 minutos</div>';
    return;
  }
  let html = '<div class="overflow-x-auto"><table class="data-table">';
  html += '<thead><tr><th>IP</th><th>Dominio</th><th>Dispositivo</th><th class="hidden md:table-cell">Última ruta</th><th>Reqs</th><th>Estado</th></tr></thead><tbody>';
  visActive.slice(0, 12).forEach((v) => {
    const color = v.active ? 'var(--status-good)' : 'var(--status-warning)';
    const statusTxt = v.active ? '● Activo' : '○ ' + (v.idleSec > 60 ? Math.round(v.idleSec / 60) + 'm' : v.idleSec + 's');
    const domain = v.domain || 'corposoft.net';
    const sub = v.subdomain ? `<span class="sub-tag ml-1">/${esc(v.subdomain)}</span>` : '';
    html += `<tr>
      <td style="color:var(--ink)">${esc(v.ip)}</td>
      <td><span class="domain-tag">${esc(domain)}</span>${sub}<div class="faint" style="font-size:10.5px;margin-top:3px">${esc(v.host || domain)}</div></td>
      <td>${esc(v.device)}${v.browser ? ' <span class="faint">' + esc(v.browser) + '</span>' : ''}</td>
      <td class="hidden md:table-cell muted">${esc((v.lastUri || '/').slice(0, 42))}</td>
      <td>${esc(v.requests)}</td>
      <td style="color:${color};white-space:nowrap">${statusTxt}</td>
    </tr>`;
  });
  box.innerHTML = html + '</tbody></table></div>';
}

/* ══════════ Alertas por umbral ══════════ */
function renderAlerts() {
  const alerts = state.alerts || [];
  const btn = document.getElementById('alertsBtn');
  const pop = document.getElementById('alertsPop');
  btn.classList.toggle('bell-dot', alerts.length > 0);
  btn.setAttribute('aria-label', alerts.length ? `${alerts.length} alertas activas` : 'Sin alertas');
  if (!alerts.length) {
    pop.innerHTML = '<div class="empty-state">Todo dentro de umbrales normales</div>';
    return;
  }
  pop.innerHTML = alerts.map((a) => `
    <div class="alert-row ${a.level === 'crit' ? 'crit' : 'warn'}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      <span>${esc(a.msg)}</span>
    </div>`).join('');
}
document.getElementById('alertsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = document.getElementById('alertsPop');
  const open = pop.classList.toggle('hidden');
  document.getElementById('alertsBtn').setAttribute('aria-expanded', open ? 'false' : 'true');
});
document.addEventListener('click', (e) => {
  const pop = document.getElementById('alertsPop');
  if (!pop.classList.contains('hidden') && !e.target.closest('#alertsPop') && !e.target.closest('#alertsBtn')) {
    pop.classList.add('hidden');
  }
});

/* ══════════ Socket ══════════ */
const socket = io();
socket.on('connect', render);
socket.on('disconnect', render);
socket.on('stats', (data) => {
  if (data.sys) state.sys = data.sys;
  if (data.oc) state.oc = data.oc;
  if (data.models) state.models = data.models;
  if (data.ping !== undefined) state.ping = data.ping;
  if (data.processes) state.processes = data.processes;
  if (data.gatewayLogs) state.gatewayLogs = data.gatewayLogs;
  if (data.player) state.player = data.player;
  if (data.history) state.history = data.history;
  if (data.bluetooth) state.bluetooth = data.bluetooth;
  if (data.visitors) state.visitors = data.visitors;
  // Claves nuevas de extras.js (solo agregan, nunca renombran)
  if (data.io) state.io = data.io;
  if (data.alerts) state.alerts = data.alerts;
  if (data.docker) state.docker = data.docker;
  if (data.services) state.services = data.services;
  if (data.smart) state.smart = data.smart;
  if (data.checks) state.checks = data.checks;
  if (data.links) state.links = data.links;
  render();
});

/* ══════════ Rango 1h/24h + histórico ══════════ */
document.querySelectorAll('#rangeToggle .range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.range = btn.dataset.range === 'daily' ? 'daily' : 'short';
    document.querySelectorAll('#rangeToggle .range-btn').forEach((b) => b.classList.toggle('range-btn-active', b === btn));
    render();
  });
});
document.querySelector('#rangeToggle .range-btn')?.classList.add('range-btn-active');
document.querySelectorAll('.hist-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.histRange = btn.dataset.hist === '7d' ? '7d' : '24h';
    document.querySelectorAll('.hist-btn').forEach((b) => b.classList.toggle('range-btn-active', b === btn));
    loadHistory();
  });
});
document.querySelector('.hist-btn')?.classList.add('range-btn-active');

/* ══════════ Navegación (sidebar + bottomnav) ══════════ */
document.querySelectorAll('[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b === btn || (b.dataset.nav === btn.dataset.nav && b.tagName === 'BUTTON' && b.closest('.bottomnav') && btn.closest('.bottomnav'))));
    document.querySelectorAll('.sidebar [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === btn.dataset.nav));
    document.querySelectorAll('.bottomnav [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === btn.dataset.nav));
    const target = document.getElementById(btn.dataset.nav);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ══════════ Buscador global ══════════ */
document.getElementById('globalSearch').addEventListener('input', (e) => {
  const needle = e.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-tags]').forEach((card) => {
    if (!needle) { card.classList.remove('dimmed'); return; }
    const hay = (card.dataset.tags + ' ' + card.textContent).toLowerCase();
    card.classList.toggle('dimmed', !needle.split(/\s+/).every((w) => hay.includes(w)));
  });
});

/* ══════════ Reproductor (MPD) ══════════ */
function postPlayer(path, body) {
  return fetch(`/api/player/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}
document.getElementById('playerToggle').addEventListener('click', () => postPlayer('toggle'));
document.getElementById('playerNext').addEventListener('click', () => postPlayer('next'));
document.getElementById('playerPrev').addEventListener('click', () => postPlayer('prev'));
document.getElementById('playerRandom').addEventListener('click', () => {
  postPlayer('random', { enabled: !(state.player && state.player.random) });
});
let volumeGuardUntil = 0;
function guardVolume(ms) { volumeGuardUntil = Date.now() + ms; }
function isVolumeGuarded() { return Date.now() < volumeGuardUntil; }
const playerVolume = document.getElementById('playerVolume');
function setVolumeUI(val) {
  if (val == null || !playerVolume) return;
  playerVolume.value = val;
  q('playerVolumeLabel').textContent = val + '%';
}
if (playerVolume) {
  playerVolume.addEventListener('pointerdown', () => guardVolume(60000));
  playerVolume.addEventListener('input', () => setVolumeUI(Number(playerVolume.value)));
  playerVolume.addEventListener('change', () => {
    const val = Number(playerVolume.value);
    setVolumeUI(val);
    postPlayer('volume', { volume: val });
    guardVolume(2500);
  });
}

/* ══════════ Cola de reproducción ══════════ */
const queueToggleBtn = document.getElementById('queueToggle');
queueToggleBtn.addEventListener('click', async () => {
  const panel = document.getElementById('queuePanel');
  const chevron = document.getElementById('queueChevron');
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    queueToggleBtn.setAttribute('aria-expanded', 'true');
    chevron.textContent = '▼';
    await loadQueue();
  } else {
    panel.classList.add('hidden');
    queueToggleBtn.setAttribute('aria-expanded', 'false');
    chevron.textContent = '▶';
  }
});
async function loadQueue() {
  const panel = document.getElementById('queuePanel');
  panel.innerHTML = '<div class="faint py-2 text-center" style="font-size:12px">Cargando…</div>';
  try {
    const r = await fetch('/api/player/queue');
    const data = await r.json();
    if (!data.ok || !data.items.length) {
      panel.innerHTML = '<div class="faint py-2 text-center" style="font-size:12px">Cola vacía</div>';
      return;
    }
    panel.innerHTML = data.items.map((item) => {
      const isCurrent = item.pos === data.currentPos;
      return `<div class="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl queue-item ${isCurrent ? 'queue-item-current' : ''}" data-id="${esc(item.id)}" role="button" tabindex="0">
        <span class="truncate ${isCurrent ? 'font-bold' : 'muted'}" style="font-size:12px">${esc(item.title)}${item.artist ? ' — ' + esc(item.artist) : ''}</span>
        <span class="faint flex-shrink-0 ml-2" style="font-size:10px">${fmtTime(item.duration)}</span>
      </div>`;
    }).join('');
    panel.querySelectorAll('.queue-item').forEach((el) => {
      const play = async () => { await postPlayer('playid', { id: Number(el.dataset.id) }); loadQueue(); };
      el.addEventListener('click', play);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } });
    });
  } catch {
    panel.innerHTML = '<div class="py-2 text-center" style="font-size:12px;color:var(--status-critical)">Error cargando la cola</div>';
  }
}

/* ══════════ Logout / reproductor externo ══════════ */
document.getElementById('openPlayerBtn').addEventListener('click', () => { window.location.href = '/player/'; });
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

/* ══════════ Cambiar clave ══════════ */
const EYE_OPEN = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"></path><circle cx="12" cy="12" r="3"></circle>';
const EYE_OFF = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.76 19.76 0 0 1 4.22-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a19.65 19.65 0 0 1-2.29 3.31M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
document.querySelectorAll('.eye-toggle-btn').forEach((btn) => {
  const input = document.getElementById(btn.dataset.target);
  const icon = btn.querySelector('svg');
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    icon.innerHTML = showing ? EYE_OPEN : EYE_OFF;
    btn.setAttribute('aria-label', showing ? 'Mostrar contraseña' : 'Ocultar contraseña');
  });
});
const changePassModal = document.getElementById('changePassModal');
function resetChangePassModal() {
  ['curPass', 'newPass', 'newPass2'].forEach((id) => {
    const input = document.getElementById(id);
    input.value = '';
    input.type = 'password';
  });
  document.querySelectorAll('.eye-toggle-btn svg').forEach((icon) => { icon.innerHTML = EYE_OPEN; });
  document.getElementById('changePassResult').textContent = '';
}
document.getElementById('openChangePassBtn').addEventListener('click', () => {
  resetChangePassModal();
  changePassModal.classList.remove('hidden');
  changePassModal.classList.add('flex');
  document.getElementById('curPass').focus();
});
document.getElementById('changePassCancel').addEventListener('click', () => {
  changePassModal.classList.add('hidden');
  changePassModal.classList.remove('flex');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  [changePassModal, document.getElementById('confirmModal')].forEach((m) => {
    if (!m.classList.contains('hidden')) { m.classList.add('hidden'); m.classList.remove('flex'); }
  });
});
[changePassModal, document.getElementById('confirmModal')].forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m) { m.classList.add('hidden'); m.classList.remove('flex'); }
  });
});
document.getElementById('changePassBtn').addEventListener('click', async () => {
  const curPass = document.getElementById('curPass');
  const newPass = document.getElementById('newPass');
  const newPass2 = document.getElementById('newPass2');
  const resultEl = document.getElementById('changePassResult');
  const btn = document.getElementById('changePassBtn');
  const label = document.getElementById('changePassLabel');
  resultEl.textContent = '';
  if (newPass.value !== newPass2.value) {
    resultEl.style.color = 'var(--status-critical)';
    resultEl.textContent = 'Las claves nuevas no coinciden';
    return;
  }
  btn.disabled = true;
  label.innerHTML = '<span class="spinner"></span>';
  try {
    const r = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: curPass.value, newPassword: newPass.value }),
    });
    const data = await r.json();
    if (data.ok) {
      resultEl.style.color = 'var(--status-good)';
      resultEl.textContent = 'Clave actualizada correctamente';
      curPass.value = ''; newPass.value = ''; newPass2.value = '';
      toast('Clave actualizada', 'ok');
    } else {
      resultEl.style.color = 'var(--status-critical)';
      resultEl.textContent = data.error || 'No se pudo actualizar';
    }
  } catch {
    resultEl.style.color = 'var(--status-critical)';
    resultEl.textContent = 'Error de conexión';
  }
  btn.disabled = false;
  label.textContent = 'Actualizar';
});

/* ══════════ Acciones del servidor ══════════ */
const actionResult = document.getElementById('actionResult');
function showResult(msg, isError) {
  actionResult.textContent = msg;
  actionResult.style.color = isError ? 'var(--status-critical)' : 'var(--status-good)';
}
async function callAction(action, body) {
  const btn = document.querySelector(`[data-action="${action}"]`);
  const original = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const r = await fetch(`/api/actions/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json();
    if (!r.ok || data.ok === false) {
      showResult(`Error: ${data.error || 'no se pudo ejecutar'}`, true);
      toast(data.error || 'No se pudo ejecutar la acción', 'err');
    } else if (action === 'free-swap') {
      const saved = data.beforeMiB - data.afterMiB;
      showResult(`Swap liberada: ${data.beforeMiB} MiB → ${data.afterMiB} MiB${saved > 0 ? ` (${saved} MiB recuperados)` : ''}`, false);
      toast('Swap liberada', 'ok');
    } else {
      showResult(data.message || `${action}: hecho${data.beforeGB != null ? ` (RAM disponible ${data.beforeGB}GB → ${data.afterGB}GB)` : ''}`, false);
      toast(data.message || 'Acción ejecutada', 'ok');
    }
  } catch {
    showResult('Error de conexión', true);
    toast('Error de conexión', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}
const modal = document.getElementById('confirmModal');
const modalTitle = document.getElementById('modalTitle');
const modalWarning = document.getElementById('modalWarning');
const modalHoursRow = document.getElementById('modalHoursRow');
const modalPasswordRow = document.getElementById('modalPasswordRow');
const modalHours = document.getElementById('modalHours');
const modalPassword = document.getElementById('modalPassword');
const modalConfirmInput = document.getElementById('modalConfirmInput');
const modalConfirmBtn = document.getElementById('modalConfirm');
const modalCancelBtn = document.getElementById('modalCancel');
let pendingAction = null;
let pendingKillPid = null;
let modalRequiresPassword = false;
function openModal(action) {
  pendingAction = action;
  pendingKillPid = null;
  modalPassword.value = '';
  modalConfirmInput.value = '';
  modalConfirmBtn.disabled = true;
  modalConfirmBtn.style.background = 'rgba(255,107,107,0.45)';
  modalConfirmBtn.style.cursor = 'not-allowed';
  modalRequiresPassword = false;
  modalPasswordRow.classList.add('hidden');
  modalHoursRow.classList.add('hidden');
  if (action === 'reboot') {
    modalTitle.textContent = 'Reiniciar el servidor';
    modalWarning.textContent = 'El servidor se reiniciará y estará fuera de línea unos minutos. El dashboard y el gateway volverán solos al terminar.';
    modalHoursRow.classList.add('hidden');
    modalRequiresPassword = true; modalPasswordRow.classList.remove('hidden');
  } else if (action === 'shutdown') {
    modalTitle.textContent = 'Apagar el servidor';
    modalWarning.textContent = 'El servidor se apagará por completo y se programará su encendido automático (RTC) a la hora elegida.';
    modalHoursRow.classList.remove('hidden');
    modalRequiresPassword = true; modalPasswordRow.classList.remove('hidden');
  } else {
    const info = {
      'restart-openclaw': ['Reiniciar OpenClaw', 'Se reiniciará el gateway. Las conversaciones en curso se interrumpirán brevemente.', 'REINICIAR'],
      'free-ram': ['Liberar RAM', 'Se vaciará la caché de página del sistema. Puede aumentar temporalmente el acceso al disco.', 'LIBERAR'],
      'free-swap': ['Liberar swap', 'La swap se desactivará y activará de nuevo. Algunas aplicaciones pueden ralentizarse brevemente.', 'SWAP'],
      'doctor-fix': ['Ejecutar Doctor Fix', 'OpenClaw intentará corregir su configuración. Puede tardar unos segundos.', 'CORREGIR'],
    }[action];
    if (info) { modalTitle.textContent = info[0]; modalWarning.textContent = info[1]; }
  }
  checkModalValid();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  modalPassword.focus();
}
// Modal genérico de kill reutiliza el mismo diálogo (lo usa panels.js)
function openKillModal(pid, name) {
  pendingAction = 'kill';
  pendingKillPid = pid;
  modalPassword.value = '';
  modalConfirmInput.value = '';
  modalConfirmBtn.disabled = true;
  modalConfirmBtn.style.background = 'rgba(255,107,107,0.45)';
  modalConfirmBtn.style.cursor = 'not-allowed';
  modalRequiresPassword = false;
  modalPasswordRow.classList.add('hidden');
  modalTitle.textContent = `Terminar proceso ${pid}`;
  modalWarning.textContent = `Se enviará SIGTERM a "${name}" (PID ${pid}). El proceso puede no terminar si lo ignora.`;
  modalHoursRow.classList.add('hidden');
  checkModalValid();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  modalConfirmInput.focus();
}
window.NexoKill = { open: openKillModal };
function closeModal() {
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  pendingAction = null;
  pendingKillPid = null;
}
function checkModalValid() {
  const valid = !modalRequiresPassword || modalPassword.value.length > 0;
  modalConfirmBtn.disabled = !valid;
  modalConfirmBtn.style.background = valid ? 'var(--status-critical)' : 'rgba(255,107,107,0.45)';
  modalConfirmBtn.style.cursor = valid ? 'pointer' : 'not-allowed';
}
modalConfirmInput.addEventListener('input', checkModalValid);
modalPassword.addEventListener('input', checkModalValid);
modalCancelBtn.addEventListener('click', closeModal);
modalConfirmBtn.addEventListener('click', async () => {
  const action = pendingAction;
  if (action === 'kill' && window.NexoPanels) {
    const pid = pendingKillPid;
    closeModal();
    await window.NexoPanels.kill(pid);
    return;
  }
  const body = modalRequiresPassword ? { password: modalPassword.value } : {};
  if (action === 'shutdown') body.hours = Number(modalHours.value);
  closeModal();
  if (action === 'doctor-fix') showResult('Ejecutando doctor --fix… puede tardar unos segundos', false);
  await callAction(action, body);
});
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    if (action === 'reboot' || action === 'shutdown' || action === 'restart-openclaw' || action === 'free-ram' || action === 'free-swap' || action === 'doctor-fix') {
      openModal(action);
    }
  });
});

/* ══════════ Entrada animada ══════════ */
function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    });
  }, { threshold: 0.06 });
  els.forEach((el) => io.observe(el));
}

/* ══════════ Arranque ══════════ */
initTheme();
initReveal();
loadHistory();
setInterval(loadHistory, 60000);
render();
