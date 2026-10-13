'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/page.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const pages = ['/overview','/apps','/performance','/network','/visitors','/gateway','/infrastructure','/media','/processes','/actions','/sessions'];
function runPage(route, headerId = 'topbar') {
  function element(id, tagName = 'DIV') {
    const classes = new Set();
    return { id, tagName, dataset: {}, nextElementSibling: null, classes,
      classList: { add: value => classes.add(value), toggle: (value, on) => on ? classes.add(value) : classes.delete(value) },
      matches: selector => selector === '.topbar' && tagName === 'HEADER' };
  }
  const header = element(headerId, 'HEADER');
  const children = [header, element('health-summary')];
  for (const id of ['sec-overview','sec-perf','sec-quick','sec-apps','sec-files','sec-net','sec-visitors','sec-gateway','sec-infra','sec-media','sec-procs','sec-actions','sec-sessions']) {
    const head = element(id); const content = element(''); head.nextElementSibling = content; children.push(head, content);
  }
  children.push(element('', 'FOOTER'));
  const main = { children, insertBefore() {} };
  const document = { title: '', querySelector: () => main, querySelectorAll: () => [], getElementById: id => children.find(node => node.id === id) };
  vm.runInNewContext(source, { document, location: { pathname: route } });
  return { header, children, title: document.title };
}
test('cabecera permanece visible después de inicializar las once vistas', () => {
  assert.match(html, /<header[^>]*id="topbar"/);
  assert.match(html, /id="logoutBtn"[^>]*aria-label="Cerrar sesión"/);
  for (const route of pages) {
    const result = runPage(route);
    assert.equal(result.header.classes.has('page-hidden'), false, route);
    assert.ok(result.children.some(node => node.classes.has('page-hidden')), 'Se siguen ocultando secciones ajenas');
  }
});
test('cabecera también se conserva por clase si desaparece su ID', () => {
  for (const route of pages) assert.equal(runPage(route, '').header.classes.has('page-hidden'), false, route);
});
