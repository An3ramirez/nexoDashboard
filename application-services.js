'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { execFile } = require('node:child_process');

// Perfil del servidor comprobado en modo lectura. No detiene proxies compartidos.
const docker = name => ({type:'docker',name,sudo:true});
const DEFAULT_BINDINGS = {
  vault:{targets:[docker('vaultwarden')]},
  plane:{targets:['plane-db','plane-redis','plane-minio','plane-api','plane-worker','plane-beat','plane-web','plane-admin','plane-space','plane-live','plane-proxy'].map(docker)},
  openclaw:{targets:[{type:'systemd',unit:'openclaw-gateway.service',scope:'user'}]},
  cockpit:{targets:[{type:'systemd',unit:'cockpit.service',sudo:true,optional:true},{type:'systemd',unit:'cockpit.socket',sudo:true}]},
  player:{probe:{port:80,path:'/player/'},reason:'Comparte Nginx/PHP con otros sitios. Sin control independiente configurado.'},
  syncthing:{probe:{port:8384,path:'/'},reason:'Configura su unidad o contenedor para habilitar el control.'},
  casa:{reason:'No se ha identificado el servicio del NAS. La ruta publicada coincidía con Plane; no se usará su puerto como prueba del NAS.'},
};
const PROTECTED_UNITS = new Set(['nexodashboard.service','nginx.service','docker.service','ssh.service','sshd.service']);
function validateBindings(bindings) {
  if (!bindings || typeof bindings!=='object' || Array.isArray(bindings) || Object.keys(bindings).length>32) throw new Error('Configuración de servicios inválida');
  for (const [id,binding] of Object.entries(bindings)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || ['dashboard','files'].includes(id) || !binding || typeof binding!=='object') throw new Error('Aplicación de servicio inválida');
    const targets=binding.targets || [];
    if (!Array.isArray(targets) || targets.length>16) throw new Error('Demasiados objetivos');
    for (const target of targets) {
      if (!target || typeof target!=='object' || (target.sudo!==undefined && typeof target.sudo!=='boolean') || (target.optional!==undefined && typeof target.optional!=='boolean')) throw new Error('Objetivo inválido');
      if (target.type==='docker') {
        if (typeof target.name!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target.name) || target.scope!==undefined) throw new Error('Contenedor inválido');
      } else if (target.type==='systemd') {
        if (typeof target.unit!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,180}\.(service|socket)$/.test(target.unit) || PROTECTED_UNITS.has(target.unit) || ![undefined,'system','user'].includes(target.scope) || (target.scope==='user' && target.sudo)) throw new Error('Unidad inválida o protegida');
      } else throw new Error('Tipo de servicio inválido');
    }
    if (targets.length && targets.every(target=>target.optional)) throw new Error('Falta un objetivo obligatorio');
    if (binding.probe && (!Number.isInteger(binding.probe.port) || binding.probe.port<1 || binding.probe.port>65535 || !/^\/[a-zA-Z0-9/_.-]*$/.test(binding.probe.path || ''))) throw new Error('Sonda local inválida');
  }
  return bindings;
}
function readBindings() {
  return validateBindings(process.env.APP_SERVICES_CONFIG ? JSON.parse(fs.readFileSync(process.env.APP_SERVICES_CONFIG,'utf8')) : DEFAULT_BINDINGS);
}
function runCommand(file,args,{scope,timeout=5000}={}) {
  const env={...process.env};
  if (scope==='user') {
    env.XDG_RUNTIME_DIR=env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
    env.DBUS_SESSION_BUS_ADDRESS=env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  }
  return new Promise(resolve=>execFile(file,args,{timeout,maxBuffer:65536,env},(error,stdout,stderr)=>resolve({ok:!error,stdout:String(stdout || ''),stderr:String(stderr || '')})));
}
function probeLocal({port,path}) {
  return new Promise(resolve=>{
    const request=http.get({host:'127.0.0.1',port,path,timeout:2000,agent:false},response=>{
      const code=response.statusCode;
      response.destroy();
      resolve({state:code<400 || code===401 || code===403 ? 'reachable':'unreachable',code});
    });
    request.on('timeout',()=>request.destroy());
    request.on('error',()=>resolve({state:'unreachable'}));
  });
}
function targetKey(target) { return `${target.type}:${target.scope || 'system'}:${target.unit || target.name}`; }
function createApplicationServices({bindings=readBindings(),run=runCommand,probe=probeLocal,audit=()=>{},now=Date.now}={}) {
  validateBindings(bindings);
  const cache=new Map(), inFlight=new Map(), locks=new Set(), attempts=new Map();
  function command(target,args,timeout) {
    const program=target.type==='docker'?'docker':'systemctl';
    return run(target.sudo?'sudo':program,target.sudo?['-n','--',program,...args]:args,{scope:target.scope,timeout});
  }
  async function inspect(target) {
    if (target.type==='docker') {
      const result=await command(target,['inspect','--format','{{json .State}}','--',target.name],4000);
      if (!result.ok) return {state:'unknown'};
      try {
        const value=JSON.parse(result.stdout);
        return {state:value.Restarting ? 'transitioning' : value.Paused ? 'degraded' : value.Running ? value.Health?.Status==='unhealthy'?'degraded':'active':'stopped'};
      } catch { return {state:'unknown'}; }
    }
    const args=[...(target.scope==='user'?['--user']:[]),'show','--property=LoadState,ActiveState','--',target.unit];
    const result=await command(target,args,4000);
    const properties=Object.fromEntries(result.stdout.trim().split('\n').map(line=>line.split('=')));
    if (!result.ok || properties.LoadState!=='loaded') return {state:'unknown'};
    return {state:properties.ActiveState==='active'?'active':properties.ActiveState==='failed'?'failed':properties.ActiveState==='inactive'?'stopped':['activating','deactivating','reloading'].includes(properties.ActiveState)?'transitioning':'unknown'};
  }
  async function collect(id) {
    const checkedAt=now();
    if (['dashboard','files'].includes(id)) return {state:'active',checkedAt,canStart:false,canStop:false,reason:'Comparte el proceso de este dashboard. Control protegido para no perder acceso.'};
    const binding=bindings[id];
    if (!binding) return {state:'unconfigured',checkedAt,canStart:false,canStop:false,reason:'Servicio no asociado. Configura su unidad o contenedor en el servidor.'};
    const targets=binding.targets || [];
    if (!targets.length) {
      const result=binding.probe ? await probe(binding.probe) : {state:'unconfigured'};
      return {state:result.state,checkedAt,canStart:false,canStop:false,reason:binding.reason || 'Solo comprobación HTTP local; sin control configurado.',source:binding.probe?'http':'none'};
    }
    const results=await Promise.all(targets.map(inspect));
    const required=results.filter((_,index)=>!targets[index].optional);
    const states=required.map(result=>result.state);
    const state=states.includes('unknown')?'unknown':states.includes('transitioning')?'transitioning':states.every(s=>s==='active')?'active':states.every(s=>s==='stopped')?'stopped':states.every(s=>['stopped','failed'].includes(s))?'failed':states.includes('degraded')?'degraded':'partial';
    return {state,checkedAt,canStart:['stopped','failed','partial'].includes(state),canStop:['active','degraded','partial'].includes(state),source:'service',active:states.filter(s=>s==='active').length,total:states.length,reason:state==='unknown'?'No se pudo verificar: revisa nombres, herramientas y permisos del servicio.':state==='transitioning'?'El servicio está cambiando de estado.':state==='failed'?'systemd informa de un fallo. Revisa los registros antes de iniciar de nuevo.':'Estado del proceso; no garantiza que la aplicación responda correctamente.'};
  }
  async function status(id,{fresh=false}={}) {
    const previous=cache.get(id);
    if (!fresh && previous && now()-previous.checkedAt<10000) return previous;
    if (!inFlight.has(id)) inFlight.set(id,collect(id).then(result=>{cache.set(id,result);return result;}).finally(()=>inFlight.delete(id)));
    return inFlight.get(id);
  }
  async function control(id,action) {
    if (!['start','stop'].includes(action)) throw Object.assign(new Error('Acción inválida'),{status:400});
    if (['dashboard','files'].includes(id)) throw Object.assign(new Error('Servicio protegido: no puedes detener el propio dashboard.'),{status:403});
    const targets=bindings[id]?.targets || [];
    if (!targets.length) throw Object.assign(new Error('Esta aplicación no tiene control independiente configurado.'),{status:409});
    const keys=targets.map(targetKey);
    if (keys.some(key=>locks.has(key))) throw Object.assign(new Error('Ya hay una operación sobre este servicio.'),{status:409});
    const recent=(attempts.get(id) || []).filter(time=>now()-time<60000);
    if (recent.length>=6) throw Object.assign(new Error('Demasiadas operaciones. Espera un minuto.'),{status:429});
    attempts.set(id,[...recent,now()]); keys.forEach(key=>locks.add(key));
    try {
      const before=await status(id,{fresh:true});
      if (!(action==='start'?before.canStart:before.canStop)) throw Object.assign(new Error('El estado actual no permite esta operación. Actualiza la tarjeta.'),{status:409});
      const deadline=now()+60000;
      for (const target of action==='stop'?[...targets].reverse():targets) {
        const remaining=deadline-now();
        if (remaining<=0) throw Object.assign(new Error('La operación superó el tiempo máximo; comprueba el estado de los componentes antes de reintentar.'),{status:504});
        const args=target.type==='docker'?[action,...(action==='stop'?['--time','10']:[]),'--',target.name]:[...(target.scope==='user'?['--user']:[]),action,'--',target.unit];
        const result=await command(target,args,Math.min(20000,remaining));
        if (!result.ok) throw Object.assign(new Error('La operación no se completó. Revisa permisos y registros; algunos componentes podrían haber cambiado de estado.'),{status:502});
      }
      audit(`App ${id}: ${action}`,true,'Orden completada');
      cache.delete(id);
      return {service:await status(id,{fresh:true}),message:'Orden completada. Comprueba el estado actualizado.'};
    } catch (error) { audit(`App ${id}: ${action}`,false,error.message); cache.delete(id); throw error; }
    finally {keys.forEach(key=>locks.delete(key));}
  }
  return {status,control};
}
module.exports={createApplicationServices,validateBindings,DEFAULT_BINDINGS};
