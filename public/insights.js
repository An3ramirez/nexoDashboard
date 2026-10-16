/* Resumen operativo contextual para cada página. */
'use strict';
window.NexoInsights = {
  render(state) {
    const route = location.pathname;
    const config = ({
      '/': ['sec-perf', 'Rendimiento actual'], '/overview': ['sec-perf', 'Rendimiento actual'], '/performance': ['sec-files', 'Control de archivos'],
      '/network': ['sec-net', 'Capacidad de red y disco'], '/visitors': ['sec-visitors', 'Actividad de visitantes'],
      '/gateway': ['sec-gateway', 'Disponibilidad del gateway'], '/infrastructure': ['sec-infra', 'Estado de infraestructura'],
      '/media': ['sec-media', 'Estado multimedia'], '/processes': ['sec-procs', 'Carga de procesos'],
      '/actions': ['sec-actions', 'Operación segura'], '/sessions': ['sec-sessions', 'Estado de sesiones'],
    })[route];
    if (!config) return;
    const [anchor, title] = config;
    const head = document.getElementById(anchor); if (!head) return;
    let panel = document.getElementById('pageInsights');
    if (!panel) { panel = document.createElement('section'); panel.id = 'pageInsights'; panel.className = 'page-insights'; head.after(panel); }
    const sys = state.sys || {}, io = state.io || {}, oc = state.oc || {}, visitors = state.visitors || {};
    const facts = [];
    const add = (label, value, note, tone) => facts.push({ label, value: value == null ? '--' : String(value), note: note || '', tone: tone || '' });
    if (anchor === 'sec-perf') {
      const cpuState = sys.health?.rules?.find(rule => rule.key === 'cpu');
      const cpuCritical = cpuState?.level === 'critical', cpuWarning = cpuState?.level === 'warning';
      add('CPU', sys.cpu != null ? `${sys.cpu}%` : null, cpuState?.pending ? 'confirmando saturación sostenida' : cpuCritical ? 'nivel crítico sostenido' : cpuWarning ? 'carga alta en observación' : 'carga actual', cpuCritical ? 'critical' : cpuWarning ? 'warning' : '');
      add('Temperatura', sys.cpuTemp != null ? `${sys.cpuTemp}°C` : null, sys.cpuTemp >= 75 ? 'vigilar refrigeración' : 'dentro del umbral', sys.cpuTemp >= 85 ? 'critical' : sys.cpuTemp >= 75 ? 'warning' : '');
      add('RAM disponible', sys.memAvailGB != null ? `${sys.memAvailGB} GB` : null, `${sys.memUsedGB ?? '--'} GB en uso`);
      add('Swap', sys.swapUsedPct != null ? `${sys.swapUsedPct}%` : 'No configurada', sys.swapTotalMB ? `${sys.swapUsedMB}/${sys.swapTotalMB} MB usados` : '');
    } else if (anchor === 'sec-files') {
      const files = state.publicFiles || [];
      add('Archivos', files.length || '--', 'inventario del área privada'); add('Caducidad', 'Administrada', 'duración predeterminada privada');
      add('Origen', 'Registrado', 'IP y navegador por subida'); add('Borrado', 'Automático', 'salvo que el administrador lo detenga');
    } else if (anchor === 'sec-net') {
      add('Descarga', io.net ? `${io.net.rxKBs} KB/s` : null, `${io.net?.ifaces?.length || 0} interfaces detectadas`);
      add('Subida', io.net ? `${io.net.txKBs} KB/s` : null, 'tráfico actual');
      add('Lectura de disco', io.disk ? `${io.disk.readKBs} KB/s` : null, `${io.disk?.readIOPS || 0} IOPS`);
      add('Escritura de disco', io.disk ? `${io.disk.writeKBs} KB/s` : null, `${io.disk?.writeIOPS || 0} IOPS`);
    } else if (anchor === 'sec-visitors') {
      const active = visitors.active || [];
      add('Dispositivos activos', active.length, 'último minuto'); add('Sesiones en ventana', visitors.total || 0, 'últimos 5 minutos');
      add('Solicitudes activas', active.reduce((n, v) => n + (v.requests || 0), 0), 'desde los dispositivos activos'); add('Ruta más reciente', active[0]?.lastUri || '/', active[0]?.device || 'sin actividad');
    } else if (anchor === 'sec-gateway') {
      add('Gateway', oc.gatewayOk ? 'Conectado' : 'Sin respuesta', oc.healthLatencyMs != null ? `${oc.healthLatencyMs} ms de latencia` : '', oc.gatewayOk ? '' : 'critical');
      add('Sesiones', oc.sessionsActive ?? 0, 'activas ahora'); add('Tareas', oc.tasks ?? '--', 'en ejecución'); add('Memoria', oc.memMB != null ? `${oc.memMB} MB` : '--', `PID ${oc.pid || '--'}`);
    } else if (anchor === 'sec-infra') {
      const services = state.services || [], active = services.filter((s) => s.state === 'active').length, smart = state.smart?.devices || [];
      add('Servicios activos', `${active}/${services.length || '--'}`, 'unidades supervisadas'); add('Contenedores', state.docker?.count ?? '--', state.docker?.available ? 'Docker disponible' : 'Docker no disponible');
      add('Discos SMART', smart.length || '--', smart.some((d) => d.health === 'failed') ? 'requiere atención' : 'salud conocida'); add('Alertas', (state.alerts || []).length, 'umbrales del servidor');
    } else if (anchor === 'sec-media') {
      add('Reproductor', state.player?.state === 'play' ? 'Reproduciendo' : state.player?.state === 'pause' ? 'En pausa' : 'Detenido', state.player?.title || 'sin pista');
      add('Volumen', state.player?.volume != null ? `${state.player.volume}%` : '--', state.player?.random ? 'modo aleatorio activo' : 'modo normal'); add('Bluetooth', state.bluetooth?.connected ? 'Conectado' : 'Sin conexión', state.bluetooth?.name || '');
    } else if (anchor === 'sec-procs') {
      const top = (state.processes || [])[0]; add('Procesos visibles', (state.processes || []).length, 'ordenados por CPU'); add('Mayor consumo', top ? `${top.name} · ${top.cpu}%` : '--', top ? `${top.memRssMB} MB RSS` : '');
      add('RAM del sistema', sys.memUsed != null ? `${sys.memUsed}%` : '--', `${sys.memAvailGB ?? '--'} GB disponibles`); add('CPU del sistema', sys.cpu != null ? `${sys.cpu}%` : '--', 'muestra actual');
    } else if (anchor === 'sec-actions') {
      add('Confirmación', 'Requerida', 'las acciones operativas usan el modal del panel'); add('Bitácora', 'Activa', 'resultado y fecha de cada operación'); add('Borrado de archivos', 'Disponible', 'gestión pública con caducidad');
    } else if (anchor === 'sec-sessions') {
      add('Sesiones activas', oc.sessionsActive ?? 0, 'reportadas por el gateway'); add('Uptime', sys.uptime != null ? `${Math.floor(sys.uptime / 3600)} h` : '--', sys.hostname || '');
      add('Modelo', state.models?.primary?.split('/').pop() || '--', 'gateway principal'); add('Swap', sys.swapUsedPct != null ? `${sys.swapUsedPct}%` : '--', 'uso actual');
    }
    panel.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = title; panel.appendChild(heading);
    const grid = document.createElement('div'); grid.className = 'insights-grid';
    facts.forEach((f) => { const item = document.createElement('div'); item.className = `insight ${f.tone}`; const k = document.createElement('span'); k.textContent = f.label; const v = document.createElement('strong'); v.textContent = f.value; const n = document.createElement('small'); n.textContent = f.note; item.append(k, v, n); grid.appendChild(item); });
    panel.appendChild(grid);
  },
};
