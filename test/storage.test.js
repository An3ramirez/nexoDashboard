'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStorage, RETENTION_MS } = require('../storage');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-sqlite-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { databasePath: path.join(dir, 'catalog.sqlite'), legacyFilesPath: path.join(dir, 'index.json'), legacySamplesPath: path.join(dir, 'samples.jsonl') };
  const state = { dir, paths, now: 1800000000000 };
  state.open = () => {
    const store = openStorage({ ...paths, now: () => state.now, ...options });
    t.after(() => { try { store.close(); } catch {} });
    return store;
  };
  return state;
}
const file = { id: 'a'.repeat(36), name: 'test.deb', size: 4, createdAt: 1800000000000, expiresAt: 1800000060000, persistent: false, persistenceKeyId: null, uploader: { ip: 'test-only', userAgent: 'test' } };
const key = { id: 'b'.repeat(16), hash: 'c'.repeat(64), label: 'prueba', createdAt: 1800000000000, revokedAt: null };
const snapshot = () => ({ files: [{ ...file }], persistenceKeys: [{ ...key }], cleanupEnabled: false, defaultTtlMinutes: 1440 });

test('migra catálogo sin modificar JSON/binarios y no lo reimporta al reiniciar', t => {
  const f = fixture(t);
  const raw = JSON.stringify(snapshot());
  fs.writeFileSync(f.paths.legacyFilesPath, raw);
  fs.writeFileSync(path.join(f.dir, `${file.id}.bin`), 'data');
  let db = f.open();
  assert.deepEqual(db.loadSnapshot(), snapshot());
  assert.equal(fs.readFileSync(f.paths.legacyFilesPath, 'utf8'), raw);
  assert.equal(fs.readFileSync(`${f.paths.legacyFilesPath}.pre-sqlite.bak`, 'utf8'), raw);
  assert.equal(fs.readFileSync(path.join(f.dir, `${file.id}.bin`), 'utf8'), 'data');
  const changed = snapshot(); changed.files[0].persistent = true; changed.files[0].expiresAt = null; changed.persistenceKeys[0].revokedAt = f.now; changed.defaultTtlMinutes = 15;
  db.saveSnapshot(changed); db.close();
  db = f.open();
  assert.deepEqual(db.loadSnapshot(), changed);
  assert.equal(fs.statSync(f.paths.databasePath).mode & 0o777, 0o600);
});

test('transacción revierte archivos, claves y configuración al fallar', t => {
  const f = fixture(t); const db = f.open(); db.saveSnapshot(snapshot());
  const invalid = snapshot(); invalid.files = []; invalid.cleanupEnabled = true;
  invalid.persistenceKeys.push({ ...key, id: 'different', hash: key.hash });
  assert.throws(() => db.saveSnapshot(invalid));
  assert.deepEqual(db.loadSnapshot(), snapshot());
  const deleted = snapshot(); deleted.files = []; deleted.persistenceKeys = [];
  db.saveSnapshot(deleted); db.close();
  assert.deepEqual(f.open().loadSnapshot(), deleted);
});

test('catálogo corrupto falla cerrado y permite reintento después de repararlo', t => {
  const f = fixture(t); fs.writeFileSync(f.paths.legacyFilesPath, '{broken');
  assert.throws(() => f.open());
  assert.equal(fs.readFileSync(f.paths.legacyFilesPath, 'utf8'), '{broken');
  fs.writeFileSync(f.paths.legacyFilesPath, JSON.stringify(snapshot()));
  assert.deepEqual(f.open().loadSnapshot(), snapshot());
});

test('migración inválida no queda marcada ni pierde filas al reintentar', t => {
  const f = fixture(t); const invalid = snapshot(); invalid.files.push({ id: 'invalid' });
  fs.writeFileSync(f.paths.legacyFilesPath, JSON.stringify(invalid));
  assert.throws(() => f.open(), /ID de archivo/);
  fs.writeFileSync(f.paths.legacyFilesPath, JSON.stringify(snapshot()));
  assert.deepEqual(f.open().loadSnapshot(), snapshot());
});

test('historial importa 180 días exactos, conserva original y limpia por tiempo', t => {
  const f = fixture(t);
  const rows = [
    { t: f.now - RETENTION_MS - 1, cpu: 1, ram: 2 },
    { t: f.now - RETENTION_MS, cpu: 3, ram: 4 },
    { t: f.now - 90 * 86400000, cpu: 5, ram: 6 },
    { t: f.now, cpu: 7, ram: 8 },
  ];
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(f.paths.legacySamplesPath, text);
  const db = f.open();
  assert.deepEqual(db.getSamples().map(row => ({ ...row })), rows.slice(1));
  assert.equal(fs.readFileSync(f.paths.legacySamplesPath, 'utf8'), text);
  assert.equal(fs.readFileSync(`${f.paths.legacySamplesPath}.pre-sqlite.bak`, 'utf8'), text);
  f.now += 1; db.prune();
  assert.deepEqual(db.getSamples().map(row => ({ ...row })), rows.slice(2));
  db.close();
  assert.deepEqual(f.open().getSamples().map(row => ({ ...row })), rows.slice(2));
});

test('inserción idempotente, retención configurable y rangos agregados', t => {
  const f = fixture(t, { retentionDays: 30 }); const db = f.open();
  const base = f.now - 50000;
  db.appendSample({ t: base, cpu: 20, ram: 40 });
  db.appendSample({ t: base + 1, cpu: 40, ram: 60 });
  db.appendSample({ t: base + 1, cpu: 60, ram: 80 });
  db.appendSample({ t: f.now - 31 * 86400000, cpu: 100, ram: 90 });
  assert.equal(db.getSamples().length, 2);
  const series = db.getHistory(base, 86400000);
  assert.equal(series.samples, 2);
  assert.equal(series.points.length, 1);
  assert.equal(series.points[0].cpu, 40);
  assert.equal(series.points[0].ram, 60);
  assert.equal(db.retentionDays, 30);
});

test('rechaza muestras y retención inválidas', t => {
  const f = fixture(t); const db = f.open();
  assert.throws(() => db.appendSample({ t: f.now, cpu: NaN, ram: 2 }));
  assert.throws(() => db.appendSample({ t: 'bad', cpu: 1, ram: 2 }));
  assert.throws(() => db.getHistory(f.now, 0));
  assert.equal(db.getSamples().length, 0);
  assert.throws(() => openStorage({ ...f.paths, retentionDays: 0 }), /Retención inválida/);
});

test('consulta de seis meses conserva rango completo y limita puntos', t => {
  const f = fixture(t); const db = f.open();
  for (let day = 0; day <= 180; day++) db.appendSample({ t: f.now - day * 86400000, cpu: day % 100, ram: 50 });
  const result = db.getHistory(f.now - RETENTION_MS, Math.ceil(RETENTION_MS / 399));
  assert.equal(result.samples, 181);
  assert.ok(result.points.length <= 400);
  assert.equal(result.points[0].t, f.now - RETENTION_MS);
  assert.equal(result.points.at(-1).t, f.now);
});

test('catálogo de aplicaciones se conserva en SQLite y no se sobrescribe al guardar archivos', t => {
  const f = fixture(t); const db = f.open();
  const apps = [{ id: 'nas', name: 'NAS', url: 'https://casa.corposoft.net' }];
  assert.deepEqual(db.getApplications(apps), apps);
  db.saveSnapshot(snapshot()); db.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getApplications([{ id: 'different' }]), apps);
  assert.deepEqual(reopened.loadSnapshot(), snapshot());
});
