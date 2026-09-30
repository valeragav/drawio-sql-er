'use strict';

// Запускает draw.io Desktop и подгружает в него плагин.
//
// Свои плагины в draw.io Desktop больше не подключаются через меню (только встроенные),
// поэтому скрипт запускает приложение с портом отладки Chromium (только на 127.0.0.1)
// и выполняет dist/sql-er-plugin.js в окне редактора через DevTools Protocol.
//
//   node scripts/start-drawio.js [файл.drawio]

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = Number(process.env.DRAWIO_DEBUG_PORT) || 9229;
const TIMEOUT_MS = 60000;

const candidates = [
  process.env.DRAWIO_EXE,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'draw.io', 'draw.io.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'draw.io', 'draw.io.exe')
].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const exe = candidates.find(p => fs.existsSync(p));
  if (!exe) {
    throw new Error('draw.io Desktop не найден. Установите: winget install JGraph.Draw\n' +
      'или укажите путь в переменной DRAWIO_EXE.');
  }

  const plugin = path.join(root, 'dist', 'sql-er-plugin.js');
  if (!fs.existsSync(plugin)) throw new Error('Нет dist/sql-er-plugin.js — выполните npm run build');
  const code = fs.readFileSync(plugin, 'utf8');

  if (await targets().catch(() => null)) {
    throw new Error(`Порт ${PORT} уже занят. Закройте draw.io (или другую программу на этом порту) и запустите снова.`);
  }

  const child = spawn(exe, [`--remote-debugging-port=${PORT}`, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  console.log('Запускаю draw.io…');

  const deadline = Date.now() + TIMEOUT_MS;
  const loaded = new Set();

  // Ждём окно(а) редактора и подгружаем плагин в каждое, где он ещё не загружен.
  while (Date.now() < deadline) {
    const list = await targets().catch(() => []);
    for (const t of list) {
      if (t.type !== 'page' || loaded.has(t.id) || !t.webSocketDebuggerUrl) continue;
      const ok = await inject(t.webSocketDebuggerUrl, code).catch(() => false);
      if (ok) {
        loaded.add(t.id);
        console.log('Плагин загружен: Упорядочить (Arrange) → Вставить (Insert) → «Из SQL (ER-диаграмма)…»');
      }
    }
    if (loaded.size) return;
    await sleep(500);
  }
  throw new Error('Не дождался окна редактора draw.io. Если draw.io уже был открыт — закройте его и повторите.');
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

// Выполняет код плагина, когда в окне готов API плагинов (window.Draw).
function inject(wsUrl, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const call = (method, params) => new Promise(res => {
      const msgId = ++id;
      pending.set(msgId, res);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = () => reject(new Error('DevTools: ошибка соединения'));
    ws.onopen = async () => {
      try {
        const ready = await call('Runtime.evaluate', {
          expression: "typeof window.Draw === 'object' && typeof window.Draw.loadPlugin === 'function'",
          returnByValue: true
        });
        if (!ready.result || !ready.result.result || ready.result.result.value !== true) {
          ws.close();
          return resolve(false);
        }
        const res = await call('Runtime.evaluate', { expression: code });
        ws.close();
        if (res.result && res.result.exceptionDetails) {
          return reject(new Error('Ошибка в плагине: ' + JSON.stringify(res.result.exceptionDetails.exception || res.result.exceptionDetails)));
        }
        resolve(true);
      } catch (err) {
        ws.close();
        reject(err);
      }
    };
  });
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
