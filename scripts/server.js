'use strict';

// Веб-сервер для Docker: draw.io (статические файлы из образа jgraph/drawio), плагин
// и чтение схемы PostgreSQL — всё с одного адреса, поэтому браузер не блокирует запросы.
//
//   GET  /                          draw.io
//   GET  /js/PostConfig.js          настройка draw.io + подгрузка плагина
//   GET  /sql-er/sql-er-plugin.js   плагин (dist/)
//   POST /sql-er/api/introspect     { url, schemas } → { sql, tables, warnings } | { error }
//   GET  /healthz                   проверка «сервер жив»
//
// Переменные окружения:
//   PORT (8080), HOST (127.0.0.1; в образе — 0.0.0.0), DRAWIO_DIR — папка с draw.io,
//   SQL_ER_DB=off — выключить подключение к базе (останутся вставка SQL и файлы).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { introspect } = require('../bridge/introspect');
const { humanError, safeHost } = require('../bridge/errors');

const root = path.join(__dirname, '..');
const PLUGIN = path.join(root, 'dist', 'sql-er-plugin.js');
const MAX_BODY = 64 * 1024;
const MAX_PARALLEL = 4; // одновременных чтений схемы

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

// draw.io кэширует файлы в service worker, в том числе PostConfig.js — тогда плагин
// перестал бы подгружаться. Вместо него — пустой worker, который сразу удаляет себя.
const NO_SERVICE_WORKER =
  "self.addEventListener('install', () => self.skipWaiting());\n" +
  "self.addEventListener('activate', e => e.waitUntil(self.registration.unregister()));\n";

// Дописывается в конец PostConfig.js: адрес API и подгрузка плагина (адреса — от страницы,
// поэтому работает и за прокси с префиксом пути).
// PostConfig.js выполняется до создания окна редактора, когда Draw.loadPlugin ещё нет:
// заводим очередь плагинов draw.io (как для его встроенных плагинов) — плагин встанет
// в неё и зарегистрируется, когда редактор будет готов.
function pluginLoader(dbEnabled) {
  return '\n// drawio-sql-er\n' +
    `window.SQL_ER_API = ${dbEnabled ? "'sql-er/api'" : 'null'};\n` +
    `window.SQL_ER_DB_DISABLED = ${dbEnabled ? 'false' : 'true'};\n` +
    "if (typeof App !== 'undefined' && App.initPluginCallback) {\n" +
    '  App.initPluginCallback();\n' +
    '  App.embedModePluginsCount++;\n' +
    '}\n' +
    "mxscript('sql-er/sql-er-plugin.js?v=' + Date.now());\n";
}

function createServer(options = {}) {
  const drawioDir = path.resolve(options.drawioDir || process.env.DRAWIO_DIR || '/opt/drawio');
  const dbEnabled = options.dbEnabled != null ? options.dbEnabled : !/^(off|0|false|no)$/i.test(process.env.SQL_ER_DB || '');
  const readSchema = options.introspect || introspect;
  const inDocker = options.inDocker != null ? options.inDocker : process.env.SQL_ER_IN_DOCKER === '1';
  const log = options.log || (msg => console.log(`[${new Date().toISOString()}] ${msg}`));
  let running = 0;

  function send(res, status, body, type, extra = {}) {
    res.writeHead(status, Object.assign({
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff'
    }, extra));
    res.end(body);
  }
  const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), TYPES['.json'], { 'Cache-Control': 'no-store' });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      // Сверх предела — дочитываем и отбрасываем (в памяти не держим), затем отвечаем 413.
      req.on('data', chunk => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      req.on('end', () => (size > MAX_BODY
        ? reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }))
        : resolve(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }

  async function apiIntrospect(req, res) {
    if (!dbEnabled) return sendJson(res, 403, { error: 'Подключение к базе выключено на сервере (SQL_ER_DB=off)' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.status ? err.message : 'Неверный запрос' });
    }
    const url = body && body.url;
    const schemas = body && body.schemas;
    if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url)) {
      return sendJson(res, 400, { error: 'Строка подключения должна начинаться с postgres://' });
    }
    if (!Array.isArray(schemas) || !schemas.length || schemas.length > 50 ||
        !schemas.every(s => typeof s === 'string' && s.length > 0 && s.length <= 128)) {
      return sendJson(res, 400, { error: 'Укажите схемы через запятую' });
    }
    if (running >= MAX_PARALLEL) return sendJson(res, 429, { error: 'Сервер занят — повторите через несколько секунд' });

    running++;
    log(`Чтение схемы ${safeHost(url)} (${schemas.join(', ')})…`);
    try {
      const result = await readSchema(url, schemas);
      log(`Готово: таблиц ${result.tables}`);
      sendJson(res, 200, result);
    } catch (err) {
      const error = humanError(err, url, inDocker);
      log('Ошибка: ' + error);
      sendJson(res, 502, { error });
    } finally {
      running--;
    }
  }

  function serveFile(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad request', TYPES['.txt']);
    }
    if (rel.endsWith('/')) rel += 'index.html';
    // Служебные папки Java-приложения draw.io (в них, например, файлы ключей) не отдаём.
    if (/^\/(WEB-INF|META-INF)(\/|$)/i.test(path.posix.normalize('/' + rel))) return send(res, 404, 'Not found', TYPES['.txt']);
    const file = path.resolve(drawioDir, '.' + path.posix.normalize('/' + rel));
    if (file !== drawioDir && !file.startsWith(drawioDir + path.sep)) return send(res, 403, 'Forbidden', TYPES['.txt']);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found', TYPES['.txt']);
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'X-Content-Type-Options': 'nosniff',
        // index.html и настройки — всегда свежие, остальное draw.io версионирует сам
        'Cache-Control': /\.(html|json)$/.test(file) ? 'no-cache' : 'public, max-age=3600'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${pathname}`;

    if (route === 'POST /sql-er/api/introspect') {
      apiIntrospect(req, res).catch(err => {
        log('Сбой: ' + err.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', TYPES['.txt']);

    if (pathname === '/healthz') return send(res, 200, 'ok', TYPES['.txt'], { 'Cache-Control': 'no-store' });
    if (pathname === '/sql-er/sql-er-plugin.js') {
      return fs.readFile(PLUGIN, 'utf8', (err, code) => (err
        ? send(res, 500, '// нет dist/sql-er-plugin.js — выполните npm run build', TYPES['.js'])
        : send(res, 200, code, TYPES['.js'], { 'Cache-Control': 'no-cache' })));
    }
    if (pathname === '/js/PostConfig.js') {
      return fs.readFile(path.join(drawioDir, 'js', 'PostConfig.js'), 'utf8', (err, original) =>
        send(res, 200, (err ? '' : original) + pluginLoader(dbEnabled), TYPES['.js'], { 'Cache-Control': 'no-cache' }));
    }
    if (pathname === '/service-worker.js') {
      return send(res, 200, NO_SERVICE_WORKER, TYPES['.js'], { 'Cache-Control': 'no-cache' });
    }
    serveFile(req, res, pathname);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '127.0.0.1'; // в Docker — 0.0.0.0 (задано в образе)
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`drawio-sql-er: http://localhost:${port}/  (плагин: Arrange → Insert → «Из SQL (ER-диаграмма)…»)`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createServer, pluginLoader };
