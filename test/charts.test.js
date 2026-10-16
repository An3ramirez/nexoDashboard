'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const start = source.indexOf('        function drawSeriesChart(');
const end = source.indexOf('        function renderMetricCharts()', start);
function node(name) {
  return { name, attrs: {}, children: [], textContent: '', setAttribute(key, value) { this.attrs[key] = String(value); }, getAttribute(key) { return this.attrs[key]; }, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } };
}
const context = vm.createContext({ document: { createElementNS: (_, name) => node(name) } });
vm.runInContext(source.slice(start, end), context);
function chart(width = 320) {
  const svg = node('svg'); svg.setAttribute('viewBox', '0 0 300 140');
  svg.getBoundingClientRect = () => ({ width, height: 140 });
  return svg;
}
test('ejes con escala 0–100, unidad y hora:minuto:segundo', () => {
  const svg = chart();
  context.drawSeriesChart(svg, [{ values: [20, 40], color: 'blue' }], 100, [{ t: 1800000000000 }, { t: 1800000010000 }]);
  const labels = svg.children.filter(child => child.name === 'text').map(child => child.textContent);
  assert.ok(labels.includes('%')); assert.ok(labels.includes('100')); assert.ok(labels.includes('0'));
  assert.equal(labels.filter(label => /^\d{2}:\d{2}:\d{2}$/.test(label)).length, 3);
  assert.ok(svg.children.some(child => child.attrs.class === 'chart-rule'));
});
test('posición horizontal proporcional al tiempo real, no al índice', () => {
  const svg = chart();
  context.drawSeriesChart(svg, [{ values: [20, 40, 60], color: 'blue' }], 100, [{ t: 100000 }, { t: 101000 }, { t: 110000 }]);
  const line = svg.children.find(child => child.name === 'path' && child.attrs.fill === 'none').attrs.d;
  const xs = [...line.matchAll(/[ML]([\d.]+),/g)].map(match => Number(match[1]));
  assert.ok(Math.abs((xs[1] - xs[0]) / (xs[2] - xs[0]) - 0.1) < 0.001);
});
test('rango de varios días añade fechas y muestra unidad de transferencia', () => {
  const svg = chart(600);
  context.drawSeriesChart(svg, [{ values: [0, 1536], color: 'blue' }], null, [{ t: 1800000000000 }, { t: 1800000000000 + 2 * 86400000 }], 'KB/s');
  const labels = svg.children.filter(child => child.name === 'text').map(child => child.textContent);
  assert.ok(labels.includes('KB/s'));
  assert.ok(labels.some(label => /^\d{2}\/\d{2}\/\d{2}$/.test(label)));
  assert.ok(labels.filter(label => /^\d{2}:\d{2}:\d{2}$/.test(label)).length <= 6);
});
test('sin muestras no inventa tiempo ni valores; muestra el estado vacío', () => {
  const svg = chart(); context.drawSeriesChart(svg, [{ values: [], color: 'blue' }], 100, []);
  assert.equal(svg.children.filter(child => child.name === 'path').length, 0);
  assert.ok(svg.children.some(child => child.textContent === 'Esperando muestras'));
});
test('ventana de una hora permanece completa aunque solo haya un minuto de muestras', () => {
  const svg = chart();
  context.drawSeriesChart(svg,[{values:[30,40],color:'blue'}],100,[{t:3540000},{t:3600000}],'%',{start:0,end:3600000});
  const path = svg.children.find(child => child.name === 'path' && child.attrs.fill === 'none').attrs.d;
  const firstX = Number(path.match(/M([\d.]+),/)[1]);
  assert.ok(firstX > 295, 'Los datos recientes quedan al final, no se estiran a toda la hora');
});
test('el rango seleccionado muestra ejes incluso sin muestras y no dibuja ceros falsos', () => {
  const svg = chart();
  context.drawSeriesChart(svg,[{values:[null,null],color:'orange'}],110,[{t:0},{t:3600000}],'°C',{start:0,end:3600000});
  assert.equal(svg.children.filter(child => child.name === 'path').length,0);
  assert.equal(svg.children.filter(child => /^\d{2}:\d{2}:\d{2}$/.test(child.textContent)).length,3);
});
test('sensores ausentes y huecos largos no se unen con líneas inventadas', () => {
  const svg = chart();
  context.drawSeriesChart(svg,[{values:[60,null,70,72],color:'orange'}],110,[{t:0},{t:60000},{t:120000},{t:600000}],'°C',{start:0,end:3600000});
  const paths = svg.children.filter(child => child.name === 'path' && child.attrs.fill === 'none');
  assert.equal(paths.length,3);
  assert.ok(paths.every(child => !child.attrs.d.includes('L')));
});
test('hasta 24 horas los ejes omiten la fecha, incluso cruzando medianoche', () => {
  for (const duration of [3600000,86400000]) {
    const svg = chart();
    context.drawSeriesChart(svg,[{values:[30,40],color:'blue'}],100,[{t:0},{t:duration}],'%',{start:0,end:duration});
    const labels = svg.children.filter(child=>child.name==='text').map(child=>child.textContent);
    assert.ok(!labels.some(label=>/^\d{2}\/\d{2}\/\d{2}$/.test(label)));
    assert.equal(labels.filter(label=>/^\d{2}:\d{2}:\d{2}$/.test(label)).length,3);
  }
});
test('etiqueta inferior usa solo horas hasta 24 h y conserva fechas en varios días', () => {
  const wrap = {textContent:''};
  const labelsContext = vm.createContext({document:{querySelector:()=>wrap}});
  const labelStart = source.indexOf('        function setRangeLabels(');
  const labelEnd = source.indexOf('        function activeSeries(',labelStart);
  vm.runInContext(source.slice(labelStart,labelEnd),labelsContext);
  for(const duration of [3600000,86400000]) {
    labelsContext.setRangeLabels('cpu',[],{start:1800000000000,end:1800000000000+duration});
    assert.match(wrap.textContent,/^\d{2}:\d{2}:\d{2} → \d{2}:\d{2}:\d{2} ·/);
  }
  labelsContext.setRangeLabels('cpu',[],{start:1800000000000,end:1800000000000+7*86400000});
  assert.ok(!/^\d{2}:/.test(wrap.textContent));
});
