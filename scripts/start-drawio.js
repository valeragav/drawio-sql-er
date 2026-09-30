'use strict';

// Запускает draw.io Desktop, подгружает плагин и работает «мостом» к PostgreSQL.
//
// Свои плагины в draw.io Desktop больше не подключаются через меню (только встроенные),
// поэтому скрипт запускает приложение с портом отладки Chromium (только на 127.0.0.1)
// и выполняет dist/sql-er-plugin.js в окне редактора через DevTools Protocol.
//
// Пока draw.io открыт, скрипт следит за окнами: подгружает плагин в новые/перезагруженные
// и отвечает на запросы «Подключиться» из окна плагина (window.sqlErDbRequest).
//
//   node scripts/start-drawio.js [файл.drawio]

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { introspect } = require('../bridge/introspect');

const root = path.join(__dirname, '..');
const PORT = Number(process.env.DRAWIO_DEBUG_PORT) || 9229;
const START_TIMEOUT_MS = 60000;
const POLL_MS = 1500;
const BINDING = 'sqlErDbRequest';

const candidates = [
  process.env.DRAWIO_EXE,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'draw.io', 'draw.io.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'draw.io', 'draw.io.exe')
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

// Соединение с одним окном draw.io через DevTools Protocol.
class PageSession {
  constructor(target, code) {
    this.target = target;
    this.code = code;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('DevTools: ошибка соединения'));
      this.ws.onclose = () => { this.closed = true; };
      this.ws.onmessage = e => this.onMessage(JSON.parse(e.data));
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('окно закрыто'));
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.call('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      throw new Error(ex && ex.description ? ex.description : res.exceptionDetails.text);
    }
    return res.result && res.result.value;
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === BINDING) {
      this.onDbRequest(msg.params.payload);
    }
  }

  async setup() {
    await this.open();
    await this.call('Runtime.enable');
    await this.call('Runtime.addBinding', { name: BINDING }); // переживает перезагрузку окна
  }

  // Плагин загружен в окно? Если нет и редактор готов — загружаем.
  async ensurePlugin() {
    // Отметка «мост жив» — по ней плагин понимает, что подключение к базе доступно.
    await this.evaluate('window.__sqlErBridgeSeen = Date.now()');
    const state = await this.evaluate(
      "typeof window.__sqlErDbResponse === 'function' ? 'loaded' : " +
      "(typeof window.Draw === 'object' && typeof window.Draw.loadPlugin === 'function' ? 'ready' : 'wait')");
    if (state !== 'ready') return state === 'loaded';
    await this.evaluate(this.code);
    log('Плагин загружен: Упорядочить → Вставить → «Из SQL (ER-диаграмма)…»');
    return true;
  }

  async onDbRequest(payload) {
    let req;
    try {
      req = JSON.parse(payload);
    } catch {
      return;
    }
    let response;
    try {
      const host = safeHost(req.url);
      log(`Чтение схемы ${host} (${(req.schemas || []).join(', ')})…`);
      const result = await introspect(req.url, req.schemas);
      response = { id: req.id, ...result };
      log(`Готово: таблиц ${result.tables}`);
    } catch (err) {
      response = { id: req.id, error: humanError(err) };
      log('Ошибка: ' + response.error);
    }
    await this.evaluate(`window.__sqlErDbResponse(${JSON.stringify(JSON.stringify(response))})`).catch(() => {});
  }
}

function safeHost(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(строка подключения)';
  }
}

function humanError(err) {
  const map = {
    ECONNREFUSED: 'Сервер не отвечает — проверьте хост и порт, запущен ли PostgreSQL',
    ENOTFOUND: 'Хост не найден',
    ETIMEDOUT: 'Превышено время ожидания подключения',
    '28P01': 'Неверный пользователь или пароль',
    '3D000': 'База данных не найдена',
    '28000': 'Доступ запрещён (pg_hba.conf)'
  };
  return map[err.code] || err.message;
}

async function main() {
  const exe = candidates.find(p => fs.existsSync(p));
  if (!exe) {
    throw new Error('draw.io Desktop не найден. Установите: winget install JGraph.Draw\n' +
      'или укажите путь в переменной DRAWIO_EXE.');
  }

  const plugin = path.join(root, 'dist', 'sql-er-plugin.js');
  if (!fs.existsSync(plugin)) throw new Error('Нет dist/sql-er-plugin.js — выполните npm run build');
  const code = fs.readFileSync(plugin, 'utf8');

  const running = await targets().catch(() => null);
  if (running) {
    // draw.io уже запущен этим скриптом (порт отладки открыт) — просто подключаемся заново.
    log('draw.io уже запущен с портом отладки — подключаюсь к нему.');
  } else {
    const child = spawn(exe, [`--remote-debugging-port=${PORT}`, ...process.argv.slice(2)], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    log('Запускаю draw.io…');
  }
  log('Не закрывайте это окно, пока работаете: через него плагин подключается к базе.');

  const sessions = new Map(); // id окна → PageSession
  const started = Date.now();
  let everConnected = false;

  for (;;) {
    let list;
    try {
      list = await targets();
      everConnected = true;
    } catch {
      if (everConnected) break; // draw.io закрыт
      if (Date.now() - started > START_TIMEOUT_MS) {
        throw new Error('Не дождался draw.io. Если он уже был открыт — закройте его и повторите.');
      }
      await sleep(500);
      continue;
    }

    const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
    for (const t of pages) {
      let s = sessions.get(t.id);
      if (s && s.closed) {
        sessions.delete(t.id);
        s = null;
      }
      if (!s) {
        s = new PageSession(t, code);
        try {
          await s.setup();
          sessions.set(t.id, s);
        } catch {
          continue;
        }
      }
      await s.ensurePlugin().catch(() => {});
    }
    for (const [id, s] of sessions) {
      if (!pages.some(t => t.id === id)) {
        s.closed = true;
        sessions.delete(id);
      }
    }
    await sleep(POLL_MS);
  }

  log('draw.io закрыт — выхожу.');
  process.exit(0);
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
