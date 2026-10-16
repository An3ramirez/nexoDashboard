'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthMonitor } = require('../health');
const normal = { cpu:20, memUsed:30, diskUsedPct:30, cpuTemp:55, swapUsedPct:0, swapTotalMB:2048 };
function advance(monitor, patch, from, to) {
  let result;
  for (let at = from; at <= to; at += 2000) result = monitor.evaluate({ ...normal, ...patch }, at);
  return result;
}
const rule = (result, key) => result.rules.find(item => item.key === key);
test('CPU requiere diez minutos continuos; un pico no activa rojo', () => {
  const monitor = createHealthMonitor();
  const early = advance(monitor, { cpu:100 }, 0, 598000);
  assert.equal(early.level, 'warning'); assert.equal(rule(early,'cpu').pending, true);
  assert.equal(monitor.evaluate({ ...normal, cpu:100 },600000).level, 'critical');
});
test('CPU que baja antes del plazo reinicia la confirmación', () => {
  const monitor = createHealthMonitor();
  advance(monitor, { cpu:100 }, 0, 598000);
  monitor.evaluate({ ...normal, cpu:99 },600000);
  const result = monitor.evaluate({ ...normal, cpu:100 },602000);
  assert.equal(result.level,'warning'); assert.equal(rule(result,'cpu').pendingMs,0);
});
test('RAM supera 80% diez segundos; 80% exacto no dispara', () => {
  const monitor = createHealthMonitor();
  assert.equal(advance(monitor,{memUsed:81},0,8000).level,'warning');
  assert.equal(monitor.evaluate({...normal,memUsed:81},10000).level,'critical');
  const exact = createHealthMonitor();
  assert.equal(advance(exact,{memUsed:80},0,20000).level,'good');
});
test('recuperación estable e histéresis evitan parpadeos del estado crítico', () => {
  const monitor = createHealthMonitor();
  advance(monitor,{memUsed:81},0,10000);
  assert.equal(advance(monitor,{memUsed:74},12000,40000).level,'critical');
  assert.equal(monitor.evaluate({...normal,memUsed:74},42000).level,'good');
  assert.equal(monitor.evaluate({...normal,memUsed:81},44000).level,'warning');
});
test('huecos de telemetría no cuentan como periodo alto ni como recuperación', () => {
  const monitor = createHealthMonitor();
  advance(monitor,{cpu:100},0,598000);
  const resumed = monitor.evaluate({...normal,cpu:100},620000);
  assert.equal(resumed.level,'warning'); assert.equal(rule(resumed,'cpu').pendingMs,0);
  const ram = createHealthMonitor(); advance(ram,{memUsed:81},0,10000);
  assert.equal(ram.evaluate({...normal,memUsed:null},12000).level,'unknown');
  assert.equal(ram.evaluate({...normal,memUsed:81},14000).level,'critical');
});
test('CPU y RAM se evalúan por separado y no avanzan con timestamps duplicados', () => {
  const monitor = createHealthMonitor();
  const result = advance(monitor,{cpu:100,memUsed:81},0,10000);
  assert.equal(rule(result,'ram').level,'critical'); assert.equal(rule(result,'cpu').level,'warning');
  assert.deepEqual(monitor.evaluate(normal,10000),result);
});
test('temperatura requiere sesenta segundos y un sensor ausente no es cero', () => {
  const monitor = createHealthMonitor();
  assert.equal(advance(monitor,{cpuTemp:86},0,58000).level,'warning');
  assert.equal(monitor.evaluate({...normal,cpuTemp:86},60000).level,'critical');
  assert.equal(rule(monitor.evaluate({...normal,cpuTemp:null},62000),'temperature').value,null);
});
