'use strict';

// Metadatos solamente: los binarios grandes permanecen en PUBLIC_FILES_DIR.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const DEFAULT_RETENTION_DAYS = 180;
const RETENTION_MS = DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function openStorage({ databasePath, legacyFilesPath, legacySamplesPath, now = Date.now, retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  if (!databasePath) throw new Error('Falta databasePath');
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('Retención inválida: debe ser de 1 a 3650 días');
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  fs.chmodSync(databasePath, 0o600);
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('La base de datos requiere una versión más nueva del dashboard');
    transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS public_files (
        id TEXT PRIMARY KEY, metadata TEXT NOT NULL,
        expires_at INTEGER, persistent INTEGER NOT NULL CHECK(persistent IN (0,1))
      );
      CREATE INDEX IF NOT EXISTS public_files_expiry ON public_files(persistent, expires_at);
      CREATE TABLE IF NOT EXISTS persistence_keys (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metric_samples (
        timestamp INTEGER PRIMARY KEY, cpu REAL NOT NULL, ram REAL NOT NULL
      );
    `));
    transaction(() => {
      const columns = new Set(db.prepare('PRAGMA table_info(metric_samples)').all().map(row => row.name));
      if (!columns.has('temperature')) db.exec('ALTER TABLE metric_samples ADD COLUMN temperature REAL');
      if (!columns.has('swap')) db.exec('ALTER TABLE metric_samples ADD COLUMN swap REAL');
      db.exec('PRAGMA user_version = 2');
    });

    const hasMigration = (name) => !!db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name);
    const markMigration = (name) => db.prepare('INSERT INTO migrations VALUES (?, ?)').run(name, now());
    function readLegacy(file) {
      if (!file) return null;
      try { return fs.readFileSync(file, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    function backupLegacy(file, content) {
      if (content === null) return;
      // No borrar ni actualizar el original. No sobreescribir copias anteriores.
      try { fs.copyFileSync(file, `${file}.pre-sqlite.bak`, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      fs.chmodSync(`${file}.pre-sqlite.bak`, 0o600);
    }
    const upsertFile = db.prepare(`INSERT INTO public_files VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata, expires_at=excluded.expires_at, persistent=excluded.persistent`);
    const upsertKey = db.prepare(`INSERT INTO persistence_keys VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, metadata=excluded.metadata`);
    const upsertSetting = db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    function saveSnapshot(snapshot, migrationName) {
      if (!Array.isArray(snapshot.files) || !Array.isArray(snapshot.persistenceKeys)) throw new Error('Catálogo inválido');
      transaction(() => {
        const fileIds = new Set();
        for (const file of snapshot.files) {
          if (!/^[a-f0-9]{36}$/.test(String(file.id || '')) || fileIds.has(file.id)) throw new Error('ID de archivo inválido o duplicado');
          fileIds.add(file.id);
          upsertFile.run(file.id, JSON.stringify(file), file.expiresAt ?? null, file.persistent ? 1 : 0);
        }
        for (const row of db.prepare('SELECT id FROM public_files').all()) {
          if (!fileIds.has(row.id)) db.prepare('DELETE FROM public_files WHERE id=?').run(row.id);
        }
        const keyIds = new Set();
        for (const key of snapshot.persistenceKeys) {
          if (!key.id || !/^[a-f0-9]{64}$/i.test(String(key.hash || '')) || keyIds.has(key.id)) throw new Error('Clave persistente inválida o duplicada');
          keyIds.add(key.id);
          upsertKey.run(key.id, key.hash, JSON.stringify(key));
        }
        for (const row of db.prepare('SELECT id FROM persistence_keys').all()) {
          if (!keyIds.has(row.id)) db.prepare('DELETE FROM persistence_keys WHERE id=?').run(row.id);
        }
        upsertSetting.run('cleanupEnabled', JSON.stringify(snapshot.cleanupEnabled !== false));
        upsertSetting.run('defaultTtlMinutes', JSON.stringify(Math.min(1440, Math.max(5, Number(snapshot.defaultTtlMinutes) || 60))));
        if (migrationName) markMigration(migrationName);
      });
    }
    // Una sola transacción incluye importación y marcador. Si falla no queda
    // una migración parcial ni se inicia silenciosamente con inventario vacío.
    if (!hasMigration('public-files-json-v1')) {
      const text = readLegacy(legacyFilesPath);
      const raw = text === null ? { files: [], persistenceKeys: [] } : JSON.parse(text);
      if (!raw || !Array.isArray(raw.files) || (raw.persistenceKeys !== undefined && !Array.isArray(raw.persistenceKeys))) throw new Error('El índice JSON de archivos es inválido');
      backupLegacy(legacyFilesPath, text);
      saveSnapshot({ ...raw, persistenceKeys: raw.persistenceKeys || [] }, 'public-files-json-v1');
    }
    const insertSample = db.prepare(`INSERT INTO metric_samples(timestamp,cpu,ram,temperature,swap) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(timestamp) DO UPDATE SET cpu=excluded.cpu, ram=excluded.ram, temperature=excluded.temperature, swap=excluded.swap`);
    function validateSample(sample) {
      if (!sample || !Number.isSafeInteger(sample.t) || !Number.isFinite(sample.cpu) || !Number.isFinite(sample.ram)) throw new Error('Muestra de historial inválida');
      for (const key of ['temperature','swap']) if (sample[key] != null && !Number.isFinite(sample[key])) throw new Error('Muestra de historial inválida');
    }
    if (!hasMigration('metric-jsonl-v1')) {
      const text = readLegacy(legacySamplesPath);
      const samples = (text || '').split('\n').filter((line) => line.trim()).map((line) => {
        const sample = JSON.parse(line); validateSample(sample); return sample;
      });
      backupLegacy(legacySamplesPath, text);
      transaction(() => {
        for (const sample of samples) if (sample.t >= now() - retentionMs) insertSample.run(sample.t, sample.cpu, sample.ram, sample.temperature ?? null, sample.swap ?? null);
        markMigration('metric-jsonl-v1');
      });
    }
    const prune = () => db.prepare('DELETE FROM metric_samples WHERE timestamp < ?').run(now() - retentionMs);
    prune();
    return {
      databasePath,
      retentionDays,
      saveSnapshot,
      getApplications(defaults) {
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get('applications');
        if (row) return JSON.parse(row.value);
        db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('applications', JSON.stringify(defaults));
        return JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('applications').value);
      },
      loadSnapshot() {
        const setting = (key, fallback) => {
          const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
          return row ? JSON.parse(row.value) : fallback;
        };
        return {
          files: db.prepare('SELECT metadata FROM public_files ORDER BY rowid').all().map((row) => JSON.parse(row.metadata)),
          persistenceKeys: db.prepare('SELECT metadata FROM persistence_keys ORDER BY rowid').all().map((row) => JSON.parse(row.metadata)),
          cleanupEnabled: setting('cleanupEnabled', true), defaultTtlMinutes: setting('defaultTtlMinutes', 60),
        };
      },
      appendSample(sample) {
        validateSample(sample);
        transaction(() => { insertSample.run(sample.t, sample.cpu, sample.ram, sample.temperature ?? null, sample.swap ?? null); prune(); });
      },
      getSamples(since = now() - retentionMs) {
        return db.prepare('SELECT timestamp AS t, cpu, ram FROM metric_samples WHERE timestamp >= ? ORDER BY timestamp').all(Math.max(since, now() - retentionMs));
      },
      getHistory(since, bucketMs, until = now()) {
        if (!Number.isFinite(since) || !Number.isFinite(until) || until < since || !Number.isSafeInteger(bucketMs) || bucketMs <= 0) throw new Error('Rango inválido');
        const cutoff = Math.max(since, now() - retentionMs);
        const samples = db.prepare('SELECT COUNT(*) AS count FROM metric_samples WHERE timestamp >= ? AND timestamp <= ?').get(cutoff, until).count;
        const points = db.prepare(`SELECT MAX(timestamp) AS t, ROUND(AVG(cpu),1) AS cpu, ROUND(AVG(ram),1) AS ram,
          ROUND(AVG(temperature),1) AS temperature, ROUND(AVG(swap),1) AS swap
          FROM metric_samples WHERE timestamp >= ? AND timestamp <= ? GROUP BY CAST(timestamp / ? AS INTEGER) ORDER BY t`).all(cutoff, until, bucketMs);
        return { points, samples };
      },
      prune,
      close: () => db.close(),
    };
  } catch (error) { db.close(); throw error; }
}

let singleton;
function getStorage() {
  if (!singleton) {
    const filesDir = path.resolve(process.env.PUBLIC_FILES_DIR || path.join(__dirname, 'data', 'public-files'));
    singleton = openStorage({
      databasePath: path.resolve(process.env.DASHBOARD_DB_PATH || path.join(filesDir, 'nexodashboard.sqlite')),
      legacyFilesPath: path.join(filesDir, 'index.json'),
      legacySamplesPath: path.join(__dirname, 'data', 'samples.jsonl'),
      retentionDays: process.env.HISTORY_RETENTION_DAYS === undefined ? DEFAULT_RETENTION_DAYS : Number(process.env.HISTORY_RETENTION_DAYS),
    });
  }
  return singleton;
}
module.exports = { openStorage, getStorage, RETENTION_MS, DEFAULT_RETENTION_DAYS };
