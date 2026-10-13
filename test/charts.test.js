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
