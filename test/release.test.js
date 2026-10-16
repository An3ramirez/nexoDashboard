'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('versión semántica coherente en paquete, lock, interfaz y documentación', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const html = fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const versions = [...html.matchAll(/NexoDashboard(?: ·)? v(\d+\.\d+\.\d+)/g)].map(match=>match[1]);
  assert.deepEqual(versions,[pkg.version,pkg.version]);
  const readme = fs.readFileSync(path.join(root,'README.md'),'utf8');
  assert.ok(readme.includes('# NexoDashboard · '+pkg.version));
});
test('capturas y documentos locales enlazados desde README existen', () => {
  const readme = fs.readFileSync(path.join(root,'README.md'),'utf8');
  const targets = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(match=>match[1]).filter(target=>!target.startsWith('#')&&!target.includes('://'));
  assert.ok(targets.filter(target=>target.startsWith('docs/screenshots/')).length>=3);
  for(const target of targets) assert.ok(fs.existsSync(path.join(root,target)),target);
});
