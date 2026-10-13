        const q = s => document.querySelector(`[data-value="${s}"]`);
        // Escapa antes de interpolar en innerHTML. Los datos vienen de procesos,
        // sesiones y del User-Agent/IP de los visitantes — el UA lo controla quien
        // visita, así que sin esto una petición con UA malicioso se ejecuta aquí.
        const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const state = { sys: {}, oc: {}, models: {}, ping: null, memHistory: [], cpuHistory: [], swapHistory: [], processes: [], gatewayLogs: [], player: {}, bluetooth: {}, io: {}, alerts: [], history: { short: [], daily: [] }, range: 'short' };
        let lastArtKey = null;

        function setValue(key, value) {
            const el = q(key) || document.getElementById(key);
            if (el) el.textContent = value == null || value === '' ? '--' : String(value);
        }

        function renderOverview(sys) {
            setValue('heroHost', sys.hostname || 'Servidor');
            setValue('heroOs', sys.osDistro || '--');
            setValue('heroUptime', sys.uptime != null ? fmtUptime(sys.uptime) : '--');
            setValue('cpuHero', sys.cpu != null ? `${sys.cpu}%` : '--');
            setValue('ramHero', sys.memUsed != null ? `${sys.memUsed}%` : '--');
            setValue('diskHero', sys.diskUsedPct != null ? `${sys.diskUsedPct}%` : '--');
            setValue('tempHero', sys.cpuTemp != null ? `${sys.cpuTemp}°C` : '--');
            setValue('swapHero', sys.swapUsedPct != null ? `${sys.swapUsedPct}%` : 'No configurada');
            const fmtMem = (mb) => mb == null || !Number.isFinite(Number(mb)) ? '--' : Number(mb) >= 1024 ? `${(Number(mb) / 1024).toFixed(1)} GB` : `${Math.round(Number(mb))} MB`;
            const swapConfigured = Number(sys.swapTotalMB) > 0 && sys.swapUsedPct != null;
            setValue('swapHeroDetail', swapConfigured ? `${fmtMem(sys.swapUsedMB)} / ${fmtMem(sys.swapTotalMB)} usados` : 'No configurada');
            [[ 'ramBar', sys.memUsed, 85, 95 ], [ 'diskBar', sys.diskUsedPct, 85, 95 ]].forEach(([id, value, warnAt, critAt]) => {
                const bar = document.getElementById(id);
                if (bar && value != null && Number.isFinite(Number(value))) {
                    const pct = Math.max(0, Math.min(100, Number(value)));
                    const level = statusLevel(pct, warnAt, critAt);
                    bar.style.width = `${pct}%`;
                    bar.style.background = STATUS_VAR[level];
                }
            });
            if (swapConfigured) {
                const pct = Math.max(0, Math.min(100, Number(sys.swapUsedPct)));
                const freeMB = Math.max(0, Number(sys.swapTotalMB) - Number(sys.swapUsedMB || 0));
                const level = statusLevel(pct, 75, 90);
                setValue('swapPerfValue', `${Math.round(pct)}%`);
                setValue('swapPerfDetail', `${fmtMem(sys.swapUsedMB)} usados`);
                setValue('swapFreeLabel', `Libre: ${fmtMem(freeMB)}`);
                setValue('swapTotalLabel', `Total: ${fmtMem(sys.swapTotalMB)}`);
                setValue('swapPerfStatus', level === 'critical' ? 'Crítica' : level === 'warning' ? 'Alta' : 'Normal');
                const status = q('swapPerfStatus');
                if (status) status.className = `card-tools pill ${level === 'critical' ? 'offline' : level === 'warning' ? 'warn' : 'online'}`;
                const bar = document.getElementById('swapBar');
                if (bar) { bar.style.width = `${pct}%`; bar.style.background = STATUS_VAR[level]; }
                applyStatus('swapPerf', pct, 75, 90);
            } else {
                setValue('swapPerfValue', 'No configurada');
                setValue('swapPerfDetail', 'El sistema no tiene memoria Swap disponible');
                setValue('swapFreeLabel', 'Libre: --');
                setValue('swapTotalLabel', 'Total: --');
                setValue('swapPerfStatus', 'No disponible');
                const status = q('swapPerfStatus');
                if (status) status.className = 'card-tools pill';
                const bar = document.getElementById('swapBar');
                if (bar) bar.style.width = '0%';
            }
            applyStatus('cpuHero', sys.cpu, 85, 95);
            applyStatus('ramHero', sys.memUsed, 85, 95);
            applyStatus('diskHero', sys.diskUsedPct, 85, 95);
            if (sys.swapUsedPct != null) applyStatus('swapHero', sys.swapUsedPct, 75, 90);

            setValue('healthCpu', sys.cpu != null ? `${sys.cpu}%` : '--');
            setValue('healthTemp', sys.cpuTemp != null ? `${sys.cpuTemp}°C` : '--');
            setValue('healthSwap', sys.swapUsedPct != null ? `${sys.swapUsedPct}%` : 'No configurada');

            const checks = [
                [sys.cpu, 85, 95, 'CPU'], [sys.memUsed, 85, 95, 'RAM'],
                [sys.diskUsedPct, 85, 95, 'disco'], [sys.cpuTemp, 75, 85, 'temperatura'],
                [sys.swapUsedPct, 75, 90, 'swap'],
            ];
            const critical = checks.filter(([value, , limit]) => value != null && value >= limit);
            const warning = checks.filter(([value, warnAt, limit]) => value != null && value >= warnAt && value < limit);
            const alerts = Array.isArray(state.alerts) ? state.alerts.length : 0;
            const level = critical.length ? 'critical' : (warning.length || alerts ? 'warning' : 'good');
            const levelEl = document.getElementById('healthLevel');
            if (levelEl) {
                levelEl.textContent = level === 'critical' ? 'Crítico' : level === 'warning' ? 'Atención' : 'Estable';
                levelEl.className = `pill ${level === 'critical' ? 'offline' : level === 'warning' ? 'warn' : 'online'}`;
            }
            const title = document.getElementById('healthTitle');
            if (title) title.textContent = level === 'critical' ? 'Requiere atención inmediata' : level === 'warning' ? 'Servidor bajo observación' : 'Servidor funcionando bien';
            const copy = document.getElementById('healthCopy');
            if (copy) {
                const causes = critical.length ? critical.map((item) => item[3]) : warning.map((item) => item[3]);
                copy.textContent = causes.length ? `Revisa ${causes.join(', ')}.` : alerts ? `${alerts} alerta${alerts === 1 ? '' : 's'} activa${alerts === 1 ? '' : 's'}.` : 'Las métricas principales están dentro de los umbrales.';
            }
            setValue('healthAlerts', alerts);
            const badge = document.getElementById('heroStatus');
            if (badge) {
                badge.textContent = `● ${level === 'critical' ? 'Crítico' : level === 'warning' ? 'Atención' : 'Operativo'}`;
                badge.className = `pill ${level === 'critical' ? 'offline' : level === 'warning' ? 'warn' : 'online'}`;
            }
        }

        function fmtTime(sec) {
            if (sec == null || isNaN(sec)) return '0:00';
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return m + ':' + String(s).padStart(2, '0');
        }

        function fmtBytes(b) {
            if (b == null) return '?';
            return b > 1e9 ? (b/1e9).toFixed(1)+'G' : b > 1e6 ? (b/1e6).toFixed(1)+'M' : b > 1e3 ? (b/1e3).toFixed(0)+'K' : b+'B';
        }

        function fmtUptime(sec) {
            if (sec == null) return '--';
            const d = Math.floor(sec/86400);
            sec %= 86400;
            const h = Math.floor(sec/3600);
            sec %= 3600;
            const m = Math.floor(sec/60);
            return d+'d '+h+'h '+m+'m';
        }

        // good / warning / critical — paleta de estado fija, no se reusa como color categórico
        const STATUS_VAR = { good: 'var(--status-good)', warning: 'var(--status-warning)', critical: 'var(--status-critical)' };
        function statusLevel(value, warnAt, critAt) {
            if (value == null) return 'good';
            return value >= critAt ? 'critical' : value >= warnAt ? 'warning' : 'good';
        }
        function applyStatus(key, value, warnAt, critAt) {
            const el = document.querySelector(`[data-color="${key}"]`);
            if (!el) return;
            const level = statusLevel(value, warnAt, critAt);
            el.classList.remove('status-good', 'status-warning', 'status-critical');
            el.classList.add(`status-${level}`);
        }

        function sparkline(el, values, color) {
            if (!el || values.length < 2) return;
            const w = 100, h = 24;
            const max = 100;
            const step = w / (values.length - 1);
            const pts = values.map((v, i) => [i * step, h - (Math.min(v, max) / max) * h]);
            const line = pts.map(p => p.join(',')).join(' ');
            const area = `0,${h} ${line} ${w},${h}`;
            el.innerHTML = `
                <polygon points="${area}" fill="${color}" opacity="0.14"></polygon>
                <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"></polyline>`;
        }

        function drawSeriesChart(svg, tracks, fixedMax = null, samples = [], unit = '%') {
            if (!svg) return;
            const box = (svg.getAttribute('viewBox') || '0 0 300 90').split(/\s+/).map(Number);
            const rect = svg.getBoundingClientRect();
            const w = Math.max(220, Math.round(rect.width || box[2] || 300));
            const h = Math.round(rect.height || box[3] || 140);
            svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
            const times = samples.map(sample => Number(sample?.t));
            const validTimes = times.filter(Number.isFinite);
            const start = validTimes.length ? Math.min(...validTimes) : null;
            const end = validTimes.length ? Math.max(...validTimes) : null;
            const showDate = start !== null && end - start >= 86400000;
            const pad = { left: 52, right: 14, top: 18, bottom: showDate ? 43 : 27 };
            const plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
            const ns = 'http://www.w3.org/2000/svg';
            const make = (name, attrs) => {
                const node = document.createElementNS(ns, name);
                Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
                return node;
            };
            const text = (value, x, y, anchor = 'end') => {
                const node = make('text', { x, y, 'text-anchor': anchor, class: 'chart-axis' });
                node.textContent = value; svg.appendChild(node); return node;
            };
            svg.replaceChildren();
            const all = tracks.flatMap(track => track.values.filter(value => value != null).map(Number).filter(Number.isFinite));
            const peak = all.length ? Math.max(1, ...all) * 1.15 : 1;
            const magnitude = 10 ** Math.floor(Math.log10(peak));
            const max = fixedMax || [1, 2, 5, 10].map(step => step * magnitude).find(value => value >= peak);
            text(unit, pad.left - 8, 11);
            const number = new Intl.NumberFormat('es-CO', { maximumFractionDigits: max < 2 ? 2 : 1, notation: max >= 10000 ? 'compact' : 'standard' });
            for (let i = 0; i <= 4; i++) {
                const y = pad.top + plotH * i / 4;
                svg.appendChild(make('line', { x1: pad.left, y1: y, x2: w - pad.right, y2: y, class: 'chart-grid' }));
                text(number.format(max * (1 - i / 4)), pad.left - 8, y + 3);
            }
            const bottom = pad.top + plotH;
            svg.appendChild(make('line', { x1: pad.left, y1: pad.top, x2: pad.left, y2: bottom, class: 'chart-rule' }));
            svg.appendChild(make('line', { x1: pad.left, y1: bottom, x2: w - pad.right, y2: bottom, class: 'chart-rule' }));
            if (start !== null) {
                const count = end === start ? 1 : Math.max(2, Math.min(6, Math.floor(plotW / 100) + 1));
                const timeFormat = new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                const dateFormat = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: '2-digit', year: '2-digit' });
                for (let i = 0; i < count; i++) {
                    const ratio = count === 1 ? 0.5 : i / (count - 1);
                    const x = pad.left + plotW * ratio;
                    const date = new Date(start + (end - start) * ratio);
                    const anchor = count === 1 ? 'middle' : i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle';
                    svg.appendChild(make('line', { x1: x, y1: pad.top, x2: x, y2: bottom, class: 'chart-grid chart-grid-vertical' }));
                    svg.appendChild(make('line', { x1: x, y1: bottom, x2: x, y2: bottom + 4, class: 'chart-rule' }));
                    text(timeFormat.format(date), x, bottom + 17, anchor);
                    if (showDate) text(dateFormat.format(date), x, bottom + 31, anchor);
                }
            }
            if (!all.length) {
                const label = make('text', { x: w / 2, y: h / 2 + 4, 'text-anchor': 'middle', class: 'chart-axis' });
                label.textContent = 'Esperando muestras';
                svg.appendChild(label);
                return;
            }
            tracks.forEach((track) => {
                const points = track.values.map((value, index) => {
                    if (value == null || !Number.isFinite(Number(value))) return null;
                    const ratio = start !== null && Number.isFinite(times[index])
                        ? end === start ? 0.5 : (times[index] - start) / (end - start)
                        : track.values.length === 1 ? 0.5 : index / (track.values.length - 1);
                    return { x: pad.left + plotW * ratio, y: bottom - Math.max(0, Math.min(max, Number(value))) / max * plotH };
                }).filter(Boolean);
                if (!points.length) return;
                const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
                const area = `${line} L${points[points.length - 1].x.toFixed(1)},${(pad.top + plotH).toFixed(1)} L${points[0].x.toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;
                svg.appendChild(make('path', { d: area, fill: track.color, opacity: '0.1' }));
                svg.appendChild(make('path', { d: line, fill: 'none', stroke: track.color, 'stroke-width': h < 80 ? 2.5 : 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
                const last = points[points.length - 1];
                svg.appendChild(make('circle', { cx: last.x, cy: last.y, r: h < 80 ? 3 : 2.5, fill: track.color, stroke: 'var(--surface-solid)', 'stroke-width': 1.5 }));
            });
        }

        function renderMetricCharts() {
            const history = activeSeries();
            const values = (items, key) => (Array.isArray(items) ? items : []).map((sample) =>
                sample && typeof sample === 'object' ? sample[key] : sample
            );
            const cpu = values(history, 'cpu');
            const ram = values(history, 'ram');
            const color = (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
            const cpuColor = color('--s-cpu'), ramColor = color('--s-ram');
            drawSeriesChart(document.querySelector('[data-chart="cpu"]'), [{ values: cpu, color: cpuColor }], 100, history);
            drawSeriesChart(document.querySelector('[data-chart="ram"]'), [{ values: ram, color: ramColor }], 100, history);
            const swap = state.swapHistory || [];
            drawSeriesChart(document.querySelector('[data-chart="swap"]'), [{ values: swap.map((sample) => sample.pct), color: color('--status-warning') }], 100, swap);
            setRangeLabels('swap', swap);
            const historical = state.historicalPoints || history;
            drawSeriesChart(document.querySelector('[data-chart="history"]'), [
                { values: historical.map((sample) => sample.cpu), color: cpuColor },
                { values: historical.map((sample) => sample.ram), color: ramColor },
            ], 100, historical);
            setRangeLabels('cpu', history);
            setRangeLabels('ram', history);
            setRangeLabels('history', historical);
            const net = state.io?.net?.hist || [];
            drawSeriesChart(document.querySelector('[data-chart="net"]'), [
                { values: net.map((sample) => sample.rx), color: color('--s-net-rx') },
                { values: net.map((sample) => sample.tx), color: color('--s-net-tx') },
            ], null, net, 'KB/s');
            setRangeLabels('net', net);
            const disk = state.io?.disk?.hist || [];
            drawSeriesChart(document.querySelector('[data-chart="dio"]'), [
                { values: disk.map((sample) => sample.r), color: color('--s-disk-r') },
                { values: disk.map((sample) => sample.w), color: color('--s-disk-w') },
            ], null, disk, 'KB/s');
            setRangeLabels('dio', disk);
        }

        // Muestra las fechas locales de los extremos realmente graficados.
        function setRangeLabels(kind, samples) {
            const wrap = document.querySelector(`[data-sparkrange="${kind}"]`);
            if (!wrap) return;
            const timed = (Array.isArray(samples) ? samples : []).filter(sample => sample && Number.isFinite(Number(sample.t)) && Number.isFinite(new Date(Number(sample.t)).getTime())).sort((a, b) => Number(a.t) - Number(b.t));
            if (!timed.length) { wrap.textContent = ''; return; }
            const fmt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
            wrap.textContent = `${fmt.format(new Date(Number(timed[0].t)))} → ${fmt.format(new Date(Number(timed[timed.length - 1].t)))}`;
        }

        // Serie activa según el selector 1 h / 24 h.
        function activeSeries() {
            const hist = state.history || {};
            const daily = hist.daily || [];
            const short = hist.short || [];
            return state.range === 'daily' ? daily : short;
        }

        function render() {
            const sys = state.sys || {};
            const oc = state.oc || {};
            const player = state.player || {};
            const bt = state.bluetooth || {};

            renderOverview(sys);

            const btInfo = document.getElementById('bluetoothInfo');
            if (btInfo) {
                if (bt.connected) {
                    btInfo.classList.remove('hidden');
                    btInfo.classList.add('flex');
                    const btName = document.querySelector('[data-value="btName"]');
                    const battWrap = document.querySelector('[data-value="btBatteryWrap"]');
                    const battEl = document.querySelector('[data-value="btBatteryPct"]');
                    if (btName) btName.textContent = bt.name || 'Dispositivo Bluetooth';
                    if (bt.battery != null && battWrap && battEl) {
                        battWrap.style.display = '';
                        battEl.textContent = bt.battery + '%';
                        battEl.classList.remove('status-good', 'status-warning', 'status-critical');
                        battEl.classList.add(`status-${statusLevel(100 - bt.battery, 70, 85)}`);
                    } else if (battWrap) {
                        battWrap.style.display = 'none';
                    }
                } else {
                    btInfo.classList.add('hidden');
                    btInfo.classList.remove('flex');
                }
            }

            if (player.ok) {
                q('playerTitle').textContent = player.title || 'Sin reproducción';
                q('playerArtist').textContent = player.artist || player.album || '--';
                q('playerElapsed').textContent = fmtTime(player.elapsed);
                q('playerDuration').textContent = fmtTime(player.duration);
                const pct = player.duration ? Math.min(100, (player.elapsed / player.duration) * 100) : 0;
                document.getElementById('playerProgress').style.width = pct + '%';
                document.getElementById('playerToggle').textContent = player.state === 'play' ? '⏸' : '▶';
                const randomBtn = document.getElementById('playerRandom');
                randomBtn.style.background = player.random ? 'var(--accent)' : '';
                randomBtn.style.color = player.random ? '#fff' : '';
                randomBtn.style.borderColor = player.random ? 'var(--accent)' : '';
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
            }

            if (sys.cpu != null) { q('cpu').textContent = sys.cpu + '%'; applyStatus('cpu', sys.cpu, 85, 95); }
            if (sys.cpuTemp) q('temp').textContent = '🌡️ ' + sys.cpuTemp + '°C';

            if (sys.memUsed != null) { q('ram').textContent = sys.memUsed + '%'; applyStatus('ram', sys.memUsed, 80, 92); }
            if (sys.memUsedGB) q('ramUsedLabel').textContent = sys.memUsedGB + ' GB';
            if (sys.memTotalGB) q('ramTotalLabel').textContent = sys.memTotalGB + ' GB';

            if (sys.diskUsedPct != null) {
                q('disk').textContent = sys.diskUsedPct + '%';
                applyStatus('disk', sys.diskUsedPct, 85, 95);
                q('diskUsedLabel').textContent = (sys.diskUsedGB || '?') + ' GB';
                q('diskTotalLabel').textContent = (sys.diskTotalGB || '?') + ' GB';
            }

            if (sys.netRx != null) {
                q('netDown').textContent = '⬇ ' + fmtBytes(sys.netRx)+'/s';
                q('netUp').textContent = '⬆ ' + fmtBytes(sys.netTx)+'/s';
            }

            if (sys.hostname) document.getElementById('hostnameTag').textContent = sys.hostname;
            if (sys.uptime != null) q('uptime').textContent = fmtUptime(sys.uptime);
            if (sys.osDistro) q('osDistro').textContent = sys.osDistro;
            if (sys.swapUsedPct != null) {
                q('swapLabel').textContent = sys.swapUsedPct + '%';
                applyStatus('swap', sys.swapUsedPct, 40, 75);
            } else {
                q('swapLabel').textContent = 'N/A';
                applyStatus('swap', 0, 40, 75);
            }

            if (Array.isArray(sys.cpuCores) && sys.cpuCores.length) {
                const container = document.getElementById('coreBars');
                container.innerHTML = sys.cpuCores.map((load, index) => {
                    const level = statusLevel(load, 70, 90);
                    const pct = Math.max(0, Math.min(100, Number(load) || 0));
                    return `<div style="display:grid;grid-template-columns:34px 1fr 42px;align-items:center;gap:8px;font-size:11px"><span class="faint">C${index + 1}</span><div class="core-bar-track"><div class="core-bar-fill" style="width:${pct}%;background:${STATUS_VAR[level]}"></div></div><span style="text-align:right">${Math.round(pct)}%</span></div>`;
                }).join('');
            }

            const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            const series = activeSeries();
            const cpuSeries = series.map(s => s.cpu);
            const ramSeries = series.map(s => s.ram);
            sparkline(document.querySelector('[data-spark="cpu"]'), cpuSeries.length >= 2 ? cpuSeries : state.cpuHistory, cssVar('--series-cpu'));
            sparkline(document.querySelector('[data-spark="ram"]'), ramSeries.length >= 2 ? ramSeries : state.memHistory, cssVar('--series-ram'));
            setRangeLabels(series);

            const badge = document.getElementById('serverBadge');
            if (socket.connected) {
                badge.textContent = '● Online';
                badge.className = 'pill online';
            } else {
                badge.textContent = '● Offline';
                badge.className = 'pill offline';
            }

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
                latBadge.className = 'pill ' + (ok ? 'status-good' : 'status-critical');
                latBadge.style.borderColor = ok ? 'color-mix(in srgb, var(--status-good) 40%, transparent)' : 'color-mix(in srgb, var(--status-critical) 40%, transparent)';
            }

            if (state.models && state.models.primary) {
                q('ocModel').textContent = state.models.primary.split('/').pop();
            }

            if (state.ping != null) {
                document.getElementById('pingTag').textContent = 'Ping: ' + state.ping + ' ms';
            }

            const sList = oc.sessions || [];
            const sessionsContainer = document.getElementById('sessionsContainer');
            if (sList.length > 0) {
                let html = '<div class="overflow-x-auto"><table class="data-table">';
                html += '<thead><tr><th>Agente</th><th>Modelo</th><th>Estado</th><th>Duración</th><th class="hidden md:table-cell">Canal</th></tr></thead><tbody>';
                sList.slice(0, 8).forEach(s => {
                    const scStyle = (s.status === 'active' || s.status === 'running') ? 'color:var(--status-good)' : '';
                    html += `<tr>
                        <td style="color:var(--ink)">${esc(s.agentId || '?')}</td>
                        <td>${esc(s.model || '?')}</td>
                        <td style="${scStyle}">${esc(s.status || '?')}</td>
                        <td>${esc(s.duration || '?')}</td>
                        <td class="hidden md:table-cell">${esc(s.channel || '-')}</td>
                    </tr>`;
                });
                html += '</tbody></table></div>';
                sessionsContainer.innerHTML = html;
            } else if ((state.gatewayLogs || []).length > 0) {
                const note = oc.sessionsCircuitOpen
                    ? 'Lista de sesiones no disponible por ahora — mostrando actividad reciente del gateway:'
                    : 'Sin sesiones activas — actividad reciente del gateway:';
                sessionsContainer.innerHTML = `<div class="text-xs text-white/30 mb-2">${note}</div>` +
                    `<div class="space-y-1 max-h-48 overflow-y-auto">${state.gatewayLogs.map(l => `<div class="log-line">${l.replace(/</g,'&lt;')}</div>`).join('')}</div>`;
            }

            const procs = state.processes || [];
            if (procs.length > 0) {
                const container = document.getElementById('processesContainer');
                // Algunas vistas no incluyen el panel de procesos. Los datos
                // pueden seguir llegando por Socket.IO, pero no deben romper
                // el renderizado del resto del dashboard.
                if (container) {
                    let html = '<div class="overflow-x-auto"><table class="data-table">';
                    html += '<thead><tr><th>Proceso</th><th>PID</th><th>CPU</th><th>RAM</th></tr></thead><tbody>';
                    procs.forEach(p => {
                        html += `<tr>
                            <td style="color:var(--ink)">${esc(p.name || '?')}</td>
                            <td>${esc(p.pid)}</td>
                            <td>${esc(p.cpu)}%</td>
                            <td>${p.memRss} MB</td>
                        </tr>`;
                    });
                    html += '</tbody></table></div>';
                    container.innerHTML = html;
                }
            }

            // ===== Visitantes en tiempo real =====
            const vis = state.visitors || { active: [], total: 0 };
            const visActive = (vis.active || []).filter(v => !/Bot/.test(v.device || ''));
            const visTotal = vis.total || 0;
            q('visActive').textContent = visActive.length;
            q('visTotal').textContent = visTotal;
            const visRequests = visActive.reduce((a, v) => a + (v.requests || 0), 0);
            q('visRequests').textContent = visRequests;
            const visBadge = document.getElementById('visitorsBadge');
            if (visActive.length > 0) {
                visBadge.textContent = '● ' + visActive.length + ' en línea';
                visBadge.className = 'pill online';
            } else {
                visBadge.textContent = '● Sin actividad';
                visBadge.className = 'pill text-white/30';
            }
            const visContainer = document.getElementById('visitorsContainer');
            if (visActive.length > 0) {
                let vhtml = '<div class="overflow-x-auto"><table class="data-table">';
                vhtml += '<thead><tr><th>IP</th><th>Dominio</th><th>Dispositivo</th><th>Requests</th><th class="hidden md:table-cell">Última ruta</th><th>Estado</th></tr></thead><tbody>';
                visActive.slice(0, 10).forEach(v => {
                    const statusColor = v.active ? 'var(--status-good)' : 'var(--status-warning)';
                    const statusTxt = v.active ? '● Activo' : '○ Inactivo ' + (v.idleSec > 60 ? Math.round(v.idleSec/60) + 'm' : v.idleSec + 's');
                    const uri = esc((v.lastUri || '/').slice(0, 40));
                    // Dominio principal siempre visible; el subdominio se marca aparte.
                    const domMain = v.baseDomain ? esc(v.baseDomain) : '—';
                    const domSub = v.subdomain ? '<span class="text-white/40"> · ' + esc(v.subdomain) + '</span>' : '';
                    vhtml += `<tr>
                        <td style="color:var(--ink)">${esc(v.ip)}</td>
                        <td style="color:var(--ink-muted)">${domMain}${domSub}</td>
                        <td>${esc(v.device)} ${v.browser ? '<span class="text-white/40">' + esc(v.browser) + '</span>' : ''}</td>
                        <td>${esc(v.requests)}</td>
                        <td class="hidden md:table-cell" style="color:var(--ink-muted)">${uri}</td>
                        <td style="color:${statusColor}">${statusTxt}</td>
                    </tr>`;
                });
                vhtml += '</tbody></table></div>';
                visContainer.innerHTML = vhtml;
            } else {
                visContainer.innerHTML = '<div class="text-xs text-white/30 text-center py-4">Sin visitantes en los últimos 5 minutos</div>';
            }

            window.__nexoState = state;
            window.NexoInsights?.render(state);
            window.NexoPanels?.render(state);
            renderMetricCharts();
        }

        const socket = io();
        socket.on('connect', render);
        socket.on('disconnect', render);
        socket.on('stats', (data) => {
            if (data.sys) {
                state.sys = data.sys;
                const pct = Number(data.sys.swapUsedPct);
                if (Number.isFinite(pct) && Number(data.sys.swapTotalMB) > 0) {
                    state.swapHistory.push({ t: Date.now(), pct });
                    if (state.swapHistory.length > 180) state.swapHistory.splice(0, state.swapHistory.length - 180);
                } else state.swapHistory = [];
            }
            if (data.oc) state.oc = data.oc;
            if (data.models) state.models = data.models;
            if (data.ping !== undefined) state.ping = data.ping;
            if (data.memHistory) state.memHistory = data.memHistory;
            if (data.cpuHistory) state.cpuHistory = data.cpuHistory;
            if (data.processes) state.processes = data.processes;
            if (data.gatewayLogs) state.gatewayLogs = data.gatewayLogs;
            if (data.player) state.player = data.player;
            if (data.history) state.history = data.history;
            if (data.bluetooth) state.bluetooth = data.bluetooth;
            if (data.visitors) state.visitors = data.visitors;
            ['io', 'alerts', 'services', 'docker', 'smart', 'checks', 'links', 'publicFiles'].forEach((key) => {
                if (data[key] !== undefined) state[key] = data[key];
            });
            render();
        });

        document.querySelectorAll('#rangeToggle .range-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                state.range = btn.dataset.range === 'daily' ? 'daily' : 'short';
                document.querySelectorAll('#rangeToggle .range-btn').forEach(b => {
                    b.classList.toggle('range-btn-active', b === btn);
                });
                render();
            });
        });
        document.querySelector('#rangeToggle .range-btn')?.classList.add('range-btn-active');

        // El rango histórico es independiente de las gráficas en vivo.
        let historyRequest = 0;
        async function loadHistoricalRange(range) {
            const request = ++historyRequest;
            const status = document.getElementById('historyStatus');
            if (status) status.textContent = 'Cargando histórico…';
            try {
                const response = await fetch(`/api/history?range=${encodeURIComponent(range)}`);
                if (!response.ok) throw new Error('No se pudo consultar el histórico');
                const data = await response.json();
                if (request !== historyRequest) return;
                if (!data.ok || !Array.isArray(data.points)) throw new Error('Respuesta de histórico inválida');
                state.historicalPoints = data.points;
                document.querySelectorAll('[data-hist]').forEach(button => {
                    const selected = button.dataset.hist === data.range;
                    button.classList.toggle('range-btn-active', selected);
                    button.setAttribute('aria-pressed', String(selected));
                });
                if (status) status.textContent = `${data.samples} muestras · retención ${data.retentionDays} días`;
                renderMetricCharts();
            } catch (error) {
                if (request === historyRequest && status) status.textContent = error.message;
            }
        }
        document.querySelectorAll('[data-hist]').forEach(button => {
            button.addEventListener('click', () => loadHistoricalRange(button.dataset.hist));
        });
        if (document.querySelector('[data-hist]') && ['/', '/overview'].includes(location.pathname)) loadHistoricalRange('24h');

        // ===== Reproductor (MPD) =====
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
        // Candado por tiempo (no por bandera de "arrastrando"): MPD/PulseAudio
        // tardan un instante en reflejar el nuevo volumen, así que un solo poll
        // de 2s que llegue justo después del cambio puede traer el valor viejo
        // y se ve como un salto. Bloqueamos las actualizaciones del servidor
        // el tiempo suficiente para que pase un ciclo de poll completo.
        let volumeGuardUntil = 0;
        function guardVolume(ms) { volumeGuardUntil = Date.now() + ms; }
        function isVolumeGuarded() { return Date.now() < volumeGuardUntil; }

        const playerVolume = document.getElementById('playerVolume');
        const playerVolumeMobile = document.getElementById('playerVolumeMobile');

        function setVolumeUI(val) {
            if (playerVolume) playerVolume.value = val;
            if (playerVolumeMobile) playerVolumeMobile.value = val;
            const volumeLabel = q('playerVolumeLabel');
            const volumeLabelMobile = q('playerVolumeLabelMobile');
            if (volumeLabel) volumeLabel.textContent = val + '%';
            if (volumeLabelMobile) volumeLabelMobile.textContent = val + '%';
        }

        function wireVolumeSlider(el) {
            if (!el) return;
            el.addEventListener('pointerdown', () => guardVolume(60000));
            el.addEventListener('input', () => setVolumeUI(Number(el.value)));
            el.addEventListener('change', () => {
                const val = Number(el.value);
                setVolumeUI(val);
                postPlayer('volume', { volume: val });
                guardVolume(2500);
            });
        }
        wireVolumeSlider(playerVolume);
        wireVolumeSlider(playerVolumeMobile);

        function adjustVolume(delta) {
            const next = Math.min(100, Math.max(0, Number(playerVolume?.value || 0) + delta));
            setVolumeUI(next);
            guardVolume(2500);
            postPlayer('volume', { volume: next });
        }
        document.getElementById('volDown')?.addEventListener('click', () => adjustVolume(-5));
        document.getElementById('volUp')?.addEventListener('click', () => adjustVolume(5));

        // ===== Cola de reproducción (acordeón) =====
        document.getElementById('queueToggle').addEventListener('click', async () => {
            const panel = document.getElementById('queuePanel');
            const chevron = document.getElementById('queueChevron');
            if (panel.classList.contains('hidden')) {
                panel.classList.remove('hidden');
                chevron.textContent = '▼';
                await loadQueue();
            } else {
                panel.classList.add('hidden');
                chevron.textContent = '▶';
            }
        });

        async function loadQueue() {
            const panel = document.getElementById('queuePanel');
            panel.innerHTML = '<div class="text-xs text-white/30 py-2 text-center">Cargando...</div>';
            try {
                const r = await fetch('/api/player/queue');
                const data = await r.json();
                if (!data.ok || !data.items.length) {
                    panel.innerHTML = '<div class="text-xs text-white/30 py-2 text-center">Cola vacía</div>';
                    return;
                }
                panel.innerHTML = data.items.map(item => {
                    const isCurrent = item.pos === data.currentPos;
                    return `<div class="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-white/5 queue-item" data-id="${esc(item.id)}" style="${isCurrent ? 'background:color-mix(in srgb, var(--accent) 14%, transparent);' : ''}">
                        <span class="text-xs truncate ${isCurrent ? 'text-white font-bold' : 'text-white/60'}">${esc(item.title)}${item.artist ? ' — ' + esc(item.artist) : ''}</span>
                        <span class="text-[10px] text-white/30 flex-shrink-0 ml-2">${fmtTime(item.duration)}</span>
                    </div>`;
                }).join('');
                panel.querySelectorAll('.queue-item').forEach(el => {
                    el.addEventListener('click', async () => {
                        await postPlayer('playid', { id: Number(el.dataset.id) });
                        loadQueue();
                    });
                });
            } catch {
                panel.innerHTML = '<div class="text-xs text-red-400 py-2 text-center">Error cargando la cola</div>';
            }
        }

        // ===== Logout =====
        // Antes era un onclick="..." inline; una CSP con script-src 'self' lo
        // bloquea, así que va como listener.
        document.getElementById('openPlayerBtn').addEventListener('click', () => {
            window.location.href = '/player/';
        });

        document.getElementById('logoutBtn').addEventListener('click', async () => {
            await fetch('/api/logout', { method: 'POST' });
            window.location.href = '/login';
        });

        // ===== Cambiar clave (modal) =====
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
        });
        document.getElementById('changePassCancel').addEventListener('click', () => {
            changePassModal.classList.add('hidden');
            changePassModal.classList.remove('flex');
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

        // ===== Acciones del servidor =====
        const actionResult = document.getElementById('actionResult');
        function showResult(msg, isError) {
            actionResult.textContent = msg;
            actionResult.style.color = isError ? 'var(--status-critical)' : 'var(--status-good)';
        }

        async function callAction(action, body) {
            const btn = document.querySelector(`[data-action="${action}"]`);
            btn.disabled = true;
            try {
                const r = await fetch(`/api/actions/${action}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {}),
                });
                const data = await r.json();
                if (!r.ok || data.ok === false) {
                    showResult(`Error: ${data.error || 'no se pudo ejecutar'}`, true);
                } else if (action === 'free-swap') {
                    const saved = data.beforeMiB - data.afterMiB;
                    showResult(`Swap liberada: ${data.beforeMiB} MiB → ${data.afterMiB} MiB${saved > 0 ? ` (${saved} MiB recuperados)` : ''}`, false);
                } else {
                    showResult(data.message || `${action}: hecho${data.beforeGB != null ? ` (RAM disponible ${data.beforeGB}GB → ${data.afterGB}GB)` : ''}`, false);
                }
            } catch (e) {
                showResult('Error de conexión', true);
            } finally {
                btn.disabled = false;
            }
        }

        // Modal genérico para reboot/shutdown
        const modal = document.getElementById('confirmModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalWarning = document.getElementById('modalWarning');
        const modalHoursRow = document.getElementById('modalHoursRow');
        const modalHours = document.getElementById('modalHours');
        const modalPassword = document.getElementById('modalPassword');
        const modalConfirmWord = document.getElementById('modalConfirmWord');
        const modalConfirmInput = document.getElementById('modalConfirmInput');
        const modalConfirmBtn = document.getElementById('modalConfirm');
        const modalCancelBtn = document.getElementById('modalCancel');
        let pendingAction = null;

        function openModal(action) {
            pendingAction = action;
            modalPassword.value = '';
            if (modalConfirmInput) modalConfirmInput.value = '';
            modalConfirmBtn.disabled = !modalPassword.value;
            modalConfirmBtn.style.background = 'color-mix(in srgb, var(--status-critical) 55%, transparent)';
            modalConfirmBtn.style.cursor = modalPassword.value ? 'pointer' : 'not-allowed';
            if (action === 'reboot') {
                modalTitle.textContent = '♻️ Reiniciar el servidor';
                modalWarning.textContent = 'El servidor se reiniciará y estará fuera de línea unos minutos. El dashboard y el gateway volverán solos al terminar.';
                modalHoursRow.classList.add('hidden');
            } else {
                modalTitle.textContent = '⏻ Apagar el servidor';
                modalWarning.textContent = 'El servidor se apagará por completo y se programará su encendido automático (RTC) a la hora elegida.';
                modalHoursRow.classList.remove('hidden');
            }
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeModal() {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            pendingAction = null;
        }

        function checkModalValid() {
            const valid = modalPassword.value.length > 0;
            modalConfirmBtn.disabled = !valid;
            modalConfirmBtn.style.background = valid ? 'var(--status-critical)' : 'color-mix(in srgb, var(--status-critical) 55%, transparent)';
            modalConfirmBtn.style.cursor = valid ? 'pointer' : 'not-allowed';
        }
        modalConfirmInput?.addEventListener('input', checkModalValid);
        modalPassword?.addEventListener('input', checkModalValid);
        modalCancelBtn?.addEventListener('click', closeModal);

        modalConfirmBtn.addEventListener('click', async () => {
            const action = pendingAction;
            const body = { password: modalPassword.value };
            if (action === 'shutdown') body.hours = Number(modalHours.value);
            closeModal();
            await callAction(action, body);
        });

        document.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'reboot' || action === 'shutdown') {
                    openModal(action);
                } else if (action === 'restart-openclaw') {
                    if (confirm('¿Reiniciar el gateway de OpenClaw ahora? Se interrumpirán conversaciones en curso brevemente.')) callAction(action);
                } else if (action === 'free-ram' || action === 'free-swap' || action === 'doctor-fix') {
                    if (action === 'doctor-fix') showResult('Ejecutando doctor --fix… puede tardar unos segundos', false);
                    callAction(action);
                }
            });
        });
    
