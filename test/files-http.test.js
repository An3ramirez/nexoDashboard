'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('HTTP: migración, subida, persistencia, reinicio y descarga con SQLite', { timeout: 30000 }, async t => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-http-sqlite-'));
  const filesDir = path.join(dir, 'uploads');
  fs.mkdirSync(filesDir);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.copyFileSync(path.join(root, 'public', 'ambient-contours.svg'), path.join(dir, 'public', 'ambient-contours.svg'));
  fs.copyFileSync(path.join(root, 'public', 'login.html'), path.join(dir, 'public', 'login.html'));
  fs.copyFileSync(path.join(root, 'public', 'files.html'), path.join(dir, 'public', 'files.html'));
  fs.copyFileSync(path.join(root, 'public', 'chart-tooltip.js'), path.join(dir, 'public', 'chart-tooltip.js'));
  fs.copyFileSync(path.join(root, 'public', 'nexo-music-cover.png'), path.join(dir, 'public', 'nexo-music-cover.png'));
  fs.copyFileSync(path.join(root, 'public', 'transfer-cover-v2.png'), path.join(dir, 'public', 'transfer-cover-v2.png'));
  for (const file of ['index.js', 'extras.js', 'storage.js', 'applications.js', 'health.js']) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ password: 'sqlite-test-only' }));
  fs.writeFileSync(path.join(dir, 'data', 'checks.json'), '[]');
  const legacyId = 'e'.repeat(36);
  fs.writeFileSync(path.join(filesDir, `${legacyId}.bin`), 'legacy');
  fs.writeFileSync(path.join(filesDir, 'index.json'), JSON.stringify({ files: [{ id: legacyId, name: 'legacy.txt', size: 6, createdAt: Date.now(), expiresAt: null, persistent: true }], persistenceKeys: [], defaultTtlMinutes: 5, cleanupEnabled: true }));
  fs.writeFileSync(path.join(dir, 'data', 'samples.jsonl'), JSON.stringify({ t: Date.now() - 90 * 86400000, cpu: 10, ram: 20 }) + '\n');
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  async function start() {
    child = spawn(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(port), PUBLIC_FILES_DIR: filesDir, DASHBOARD_DB_PATH: path.join(filesDir, 'test.sqlite'), HISTORY_RETENTION_DAYS: '180' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Timeout de arranque de la aplicación de prueba')), 12000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`La aplicación de prueba terminó: ${output}`)); });
      child.stdout.on('data', bytes => { output += bytes; if (output.includes('NexoDashboard on')) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', bytes => { output += bytes; });
    });
  }
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function json(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), response };
  }
  async function login() {
    const result = await json('/api/login', 'POST', { password: 'sqlite-test-only' });
    assert.equal(result.status, 200); cookie = result.response.headers.get('set-cookie').split(';')[0];
  }
  await start();
  const loginPage = await fetch(base + '/login');
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.ok(loginHtml.includes('Recursos públicos'));
  assert.ok(loginHtml.includes('Próximamente, más recursos'));
  assert.equal((loginHtml.match(/class="login-public-link(?:\s[^"]*)?"/g) || []).length, 2);
  assert.ok(loginHtml.includes('Transferencia de archivos'));
  assert.ok(loginHtml.includes('href="/files"'));
  assert.equal((await fetch(base + '/files')).status, 200);
  assert.ok(loginHtml.includes('href="https://corposoft.net/player/"'));
  assert.ok(loginHtml.includes('Nexo Music'));
  assert.ok(loginHtml.includes('Escuchar gratis'));
  assert.ok(!loginHtml.includes('PHP'));
  const musicCover = await fetch(base + '/nexo-music-cover.png');
  assert.equal(musicCover.status, 200);
  assert.ok(musicCover.headers.get('content-type').includes('image/png'));
  assert.ok(loginHtml.includes('src="/transfer-cover-v2.png"'));
  const transferCoverV2 = await fetch(base + '/transfer-cover-v2.png');
  assert.equal(transferCoverV2.status, 200);
  assert.ok(transferCoverV2.headers.get('content-type').includes('image/png'));
  const background = await fetch(base + '/ambient-contours.svg');
  assert.equal(background.status, 200);
  assert.ok(background.headers.get('content-type').includes('image/svg+xml'));
  assert.equal((await json('/api/applications')).status, 401);
  assert.equal((await json('/api/public-files')).data.files.length, 1);
  await login();
  const chartTooltip = await fetch(base+'/chart-tooltip.js', {headers:{Cookie:cookie}});
  assert.equal(chartTooltip.status,200);
  assert.ok(chartTooltip.headers.get('content-type').includes('javascript'));
  assert.ok((await chartTooltip.text()).includes('NexoChartTooltip'));
  const catalog = await json('/api/applications');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.applications.length, 9);
  assert.equal(catalog.data.availabilityChecked, false);
  assert.equal(catalog.data.applications.find(app => app.id === 'casa').name, 'Casa · NAS');
  const history = await json('/api/history?range=180d');
  assert.equal(history.data.range, '180d'); assert.equal(history.data.retentionDays, 180);
  for (const [range, duration] of Object.entries({'15m':900000,'1h':3600000,'6h':21600000,'24h':86400000,'7d':604800000,'30d':2592000000,'90d':7776000000,'180d':15552000000})) {
    const result = await json(`/api/history?range=${range}`);
    assert.equal(result.status,200); assert.equal(result.data.range,range);
    assert.equal(result.data.window.end-result.data.window.start,duration);
    assert.ok(result.data.points.length <= 400);
  }
  assert.ok(history.data.samples >= 1);
  assert.ok((await json('/api/history?range=24h')).data.samples < history.data.samples);
  const upload = await fetch(base + '/api/public-files', { method: 'POST', headers: { 'X-File-Name': 'sample.deb' }, body: Buffer.from('sqlite-upload') });
  assert.equal(upload.status, 201); const uploaded = (await upload.json()).file;
  assert.equal(uploaded.size, 13);
  const generated = await json('/api/public-files/keys', 'POST', { label: 'test key' });
  assert.equal(generated.status, 201);
  const persisted = await json(`/api/public-files/${uploaded.id}/persistence`, 'PUT', { persistent: true, key: generated.data.key.value });
  assert.equal(persisted.status, 200); assert.equal(persisted.data.file.expiresAt, null);
  await stop(); cookie = ''; await start();
  const inventory = await json('/api/public-files');
  assert.equal(inventory.data.files.length, 2);
  assert.equal(inventory.data.files.find(file => file.id === uploaded.id).persistent, true);
  assert.equal(await (await fetch(base + `/files/${uploaded.id}`)).text(), 'sqlite-upload');
  assert.equal(await (await fetch(base + `/files/${legacyId}`)).text(), 'legacy');
  assert.equal(JSON.parse(fs.readFileSync(path.join(filesDir, 'index.json'))).files.length, 1);
  await login();
  assert.deepEqual((await json('/api/applications')).data.applications, catalog.data.applications);
  const removed = await json(`/api/public-files/${uploaded.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await fetch(base + `/files/${uploaded.id}`)).status, 404);
  assert.equal((await json('/api/logout', 'POST')).status, 200);
  assert.equal((await json('/api/applications')).status, 401);
});
