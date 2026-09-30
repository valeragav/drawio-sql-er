'use strict';

// Сервер для Docker (scripts/server.js): draw.io, плагин и API чтения схемы.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../scripts/server');
const { humanError } = require('../bridge/errors');

// Мини-«draw.io»: index.html, PostConfig.js и служебная папка, которую нельзя отдавать.
function fakeDrawio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.mkdirSync(path.join(dir, 'WEB-INF'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>draw.io</html>');
  fs.writeFileSync(path.join(dir, 'js', 'PostConfig.js'), 'window.ICONSEARCH_PATH = null;');
  fs.writeFileSync(path.join(dir, 'WEB-INF', 'google_client_secret'), 'secret');
  fs.writeFileSync(path.join(os.tmpdir(), 'outside.txt'), 'outside');
  return dir;
}

async function withServer(options, fn) {
  const server = createServer(Object.assign({ drawioDir: fakeDrawio(), log: () => {} }, options));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

const post = (base, body) => fetch(base + '/sql-er/api/introspect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

test('сервер: draw.io, PostConfig с подгрузкой плагина, плагин, пустой service worker', async () => {
  await withServer({}, async base => {
    const index = await fetch(base + '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.equal(await index.text(), '<html>draw.io</html>');

    const config = await (await fetch(base + '/js/PostConfig.js')).text();
    assert.match(config, /^window\.ICONSEARCH_PATH = null;/, 'исходные настройки draw.io сохранены');
    assert.match(config, /window\.SQL_ER_API = 'sql-er\/api';/);
    assert.match(config, /mxscript\('sql-er\/sql-er-plugin\.js/);

    const plugin = await fetch(base + '/sql-er/sql-er-plugin.js');
    assert.equal(plugin.status, 200);
    assert.match(await plugin.text(), /Draw\.loadPlugin/);

    const sw = await (await fetch(base + '/service-worker.js')).text();
    assert.match(sw, /unregister/);

    assert.equal((await fetch(base + '/healthz')).status, 200);
  });
});

test('сервер: не отдаёт файлы вне папки draw.io и служебные WEB-INF / META-INF', async () => {
  await withServer({}, async base => {
    assert.equal((await fetch(base + '/WEB-INF/google_client_secret')).status, 404);
    assert.equal((await fetch(base + '/web-inf/google_client_secret')).status, 404);
    assert.equal((await fetch(base + '/js/../WEB-INF/google_client_secret')).status, 404);
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/..%5coutside.txt']) {
      const res = await fetch(base + p);
      assert.notEqual(res.status, 200, p);
      assert.notEqual(await res.text(), 'outside', p);
    }
    assert.equal((await fetch(base + '/nope.js')).status, 404);
    assert.equal((await fetch(base + '/', { method: 'DELETE' })).status, 405);
  });
});

test('API: схема из базы, проверка запроса, понятные ошибки', async () => {
  const calls = [];
  const introspect = async (url, schemas) => {
    calls.push([url, schemas]);
    if (url.includes('bad')) throw Object.assign(new Error('password authentication failed'), { code: '28P01' });
    if (url.includes('localhost')) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return { sql: 'CREATE TABLE t (id INT);', tables: 1, warnings: [] };
  };
  await withServer({ introspect, inDocker: true }, async base => {
    let res = await post(base, { url: 'postgres://u:p@db:5432/app', schemas: ['public'] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sql: 'CREATE TABLE t (id INT);', tables: 1, warnings: [] });
    assert.deepEqual(calls[0], ['postgres://u:p@db:5432/app', ['public']]);

    res = await post(base, { url: 'postgres://u:bad@db/app', schemas: ['public'] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'Неверный пользователь или пароль');

    res = await post(base, { url: 'postgres://u@localhost/app', schemas: ['public'] });
    assert.match((await res.json()).error, /host\.docker\.internal/, 'подсказка про localhost в Docker');

    assert.equal((await post(base, { url: 'mysql://x', schemas: ['public'] })).status, 400);
    assert.equal((await post(base, { url: 'postgres://x', schemas: [] })).status, 400);
    assert.equal((await post(base, '{не json')).status, 400);
    assert.equal((await post(base, { url: 'postgres://x', schemas: ['a'], pad: 'x'.repeat(70000) })).status, 413);
    assert.equal(calls.length, 3, 'неверные запросы не доходят до базы');
  });
});

test('API: SQL_ER_DB=off — подключение к базе выключено', async () => {
  await withServer({ dbEnabled: false, introspect: async () => assert.fail('не должно вызываться') }, async base => {
    const res = await post(base, { url: 'postgres://u@db/app', schemas: ['public'] });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /выключено/);
    const config = await (await fetch(base + '/js/PostConfig.js')).text();
    assert.match(config, /window\.SQL_ER_API = null;/);
    assert.match(config, /window\.SQL_ER_DB_DISABLED = true;/);
  });
});

test('сообщения об ошибках: коды PostgreSQL и таймауты', () => {
  assert.equal(humanError({ code: '3D000', message: '' }), 'База данных не найдена');
  assert.equal(humanError({ message: 'Query read timeout' }), 'База слишком долго отвечает на запрос к каталогу (больше 30 с)');
  assert.match(humanError({ message: 'timeout expired' }, 'postgres://u@127.0.0.1/db', true), /host.docker.internal/,
    'в Docker таймаут к localhost — тоже с подсказкой');
  assert.equal(humanError({ code: 'ECONNREFUSED', message: '' }, 'postgres://localhost/db'),
    'Сервер не отвечает — проверьте хост и порт, запущен ли PostgreSQL', 'вне Docker — без подсказки');
});
