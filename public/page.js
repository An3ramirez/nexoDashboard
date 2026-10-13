/* Vistas del dashboard: una URL por área, sin duplicar el estado en vivo. */
'use strict';
(function () {
  // El estilo inicial de .reveal tiene opacidad 0. No había un observador que
  // añadiera .in, así que las secciones quedaban invisibles aunque recibieran
  // telemetría. Activarlas al cargar mantiene visibles todas las páginas.
  document.querySelectorAll('.reveal').forEach((element) => element.classList.add('in'));

  const page = ({ '/': 'overview', '/overview': 'overview', '/apps': 'apps', '/performance': 'performance', '/network': 'network', '/visitors': 'visitors', '/gateway':'gateway', '/infrastructure':'infrastructure', '/media':'media', '/processes':'processes', '/actions':'actions', '/sessions':'sessions' })[location.pathname] || 'overview';
  const paths = { overview:'/overview', apps:'/apps', performance:'/performance', network:'/network', visitors:'/visitors', gateway:'/gateway', infrastructure:'/infrastructure', media:'/media', processes:'/processes', actions:'/actions', sessions:'/sessions' };
  const keep = {
    overview: ['sec-overview', 'sec-perf', 'sec-quick'],
    apps: ['sec-apps'],
    performance: ['sec-files'], network: ['sec-net'], visitors: ['sec-visitors'],
    gateway: ['sec-gateway'], infrastructure: ['sec-infra'], media: ['sec-media'],
    processes: ['sec-procs'], actions: ['sec-actions'], sessions: ['sec-sessions'],
  }[page];
  const main = document.querySelector('.main-col');
  const visible = new Set(['topbar']);
  if (page === 'overview') { visible.add('sec-overview'); visible.add('health-summary'); }
  keep.forEach((id) => {
    const head = document.getElementById(id);
    if (!head) return;
    visible.add(id);
    const next = head.nextElementSibling;
    if (next) { next.dataset.pageFor = id; visible.add(`for:${id}`); }
  });
  Array.from(main.children).forEach((node) => {
    const id = node.id;
    const isVisible = node.matches('.topbar') || visible.has(id) || visible.has(`for:${node.dataset.pageFor}`) || node.tagName === 'FOOTER';
    node.classList.toggle('page-hidden', !isVisible);
  });
  // El resumen debe responder primero a “¿cómo está el servidor?”. Por eso las
  // gráficas de rendimiento preceden a las acciones rápidas en esta vista.
  if (page === 'overview') {
    const performance = document.getElementById('sec-perf');
    const performanceGrid = performance?.nextElementSibling;
    const quick = document.getElementById('sec-quick');
    if (performance && performanceGrid && quick) {
      main.insertBefore(performance, quick);
      main.insertBefore(performanceGrid, quick);
    }
  }
  document.querySelectorAll('[data-page]').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
    button.addEventListener('click', () => { location.href = paths[button.dataset.page] || '/overview'; });
  });
  document.title = ({ overview:'Resumen', apps:'Aplicaciones', performance:'Archivos', network:'Red y discos', visitors:'Visitantes', gateway:'Gateway', infrastructure:'Infraestructura', media:'Multimedia', processes:'Procesos', actions:'Acciones', sessions:'Sesiones' })[page] + ' · NexoDashboard';
})();
