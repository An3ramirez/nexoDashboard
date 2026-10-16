'use strict';

// Compartido por el servidor: recargar la página no reinicia los periodos.
const RULES = [
  { key:'cpu', field:'cpu', label:'CPU', unit:'%', warn:85, critical:100, holdMs:600000, recovery:85 },
  { key:'ram', field:'memUsed', label:'RAM', unit:'%', warn:80, critical:80, exclusive:true, holdMs:10000, recovery:75 },
  { key:'temperature', field:'cpuTemp', label:'Temperatura', unit:'°C', warn:75, critical:85, holdMs:60000, recovery:80 },
  { key:'disk', field:'diskUsedPct', label:'Disco', unit:'%', warn:85, critical:95, holdMs:60000, recovery:90 },
  { key:'swap', field:'swapUsedPct', label:'Swap', unit:'%', warn:75, critical:90, holdMs:60000, recovery:75 },
];
function createHealthMonitor({ maxGapMs = 15000, recoveryMs = 30000 } = {}) {
  const states = new Map();
  let lastAt = null, lastResult = null;
  function evaluate(sample, now = Date.now()) {
    if (lastAt !== null && now <= lastAt) return lastResult;
    const gap = lastAt !== null && now - lastAt > maxGapMs;
    lastAt = now;
    const rules = RULES.map(rule => {
      const state = states.get(rule.key) || { since:null, recovering:null, confirmed:false };
      states.set(rule.key, state);
      const raw = rule.key === 'swap' && !(sample.swapTotalMB > 0) ? null : sample[rule.field];
      const value = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
      if (gap || value === null) { state.since = null; state.recovering = null; }
      const high = value !== null && (rule.exclusive ? value > rule.critical : value >= rule.critical);
      if (high) {
        state.recovering = null;
        if (state.since === null) state.since = now;
        if (now - state.since >= rule.holdMs) state.confirmed = true;
      } else {
        state.since = null;
        if (state.confirmed && value !== null && value < rule.recovery) {
          if (state.recovering === null) state.recovering = now;
          if (now - state.recovering >= recoveryMs) { state.confirmed = false; state.recovering = null; }
        } else state.recovering = null;
      }
      const warning = value !== null && (rule.exclusive ? value > rule.warn : value >= rule.warn);
      const pendingMs = state.since === null ? 0 : now - state.since;
      const level = value === null ? 'unknown' : state.confirmed ? 'critical' : warning ? 'warning' : 'good';
      const duration = rule.holdMs >= 60000 ? `${rule.holdMs / 60000} min` : `${rule.holdMs / 1000} s`;
      const message = level === 'unknown' ? `${rule.label}: sin datos` : state.confirmed
        ? `${rule.label}: nivel crítico confirmado${state.recovering !== null ? ' · verificando recuperación' : ''}`
        : high ? `${rule.label}: confirmando ${Math.floor(pendingMs / 1000)} s / ${duration}`
        : warning ? `${rule.label}: nivel alto bajo observación` : `${rule.label}: normal`;
      return { key:rule.key, label:rule.label, value, unit:rule.unit, level, pending:high && !state.confirmed, pendingMs, requiredMs:rule.holdMs, recoveryMs, message };
    });
    const missingRequired = rules.some(rule => ['cpu','ram'].includes(rule.key) && rule.level === 'unknown');
    const level = rules.some(rule => rule.level === 'critical') ? 'critical' : missingRequired ? 'unknown' : rules.some(rule => rule.level === 'warning') ? 'warning' : 'good';
    lastResult = { sampledAt:now, level, rules, maxGapMs, recoveryMs };
    return lastResult;
  }
  return { evaluate };
}
module.exports = { createHealthMonitor, RULES };
