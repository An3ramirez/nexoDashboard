'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createApplicationServices,validateBindings}=require('../application-services');
const {registerApplicationRoutes}=require('../applications');
const target=name=>({type:'docker',name});
function fixture(bindings={vault:{targets:[target('vaultwarden')]}}) {
  const calls=[],audit=[],running=new Set(); let clock=1000, fail=null;
  const run=async(file,args,options)=>{
    calls.push({file,args,options});
    const command=file==='sudo'?args[2]:file;
    const flags=file==='sudo'?args.slice(3):args;
    const name=flags.at(-1);
    if (fail?.(command,flags)) return {ok:false,stdout:'',stderr:'sensitive diagnostic'};
    if (command==='systemctl') return {ok:true,stdout:'LoadState=loaded\nActiveState=active\n'};
    if (flags[0]==='inspect') return {ok:true,stdout:JSON.stringify({Running:running.has(name)})};
    if (flags[0]==='start') running.add(name);
    if (flags[0]==='stop') running.delete(name);
    return {ok:true,stdout:''};
  };
  const services=createApplicationServices({bindings,run,now:()=>clock,audit:(...row)=>audit.push(row)});
  return {services,calls,audit,running,setTime:value=>clock=value,setFail:fn=>fail=fn};
}
test('rechaza comandos, unidades protegidas, sondas remotas y configuraciones inseguras',()=>{
  for(const bad of [
    {vault:{targets:[target('vault; reboot')]}},
    {vault:{targets:[{type:'shell',name:'whoami'}]}},
    {vault:{targets:[{type:'systemd',unit:'nginx.service'}]}},
    {dashboard:{targets:[target('dashboard')]}},
    {vault:{targets:[{type:'systemd',unit:'-evil.service'}]}},
    {vault:{targets:[{type:'systemd',unit:'app.service',scope:'user',sudo:true}]}},
    {vault:{probe:{port:80,path:'http://external.test'}}},
    {vault:{targets:[{...target('vault'),optional:true}]}}
  ]) assert.throws(()=>validateBindings(bad));
});
test('consulta estados cacheados, detecta grupos parciales y separa procesos de sondas HTTP',async()=>{
  const f=fixture({plane:{targets:[target('db'),target('api')]}});
  f.running.add('db');
  assert.equal((await f.services.status('plane')).state,'partial');
  assert.equal((await f.services.status('plane')).canStart,true);
  assert.equal(f.calls.length,2);
  f.setTime(12000);f.running.add('api');
  assert.equal((await f.services.status('plane')).state,'active');
  const probe=createApplicationServices({bindings:{player:{probe:{port:80,path:'/player/'}}},probe:async()=>({state:'reachable'}),run:()=>{throw Error('No ejecutar comandos');}});
  assert.equal((await probe.status('player')).state,'reachable');
  assert.equal((await probe.status('player')).canStop,false);
  assert.equal((await probe.status('casa')).state,'unconfigured');
});
test('inicia y detiene solo objetivos asociados, respeta orden inverso y registra auditoría',async()=>{
  const f=fixture({plane:{targets:[target('db'),target('api')]}});
  const started=await f.services.control('plane','start');
  assert.equal(started.service.state,'active');
  assert.deepEqual(f.calls.filter(call=>call.args[0]==='start').map(call=>call.args.at(-1)),['db','api']);
  const stopped=await f.services.control('plane','stop');
  assert.equal(stopped.service.state,'stopped');
  assert.deepEqual(f.calls.filter(call=>call.args[0]==='stop').map(call=>call.args.at(-1)),['api','db']);
  assert.equal(f.audit.length,2);
  assert.ok(f.audit.every(row=>row[1]===true));
});
test('protege el dashboard, rechaza acciones arbitrarias y bloquea estados sin verificar',async()=>{
  const f=fixture();
  await assert.rejects(f.services.control('dashboard','stop'),error=>error.status===403);
  await assert.rejects(f.services.control('files','stop'),error=>error.status===403);
  await assert.rejects(f.services.control('vault','restart'),error=>error.status===400);
  await assert.rejects(f.services.control('casa','stop'),error=>error.status===409);
  f.setFail(()=>true);
  assert.equal((await f.services.status('vault')).state,'unknown');
  await assert.rejects(f.services.control('vault','start'),error=>error.status===409);
  assert.ok(!f.calls.some(call=>call.args[0]==='start'));
});
test('permiso denegado conserva el estado real y no filtra stderr a la respuesta',async()=>{
  const f=fixture(); f.running.add('vaultwarden');f.setFail((_,args)=>args[0]==='stop');
  await assert.rejects(f.services.control('vault','stop'),error=>error.status===502 && !error.message.includes('sensitive'));
  assert.equal((await f.services.status('vault')).state,'active');
  assert.equal(f.audit[0][1],false);
});
test('dos peticiones simultáneas no ejecutan dos órdenes sobre el mismo objetivo',async()=>{
  const f=fixture();
  const first=f.services.control('vault','start');
  await assert.rejects(f.services.control('vault','start'),error=>error.status===409);
  await first;
  assert.equal(f.calls.filter(call=>call.args[0]==='start').length,1);
});
test('socket activo y servicio cockpit opcional inactivo no producen un falso estado parcial',async()=>{
  const calls=[];
  const services=createApplicationServices({bindings:{cockpit:{targets:[{type:'systemd',unit:'cockpit.service',optional:true},{type:'systemd',unit:'cockpit.socket'}]}},run:async(file,args)=>{calls.push(args);return {ok:true,stdout:`LoadState=loaded\nActiveState=${args.at(-1).endsWith('.socket')?'active':'inactive'}`};}});
  assert.equal((await services.status('cockpit')).state,'active');
  assert.ok(calls.every(args=>args.includes('--')));
});
test('ruta de control exige confirmación, JSON, mismo origen e ID del catálogo',async()=>{
  const routes=new Map();let calls=0;
  registerApplicationRoutes({get(){},post(path,...handlers){routes.set(path,handlers.at(-1));}},{getApplications:()=>[{id:'vault'}]},{services:{control:async()=>{calls++;return {service:{state:'active'}};}}});
  const handler=routes.get('/api/applications/:id/control');
  async function request({body={action:'start',confirm:true},id='vault',origin,site,type=true}={}) {
    const req={params:{id},body,is:()=>type,get:key=>({host:'dashboard.test',origin,'sec-fetch-site':site})[key]};
    const res={code:200,status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
    await handler(req,res);return res;
  }
  assert.equal((await request({body:{action:'start'}})).code,400);
  assert.equal((await request({body:{action:'start',confirm:true,unit:'ssh.service'}})).code,400);
  assert.equal((await request({origin:'https://evil.test'})).code,403);
  assert.equal((await request({site:'cross-site'})).code,403);
  assert.equal((await request({type:false})).code,400);
  assert.equal((await request({id:'not-listed'})).code,404);
  assert.equal(calls,0);
  assert.equal((await request({origin:'https://dashboard.test'})).code,200);
  assert.equal(calls,1);
});
test('sudo usa argumentos separados y nunca solicita contraseña interactiva',async()=>{
  const f=fixture({vault:{targets:[{...target('vaultwarden'),sudo:true}]}});
  await f.services.control('vault','start');
  assert.ok(f.calls.every(call=>call.file==='sudo' && call.args.slice(0,3).join(' ')==='-n -- docker'));
  assert.equal(f.running.has('vaultwarden'),true);
});
test('límite de seis órdenes por minuto evita repeticiones ilimitadas',async()=>{
  const f=fixture();
  for(let i=0;i<6;i++) await f.services.control('vault',i%2?'stop':'start');
  await assert.rejects(f.services.control('vault','start'),error=>error.status===429);
  f.setTime(62000);
  await f.services.control('vault','start');
});
test('el bloqueo se comparte entre dos apps que apuntan al mismo objetivo',async()=>{
  const f=fixture({one:{targets:[target('shared')]},two:{targets:[target('shared')]}});
  const first=f.services.control('one','start');
  await assert.rejects(f.services.control('two','start'),error=>error.status===409);
  await first;
});
test('systemd failed no se oculta como una parada normal y permite iniciar',async()=>{
  const services=createApplicationServices({bindings:{syncthing:{targets:[{type:'systemd',unit:'syncthing.service'}]}},run:async()=>({ok:true,stdout:'LoadState=loaded\nActiveState=failed'})});
  const status=await services.status('syncthing');
  assert.equal(status.state,'failed');assert.equal(status.canStart,true);assert.equal(status.canStop,false);
});
