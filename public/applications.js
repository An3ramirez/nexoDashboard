'use strict';
(function () {
  if (location.pathname !== '/apps') return;
  const grid = document.getElementById('appsGrid');
  const search = document.getElementById('appsSearch');
  const status = document.getElementById('appsStatus');
  const categories = document.getElementById('appsCategories');
  const refresh = document.getElementById('appsRefresh');
  let applications = [], category = 'Todas', loading=false, busyId=null, pending=null, loadFailed=false;
  const messages=new Map();
  const states={active:['Activo','good'],stopped:['Detenido','off'],failed:['Con fallo','off'],partial:['Parcial','warning'],degraded:['Degradado','warning'],transitioning:['En transición','warning'],reachable:['Responde HTTP','good'],unreachable:['No disponible','off'],unknown:['Sin verificar','unknown'],unconfigured:['Sin configurar','unknown']};
  const dialog=element('dialog','app-control-dialog');
  dialog.setAttribute('aria-labelledby','appControlTitle');
  const dialogTitle=element('h2','', 'Confirmar operación'); dialogTitle.id='appControlTitle';
  const dialogCopy=element('p');
  const dialogActions=element('div','app-dialog-actions');
  const cancel=element('button','btn-ghost','Cancelar'); cancel.type='button';
  const confirm=element('button','app-control-button','Confirmar'); confirm.type='button';
  dialogActions.append(cancel,confirm); dialog.append(dialogTitle,dialogCopy,dialogActions); document.body.append(dialog);
  cancel.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{pending=null;});
  confirm.addEventListener('click',()=>{const selected=pending;dialog.close();if(selected) control(selected.app,selected.action);});
  function ask(app,action) {
    if (busyId || dialog.open) return;
    pending={app,action};
    dialogTitle.textContent=`${action==='start'?'Iniciar':'Detener'} ${app.name}`;
    dialogCopy.textContent=action==='stop'?'Se interrumpirá el acceso de los usuarios y las tareas en curso de esta aplicación. ¿Quieres detener su servicio?':'Se iniciarán los componentes asociados a esta aplicación. Puede tardar un momento en estar disponible.';
    confirm.textContent=action==='start'?'Iniciar servicio':'Detener servicio';
    dialog.showModal(); cancel.focus();
  }
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
    refresh.disabled=loading || !!busyId;
    const focused=document.activeElement;
    const restoreFocus=grid.contains(focused)?{id:focused.closest('.app-card')?.dataset.appId,label:focused.getAttribute('aria-label')}:null;
    const query = search.value.trim().toLocaleLowerCase('es');
    const shown = applications.filter(app => (category === 'Todas' || app.category === category) && `${app.name} ${app.description} ${app.url} ${app.category}`.toLocaleLowerCase('es').includes(query));
    grid.replaceChildren();
    for (const app of shown) {
      const url = safeUrl(app.url); if (!url) continue;
      const card = element('article', 'app-card');
      card.dataset.appId=app.id;
      const top = element('div', 'app-card-top');
      const arrow = element('a', 'app-launch-arrow', '↗'); arrow.href=url.href;arrow.target='_blank';arrow.rel='noopener noreferrer';arrow.setAttribute('aria-label',`Abrir acceso a ${app.name}`);
      top.append(logo(app), element('span', 'app-category', app.category), arrow);
      const domain = element('span', 'app-domain', url.host + (url.pathname === '/' ? '' : url.pathname));
      const footer = element('div', 'app-card-footer');
      const open=element('a','app-open-label','Abrir aplicación ↗');
      open.href=url.href; open.target='_blank'; open.rel='noopener noreferrer'; open.setAttribute('aria-label',`Abrir ${app.name} en una nueva pestaña`);
      const service=app.service || {state:'unknown',reason:'Esperando comprobación.'};
      const state=loadFailed ? ['Sin actualizar','unknown'] : states[service.state] || states.unknown;
      const live=element('div','app-service-line');
      const badge=element('span',`app-service-badge app-service-${busyId===app.id?'warning':state[1]}`,busyId===app.id?'Procesando…':state[0]);
      const checked=element('span','app-service-time',service.checkedAt?`Revisado ${new Date(service.checkedAt).toLocaleTimeString('es-CO',{hour12:false})}`:'');
      if(service.total>1) checked.textContent+=` · ${service.active}/${service.total} activos`;
      live.append(badge,checked);
      const explanation=element('p','app-service-reason',service.reason || '');
      const actions=element('div','app-service-actions');
      for(const action of ['start','stop']) {
        const button=element('button',`app-control-button ${action==='stop'?'app-control-stop':''}`,action==='start'?'Iniciar':'Detener');
        button.type='button'; button.disabled=!!busyId || loadFailed || !(action==='start'?service.canStart:service.canStop);
        button.setAttribute('aria-label',`${action==='start'?'Iniciar':'Detener'} ${app.name}`);
        button.addEventListener('click',()=>ask(app,action)); actions.append(button);
      }
      const result=messages.get(app.id);
      footer.append(domain,open);
      card.append(top, element('h2', '', app.name), element('p', 'app-description', app.description),live,explanation,actions);
      if(result) {const message=element('p',`app-operation-result ${result.error?'app-operation-error':''}`,result.text); message.setAttribute('role',result.error?'alert':'status');card.append(message);}
      card.append(footer);
      grid.append(card);
    }
    status.textContent = loadFailed?'No se pudo actualizar el estado. Los controles están desactivados hasta volver a comprobarlo.':shown.length ? `${shown.length} de ${applications.length} aplicaciones · estados actualizados cada 15 s` : 'No hay aplicaciones que coincidan con tu búsqueda.';
    categories.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.textContent === category)));
    if(restoreFocus && !dialog.open) {
      const replacement=[...grid.querySelectorAll('button,a')].find(node=>node.closest('.app-card')?.dataset.appId===restoreFocus.id && node.getAttribute('aria-label')===restoreFocus.label);
      if(replacement && !replacement.disabled) replacement.focus({preventScroll:true});
    }
  }
  async function load(background=false) {
    if(loading || busyId) return;
    loading=true; refresh.disabled = true; if(!background) status.textContent = 'Comprobando aplicaciones…';
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),12000);
    try {
      const response = await fetch('/api/applications',{signal:controller.signal});
      if (!response.ok) throw new Error('No se pudo cargar el catálogo. Revisa tu sesión e inténtalo otra vez.');
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.applications)) throw new Error('El catálogo tiene un formato inválido.');
      applications = data.applications.filter(app => app && typeof app.name === 'string' && typeof app.description === 'string' && typeof app.category === 'string' && safeUrl(app.url));
      loadFailed=false;
      const names = ['Todas', ...new Set(applications.map(app => app.category))];
      if (!names.includes(category)) category = 'Todas';
      categories.replaceChildren();
      for (const name of names) {
        const button = element('button', 'apps-filter', name); button.type = 'button';
        button.addEventListener('click', () => { category = name; render(); }); categories.append(button);
      }
      document.getElementById('appsTotal').textContent = `${applications.length} aplicaciones · ${names.length - 1} categorías`;
      render();
    } catch (error) { loadFailed=true;render(); if(!applications.length) status.textContent = error.name==='AbortError'?'La comprobación tardó demasiado. Reintenta actualizar.':error.message; }
    finally { clearTimeout(timer);loading=false;refresh.disabled = !!busyId; }
  }
  async function control(app,action) {
    if(busyId) return;
    busyId=app.id; messages.delete(app.id);render();
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),75000);
    try {
      const response=await fetch(`/api/applications/${encodeURIComponent(app.id)}/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,confirm:true}),signal:controller.signal});
      const data=await response.json().catch(()=>({ok:false,error:`Respuesta inesperada del servidor (HTTP ${response.status}). Comprueba el estado antes de reintentar.`}));
      if(!response.ok || !data.ok) throw new Error(data.error || 'No se pudo completar la operación.');
      const current=applications.find(item=>item.id===app.id); if(current && data.service) current.service=data.service;
      messages.set(app.id,{text:data.message || 'Orden completada.'});
    } catch(error) {messages.set(app.id,{error:true,text:error.name==='AbortError'?'No llegó confirmación. Comprueba el estado antes de reintentar.':error.message || 'Error de conexión; comprueba el estado antes de reintentar.'});}
    finally {clearTimeout(timer);busyId=null; render(); await load(true);}
  }
  search.addEventListener('input', render); refresh.addEventListener('click',()=>load()); load();
  setInterval(()=>{if(!document.hidden && !dialog.open) load(true);},15000);
})();
