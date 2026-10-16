'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {pointsFor,nearestPoint}=require('../public/chart-tooltip');

test('tooltip selecciona muestra real por tiempo y no por índice',()=>{
  const points=[{t:1000,index:0},{t:2000,index:1},{t:10000,index:2}];
  assert.equal(nearestPoint(points,2500).index,1);
  assert.equal(nearestPoint(points,-100).index,0);
  assert.equal(nearestPoint(points,12000).index,2);
  assert.equal(nearestPoint(points,5000,1000),null);
  assert.equal(nearestPoint([],0),null);
});
test('tooltip conserva ceros, ignora lecturas ausentes y respeta la ventana',()=>{
  const config={start:100,end:300,samples:[{t:0},{t:100},{t:200},{t:300},{t:400}],tracks:[{values:[5,null,0,null,9]},{values:[5,null,null,70,9]}]};
  assert.deepEqual(pointsFor(config),[{t:200,index:2},{t:300,index:3}]);
});

function fixture() {
  const handlers={};
  function element(name) {
    const el={name,attrs:{},children:[],style:{},textContent:'',offsetWidth:130,offsetHeight:60,
      setAttribute(k,v){this.attrs[k]=String(v);},appendChild(child){child.parent=this;this.children.push(child);},
      replaceChildren(){this.children=[];},remove(){this.parent.children=this.parent.children.filter(child=>child!==this);},
      getBoundingClientRect(){return {left:0,top:0,width:320,height:140};},
      querySelectorAll(){return this.children.filter(child=>child.attrs['data-chart-hover']);}
    };
    return el;
  }
  const wrap=element('div'); wrap.querySelector=()=>null;
  const svg=element('svg'); svg.dataset={chart:'history'}; svg.closest=()=>wrap;
  svg.addEventListener=(name,handler)=>{assert.ok(!handlers[name],'No duplica listeners');handlers[name]=handler;};
  const window={};
  const document={createElement:element,createElementNS:(_,name)=>element(name)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/chart-tooltip.js'),'utf8'),{window,document,Intl});
  const config={start:1000,end:11000,w:320,h:140,pad:{left:52,right:14,top:18,bottom:27},max:100,unit:'%',samples:[{t:1000},{t:6000},{t:11000}],tracks:[{label:'CPU',color:'blue',values:[0,20,40]},{label:'RAM',color:'orange',values:[30,null,50]}]};
  return {api:window.NexoChartTooltip,svg,wrap,handlers,config};
}
test('puntero muestra hora y todas las series; salir/Escape oculta; redibujar no duplica listeners',()=>{
  const f=fixture(); f.api.attach(f.svg,f.config);
  const tip=f.svg._nexoTooltip.tip;
  f.handlers.pointermove({clientX:179,clientY:70});
  assert.equal(tip.style.display,'block');
  assert.match(tip.children[0].textContent,/^\d{2}:\d{2}:\d{2}$/);
  assert.equal(tip.children[1].textContent,'CPU: 20 %');
  assert.equal(tip.children[2].textContent,'RAM: Sin datos');
  assert.equal(f.svg.querySelectorAll().length,2);
  f.config.tracks[0].values[1]=25;
  f.api.attach(f.svg,f.config);
  assert.equal(tip.children[1].textContent,'CPU: 25 %');
  f.handlers.pointerleave();
  assert.equal(tip.style.display,'none');
  assert.equal(f.svg.querySelectorAll().length,0);
  const key=key=>f.handlers.keydown({key,preventDefault(){}});
  key('Home'); assert.equal(tip.children[1].textContent,'CPU: 0 %');
  key('ArrowRight'); assert.equal(tip.children[1].textContent,'CPU: 25 %');
  key('End'); assert.equal(tip.children[2].textContent,'RAM: 50 %');
  key('Escape'); assert.equal(tip.style.display,'none');
});
test('área sin muestras, huecos largos y rango vacío no muestran tooltip',()=>{
  const f=fixture();
  f.config.end=3601000;
  f.api.attach(f.svg,f.config);
  f.handlers.pointermove({clientX:179,clientY:70});
  assert.equal(f.svg._nexoTooltip.tip.style.display,'none');
  f.config.samples=[]; f.config.tracks.forEach(track=>track.values=[]);
  f.api.attach(f.svg,f.config);
  f.handlers.keydown({key:'Home',preventDefault(){}});
  assert.equal(f.svg._nexoTooltip.tip.style.display,'none');
});
