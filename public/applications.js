'use strict';
(function () {
  if (location.pathname !== '/apps') return;
  const grid = document.getElementById('appsGrid');
  const search = document.getElementById('appsSearch');
  const status = document.getElementById('appsStatus');
  const categories = document.getElementById('appsCategories');
  const refresh = document.getElementById('appsRefresh');
  let applications = [], category = 'Todas';
  const colors = new Set(['purple', 'blue', 'pink', 'cyan', 'mint', 'coral', 'amber']);
  const brandLogos = new Set(['plane', 'syncthing', 'cockpit']);
  const symbols = { music: 'i-music', vault: 'i-shield', home: 'i-disk', files: 'i-file', openclaw: 'i-zap' };
  function element(tag, className, text) {
    const el = document.createElement(tag); if (className) el.className = className;
    if (text !== undefined) el.textContent = text; return el;
  }
  function logo(app) {
    const mark = element('span', `app-mark apps-color-${colors.has(app.color) ? app.color : 'purple'}`);
    mark.setAttribute('aria-hidden', 'true');
    if (app.logo === 'nexo') {
      const img = document.createElement('img'); img.src = '/app-icon.png'; img.alt = ''; mark.append(img);
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', brandLogos.has(app.logo) ? `/app-logos.svg#${app.logo}` : `#${symbols[app.logo] || 'i-grid'}`);
      svg.append(use); mark.append(svg);
    }
    return mark;
  }
  function safeUrl(raw) {
    try {
      const url = new URL(raw);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch { return null; }
  }
  function render() {
    const query = search.value.trim().toLocaleLowerCase('es');
    const shown = applications.filter(app => (category === 'Todas' || app.category === category) && `${app.name} ${app.description} ${app.url} ${app.category}`.toLocaleLowerCase('es').includes(query));
    grid.replaceChildren();
    for (const app of shown) {
      const url = safeUrl(app.url); if (!url) continue;
      const card = element('a', 'app-card');
      card.href = url.href; card.target = '_blank'; card.rel = 'noopener noreferrer';
      card.setAttribute('aria-label', `Abrir ${app.name} en una nueva pestaña`);
      const top = element('div', 'app-card-top');
      const arrow = element('span', 'app-launch-arrow', '↗'); arrow.setAttribute('aria-hidden', 'true');
      top.append(logo(app), element('span', 'app-category', app.category), arrow);
      const domain = element('span', 'app-domain', url.host + (url.pathname === '/' ? '' : url.pathname));
      const footer = element('div', 'app-card-footer');
      footer.append(domain, element('span', 'app-open-label', 'Abrir aplicación →'));
      card.append(top, element('h2', '', app.name), element('p', 'app-description', app.description), footer);
      grid.append(card);
    }
    status.textContent = shown.length ? `${shown.length} de ${applications.length} aplicaciones` : 'No hay aplicaciones que coincidan con tu búsqueda.';
    categories.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.textContent === category)));
  }
  async function load() {
    refresh.disabled = true; status.textContent = 'Cargando aplicaciones…';
    try {
      const response = await fetch('/api/applications');
      if (!response.ok) throw new Error('No se pudo cargar el catálogo. Revisa tu sesión e inténtalo otra vez.');
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.applications)) throw new Error('El catálogo tiene un formato inválido.');
      applications = data.applications.filter(app => app && typeof app.name === 'string' && typeof app.description === 'string' && typeof app.category === 'string' && safeUrl(app.url));
      const names = ['Todas', ...new Set(applications.map(app => app.category))];
      if (!names.includes(category)) category = 'Todas';
      categories.replaceChildren();
      for (const name of names) {
        const button = element('button', 'apps-filter', name); button.type = 'button';
        button.addEventListener('click', () => { category = name; render(); }); categories.append(button);
      }
      document.getElementById('appsTotal').textContent = `${applications.length} aplicaciones · ${names.length - 1} categorías`;
      render();
    } catch (error) { status.textContent = error.message; }
    finally { refresh.disabled = false; }
  }
  search.addEventListener('input', render); refresh.addEventListener('click', load); load();
})();
