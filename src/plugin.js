'use strict';

// Плагин draw.io: «Упорядочить → Вставить → Из SQL (ER-диаграмма)…».
// Окно: источник SQL (вставить / файл / база PostgreSQL) → поле с DDL →
// «Вставить» (новая диаграмма) или «Обновить на странице» (привести уже вставленную
// диаграмму к новой схеме, не двигая таблицы).

const { parseSql } = require('./parser');
const { toGraphModelXml } = require('./drawio');
const { reroute, updatePage, pageCells, diagramModel, markDiff } = require('./page');
const { diffSchemas, formatDiff } = require('./diff');
const { legendNode } = require('./legend');
const { exportSql } = require('./export');
const { selectTables, withRelated } = require('./select');
const { installHighlight } = require('./highlight');

const ACTION = 'sqlErImport';
const REROUTE = 'sqlErReroute';
const HIGHLIGHT = 'sqlErHighlight';
const EXPORT = 'sqlErExport';

function register(ui) {
  installBridgeResponse();
  addAction(ui, ACTION, 'Из SQL (ER-диаграмма)...', () => showDialog(ui), 'insert');
  addAction(ui, REROUTE, 'Перепроложить связи (SQL ER)', () => {
    if (!reroute(ui)) mxUtils.alert('На странице нет связей, построенных плагином «Из SQL (ER-диаграмма)».');
  }, 'arrange');
  addAction(ui, EXPORT, 'Экспорт в SQL (SQL ER)...', () => showExportDialog(ui), 'arrange');

  // Подсветка связей выбранной таблицы — переключатель в меню «Упорядочить».
  if (ui.editor && ui.editor.graph) {
    const highlight = installHighlight(ui);
    const action = addAction(ui, HIGHLIGHT, 'Подсветка связей (SQL ER)',
      () => highlight.setEnabled(!highlight.isEnabled()), 'arrange');
    if (action && action.setToggleAction) {
      action.setToggleAction(true);
      action.setSelectedCallback(() => ui.__sqlErHighlight.isEnabled());
    }
  }
}

// Добавляет действие и пункт меню; возвращает действие. При повторной загрузке плагина
// (обновлённая сборка) меню уже дополнено — только подменяем обработчик.
function addAction(ui, name, label, funct, menuName) {
  const existing = ui.actions.get && ui.actions.get(name);
  if (existing) {
    existing.funct = funct;
    return existing;
  }
  mxResources.parse(name + '=' + label);
  const action = ui.actions.addAction(name, funct);

  const menu = ui.menus.get(menuName);
  if (menu) {
    const original = menu.funct;
    menu.funct = function (m, parent) {
      original.apply(this, arguments);
      ui.menus.addMenuItems(m, ['-', name], parent);
    };
  }
  return action;
}

// ------------------------------------------------------------- мост к базе
//
// Сама страница draw.io не может подключиться к PostgreSQL (нет сокетов, а CSP
// запрещает запросы даже к localhost). Скрипт запуска (npm start) регистрирует
// в окне функцию window.sqlErDbRequest (Runtime.addBinding): плагин передаёт в неё
// запрос, скрипт читает схему из базы и возвращает ответ через __sqlErDbResponse.

const BRIDGE = 'sqlErDbRequest';
const DB_TIMEOUT_MS = 30000;
const pending = new Map();
let requestSeq = 0;

// Функция sqlErDbRequest остаётся в окне и после остановки скрипта запуска, поэтому
// одной её мало: скрипт каждые ~1,5 с отмечается в window.__sqlErBridgeSeen.
const BRIDGE_ALIVE_MS = 5000;

function bridgeAvailable() {
  return typeof window !== 'undefined' && typeof window[BRIDGE] === 'function' &&
    Date.now() - (window.__sqlErBridgeSeen || 0) < BRIDGE_ALIVE_MS;
}

function installBridgeResponse() {
  if (typeof window === 'undefined') return;
  window.__sqlErDbResponse = json => {
    const res = JSON.parse(json);
    const p = pending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(res.id);
    if (res.error) p.reject(new Error(res.error));
    else p.resolve(res);
  };
}

function requestSchema(url, schemas) {
  return new Promise((resolve, reject) => {
    const id = ++requestSeq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Нет ответа от скрипта запуска за 30 секунд'));
    }, DB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    window[BRIDGE](JSON.stringify({ id, url, schemas }));
  });
}

// ---------------------------------------------------------- настройки окна
// Запоминаем способ и подключение (без пароля) — только для удобства.

const SETTINGS_KEY = 'sql-er-plugin';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSettings(patch) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign(loadSettings(), patch)));
  } catch (e) { /* хранилище недоступно — не страшно */ }
}

function withoutPassword(url) {
  try {
    const u = new URL(url);
    u.password = '';
    return u.toString();
  } catch (e) {
    return '';
  }
}

function withPassword(url, password) {
  try {
    const u = new URL(url);
    u.password = password; // URL сам экранирует спецсимволы
    return u.toString();
  } catch (e) {
    return url;
  }
}

// ---------------------------------------------------------------------- окно

const MODES = [
  { id: 'paste', label: 'Вставить SQL' },
  { id: 'file', label: 'Файл .sql' },
  { id: 'db', label: 'База PostgreSQL' }
];

const PLACEHOLDERS = {
  paste: 'CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE\n);\n\n' +
    'CREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  user_id INTEGER NOT NULL REFERENCES users(id)\n);',
  file: 'Здесь появится содержимое файла — его можно поправить перед вставкой.',
  db: 'Здесь появится схема из базы (CREATE TABLE / CREATE INDEX) — её можно поправить перед вставкой.'
};

function el(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text) node.textContent = text;
  return node;
}

function showDialog(ui) {
  const settings = loadSettings();
  const div = el('div', 'display:flex;flex-direction:column;height:100%;box-sizing:border-box;gap:8px;');

  // --- выбор способа
  const modeRow = el('div', 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;');
  modeRow.appendChild(el('span', 'font-weight:bold;', 'Источник:'));
  const radios = {};
  const group = 'sql-er-mode-' + Date.now();
  for (const mode of MODES) {
    const label = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer;');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = mode.id;
    label.appendChild(input);
    label.appendChild(document.createTextNode(mode.label));
    modeRow.appendChild(label);
    radios[mode.id] = input;
  }
  div.appendChild(modeRow);

  // --- панель «Файл»
  const filePanel = el('div', 'display:flex;gap:8px;align-items:center;');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.sql,.ddl,.txt,text/plain';
  fileInput.style.display = 'none';
  const pickBtn = mxUtils.button('Выбрать файл…', () => fileInput.click());
  pickBtn.className = 'geBtn';
  pickBtn.style.margin = '0';
  const fileName = el('span', 'opacity:0.8;', 'файл не выбран — можно и перетащить его в поле ниже');
  filePanel.appendChild(pickBtn);
  filePanel.appendChild(fileName);
  filePanel.appendChild(fileInput);
  div.appendChild(filePanel);

  // --- панель «База»
  const dbPanel = el('div', 'display:flex;flex-direction:column;gap:6px;');
  const dbRow = el('div', 'display:flex;gap:8px;align-items:center;');
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'postgres://user@localhost:5432/dbname';
  urlInput.value = settings.url || '';
  urlInput.setAttribute('spellcheck', 'false');
  urlInput.style.cssText = 'flex:1;min-width:0;box-sizing:border-box;padding:4px;' +
    'font-family:Consolas,Menlo,monospace;font-size:12px;';
  // Пароль — отдельно и скрыто; не сохраняется.
  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = 'пароль';
  passwordInput.autocomplete = 'off';
  passwordInput.style.cssText = 'width:110px;box-sizing:border-box;padding:4px;font-size:12px;';
  passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadFromDb(); });
  const schemaInput = document.createElement('input');
  schemaInput.type = 'text';
  schemaInput.value = settings.schemas || 'public';
  schemaInput.title = 'Схемы через запятую';
  schemaInput.style.cssText = 'width:120px;box-sizing:border-box;padding:4px;font-size:12px;';
  const connectBtn = mxUtils.button('Подключиться', () => loadFromDb());
  connectBtn.className = 'geBtn';
  connectBtn.style.margin = '0';
  dbRow.appendChild(urlInput);
  dbRow.appendChild(passwordInput);
  dbRow.appendChild(el('span', '', 'схемы:'));
  dbRow.appendChild(schemaInput);
  dbRow.appendChild(connectBtn);
  dbPanel.appendChild(dbRow);
  const dbNote = el('div', 'font-size:12px;opacity:0.8;');
  dbPanel.appendChild(dbNote);
  div.appendChild(dbPanel);

  // --- общее поле SQL
  const textarea = document.createElement('textarea');
  textarea.setAttribute('spellcheck', 'false');
  textarea.setAttribute('wrap', 'off');
  textarea.style.cssText =
    'flex:1;min-width:0;min-height:0;box-sizing:border-box;resize:none;' +
    'font-family:Consolas,Menlo,monospace;font-size:12px;padding:6px;';

  // Поле SQL слева, список таблиц справа.
  const workArea = el('div', 'flex:1;min-height:0;display:flex;gap:8px;');
  workArea.appendChild(textarea);
  const picker = tablePicker();
  workArea.appendChild(picker.node);
  div.appendChild(workArea);

  const status = el('div', 'min-height:16px;font-size:12px;opacity:0.8;white-space:pre-wrap;max-height:72px;overflow:auto;');
  div.appendChild(status);

  // Предупреждения, пришедшие вместе со схемой из базы (например, дубли ограничений), —
  // показываются в общем блоке под полем вместе с предупреждениями разбора.
  let sourceWarnings = [];

  const updateStatus = () => {
    if (!textarea.value.trim()) {
      status.textContent = '';
      picker.setSchema(null);
      return;
    }
    const model = parseSql(textarea.value);
    picker.setSchema(model);
    const indexes = model.tables.reduce((n, t) => n + t.indexes.length, 0);
    const views = model.tables.filter(t => t.kind && t.kind !== 'table').length;
    let text = `Таблиц: ${model.tables.length - views}, связей: ${model.relations.length}, индексов: ${indexes}`;
    if (views) text += `, представлений: ${views}`;
    if (model.enums && model.enums.length) text += `, ENUM: ${model.enums.length}`;
    const warnings = sourceWarnings.concat(model.warnings);
    if (warnings.length) text += '\n⚠ ' + warnings.join('\n⚠ ');
    status.textContent = text;
  };
  let timer = null;
  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(updateStatus, 300);
  });

  const loadFile = file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      sourceWarnings = [];
      textarea.value = reader.result;
      fileName.textContent = file.name;
      updateStatus();
    };
    reader.readAsText(file);
  };
  fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
  textarea.addEventListener('dragover', e => e.preventDefault());
  textarea.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      e.preventDefault();
      setMode('file');
      loadFile(e.dataTransfer.files[0]);
    }
  });

  async function loadFromDb() {
    let url = urlInput.value.trim();
    if (!url) { dbNote.textContent = 'Укажите строку подключения'; return; }
    const schemas = schemaInput.value.split(',').map(s => s.trim()).filter(Boolean);
    saveSettings({ url: withoutPassword(url), schemas: schemas.join(', ') });
    if (passwordInput.value) url = withPassword(url, passwordInput.value);
    connectBtn.disabled = true;
    dbNote.textContent = 'Подключаюсь…';
    try {
      const res = await requestSchema(url, schemas.length ? schemas : ['public']);
      textarea.value = res.sql;
      sourceWarnings = res.warnings || [];
      dbNote.textContent = res.message || `Прочитано таблиц: ${res.tables}. Проверьте SQL ниже и нажмите «Вставить».`;
      updateStatus();
    } catch (err) {
      dbNote.textContent = '✖ ' + err.message;
    } finally {
      connectBtn.disabled = !bridgeAvailable();
    }
  }

  let currentMode = null;
  function setMode(mode) {
    // Сменили источник — предупреждения прежнего источника больше не относятся к делу.
    if (currentMode && mode !== currentMode && sourceWarnings.length) {
      sourceWarnings = [];
      updateStatus();
    }
    currentMode = mode;
    radios[mode].checked = true;
    filePanel.style.display = mode === 'file' ? 'flex' : 'none';
    dbPanel.style.display = mode === 'db' ? 'flex' : 'none';
    textarea.placeholder = PLACEHOLDERS[mode];
    if (mode === 'db') {
      const ok = bridgeAvailable();
      connectBtn.disabled = !ok;
      dbNote.textContent = ok
        ? 'Только чтение: берётся структура (таблицы, ключи, CHECK, индексы), данные не читаются.'
        : '✖ Подключение к базе работает, только если draw.io запущен через «npm start» в папке плагина.';
    }
    saveSettings({ mode });
  }
  for (const mode of MODES) radios[mode.id].addEventListener('change', () => setMode(mode.id));
  setMode(radios[settings.mode] ? settings.mode : 'paste');

  // --- параметры и кнопки
  const options = el('div', 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;');
  const replaceBox = checkbox(options, 'Заменить содержимое страницы', false);
  const detailBox = checkbox(options, 'Ограничения как в SQL', true);
  const nullableBox = checkbox(options, 'Показывать NULL', true);
  const indexesBox = checkbox(options, 'Показывать индексы', true);
  const enumsBox = checkbox(options, 'ENUM', true);
  const viewsBox = checkbox(options, 'Представления', true);
  const commentsBox = checkbox(options, 'Комментарии', true);

  // Рамки групп: по схемам (billing.*) или по префиксам имён (course_*, article_*).
  const groupLabel = el('label', 'display:flex;align-items:center;gap:4px;');
  groupLabel.appendChild(document.createTextNode('Группы:'));
  const groupSelect = document.createElement('select');
  for (const [value, text] of [['none', 'нет'], ['schema', 'по схемам'], ['prefix', 'по префиксам']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    groupSelect.appendChild(option);
  }
  groupSelect.value = settings.groupBy || 'prefix';
  groupSelect.addEventListener('change', () => saveSettings({ groupBy: groupSelect.value }));
  groupLabel.appendChild(groupSelect);
  options.appendChild(groupLabel);
  // «NULL» — метка короткого режима; в режиме SQL видно, есть ли NOT NULL.
  const syncNullable = () => {
    nullableBox.disabled = detailBox.checked;
    nullableBox.parentNode.style.opacity = detailBox.checked ? '0.5' : '';
  };
  detailBox.addEventListener('change', syncNullable);
  syncNullable();
  div.appendChild(options);
  div.appendChild(legendNode());

  const buttons = el('div', 'display:flex;justify-content:flex-end;gap:8px;');

  const cancelBtn = mxUtils.button(mxResources.get('cancel') || 'Отмена', () => ui.hideDialog());
  cancelBtn.className = 'geBtn';

  const parsed = () => {
    const model = parseSql(textarea.value);
    if (!model.tables.length) {
      status.textContent = 'В SQL не найдено ни одного CREATE TABLE';
      return null;
    }
    if (model.warnings.length && typeof console !== 'undefined') {
      console.warn('[sql-er] ' + model.warnings.join('\n[sql-er] '));
    }
    picker.setSchema(model); // на случай, если «Вставить» нажали раньше, чем обновился список
    return model;
  };
  const renderOptions = () => ({
    detail: detailBox.checked ? 'sql' : 'tags',
    showNullable: nullableBox.checked,
    showIndexes: indexesBox.checked,
    showEnums: enumsBox.checked,
    showViews: viewsBox.checked,
    showComments: commentsBox.checked,
    groupBy: groupSelect.value,
    measureText
  });

  const insertBtn = mxUtils.button('Вставить', () => {
    const model = parsed();
    if (!model) return;
    const selected = picker.selected();
    if (!selected.length) {
      status.textContent = 'Не отмечено ни одной таблицы';
      return;
    }
    insertXml(ui, toGraphModelXml(selectTables(model, selected), renderOptions()), replaceBox.checked);
    ui.hideDialog();
  });
  insertBtn.className = 'geBtn gePrimaryBtn';

  // Обновить уже вставленную диаграмму: таблицы остаются на местах, меняется содержимое.
  const updateBtn = mxUtils.button('Обновить на странице', () => {
    const model = parsed();
    if (!model) return;
    // Таблицы на странице обновляются всегда; отметки решают, какие новые добавить.
    const res = updatePage(ui, model, renderOptions(), picker.selected());
    if (res.error) {
      status.textContent = '✖ ' + res.error;
      return;
    }
    ui.hideDialog();
    const parts = [`обновлено таблиц: ${res.updated}`];
    if (res.added) parts.push(`добавлено: ${res.added} (выделены)`);
    if (res.restored) parts.push(`вернулось в схему: ${res.restored}`);
    if (res.removed) parts.push(`нет в схеме: ${res.removed} — помечены пунктиром, удалите сами, если не нужны`);
    parts.push(`связей: ${res.links}`);
    mxUtils.alert('Диаграмма обновлена: ' + parts.join(', ') + '.');
  });
  updateBtn.className = 'geBtn';
  updateBtn.title = 'Привести уже вставленную диаграмму к этой схеме, не двигая таблицы (одна операция, Ctrl+Z)';

  // Сравнить схему из поля (база / файл / вставка) с тем, что нарисовано на странице.
  const compareBtn = mxUtils.button('Сравнить с диаграммой', () => {
    const model = parsed();
    if (!model) return;
    const source = currentMode === 'db' ? `база ${safeTarget(urlInput.value)}`
      : currentMode === 'file' ? `файл ${fileName.textContent}` : 'SQL из поля';
    showDiffDialog(ui, model, source, () => updateBtn.click());
  });
  compareBtn.className = 'geBtn';
  compareBtn.title = 'Показать, чем диаграмма на странице отличается от этой схемы';

  buttons.appendChild(cancelBtn);
  buttons.appendChild(compareBtn);
  buttons.appendChild(updateBtn);
  buttons.appendChild(insertBtn);
  div.appendChild(buttons);

  ui.showDialog(div, 900, 560, true, true);
  (radios.db.checked ? urlInput : textarea).focus();
}

// ----------------------------------------------------- сравнение со схемой
//
// Отчёт о различиях диаграммы на странице и схемы (из базы, файла или поля) +
// временная подсветка различий на диаграмме (снимается при закрытии отчёта).

// «postgres://user:pass@host:5433/db» → «host:5433/db» (без пароля — для заголовка отчёта).
function safeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch (e) {
    return '';
  }
}

function showDiffDialog(ui, schema, source, updateFromSchema) {
  const diagram = diagramModel(ui);
  if (!diagram.tables.length && !(diagram.enums || []).length) {
    mxUtils.alert('На странице нет таблиц, вставленных плагином, — сравнивать не с чем.');
    return;
  }

  const div = el('div', 'display:flex;flex-direction:column;height:100%;box-sizing:border-box;gap:8px;');
  const textarea = document.createElement('textarea');
  textarea.readOnly = true;
  textarea.setAttribute('wrap', 'off');
  textarea.style.cssText = 'flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;' +
    'font-family:Consolas,Menlo,monospace;font-size:12px;padding:6px;';

  const legend = el('div', 'font-size:12px;opacity:0.8;',
    'На диаграмме: красным — таблицы и колонки, которые отличаются от схемы; зелёным — таблицы, которых в схеме нет.');
  const options = el('div', 'display:flex;gap:16px;align-items:center;');
  const commentsBox = checkbox(options, 'Учитывать комментарии', false);

  let clearMarks = () => {};
  let report = '';
  const run = () => {
    clearMarks();
    const d = diffSchemas(diagram, schema, { comments: commentsBox.checked });
    report = formatDiff(d, `Сравнение: диаграмма «${ui.currentPage ? ui.currentPage.getName() : ''}» ↔ ${source}`);
    textarea.value = report;
    clearMarks = markDiff(ui, d);
  };
  commentsBox.addEventListener('change', run);

  div.appendChild(textarea);
  div.appendChild(legend);
  div.appendChild(options);

  const close = () => {
    clearMarks();
    ui.hideDialog();
  };
  const buttons = el('div', 'display:flex;justify-content:flex-end;gap:8px;');
  const copyBtn = mxUtils.button('Копировать отчёт', () => {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(report);
    else {
      textarea.select();
      document.execCommand('copy');
    }
  });
  copyBtn.className = 'geBtn';
  const updateBtn = mxUtils.button('Обновить диаграмму из схемы', () => {
    close();
    updateFromSchema();
  });
  updateBtn.className = 'geBtn';
  updateBtn.title = 'То же, что «Обновить на странице»: таблицы остаются на местах, содержимое — по схеме';
  const closeBtn = mxUtils.button(mxResources.get('close') || 'Закрыть', close);
  closeBtn.className = 'geBtn gePrimaryBtn';
  buttons.appendChild(copyBtn);
  buttons.appendChild(updateBtn);
  buttons.appendChild(closeBtn);
  div.appendChild(buttons);

  // Закрытие крестиком/Esc — тоже снимает подсветку.
  ui.showDialog(div, 760, 520, true, true, () => clearMarks());
  run();
}

// ------------------------------------------------------------ экспорт в SQL
//
// SQL по тому, что сейчас нарисовано на странице (с правками): окно с текстом,
// «Копировать» и «Сохранить .sql».

function showExportDialog(ui) {
  const { sql, warnings } = exportSql(pageCells(ui));
  if (!/CREATE (TABLE|TYPE)/.test(sql)) {
    mxUtils.alert('На странице нет таблиц, вставленных плагином «Из SQL (ER-диаграмма)».');
    return;
  }

  const div = el('div', 'display:flex;flex-direction:column;height:100%;box-sizing:border-box;gap:8px;');
  div.appendChild(el('div', 'font-weight:bold;', 'SQL по диаграмме на текущей странице'));

  const textarea = document.createElement('textarea');
  textarea.value = sql;
  textarea.readOnly = true;
  textarea.setAttribute('spellcheck', 'false');
  textarea.setAttribute('wrap', 'off');
  textarea.style.cssText = 'flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;' +
    'font-family:Consolas,Menlo,monospace;font-size:12px;padding:6px;';
  div.appendChild(textarea);

  const status = el('div', 'min-height:16px;font-size:12px;opacity:0.8;white-space:pre-wrap;max-height:60px;overflow:auto;');
  if (warnings.length) status.textContent = '⚠ ' + warnings.join('\n⚠ ');
  div.appendChild(status);

  const buttons = el('div', 'display:flex;justify-content:flex-end;gap:8px;');
  const copyBtn = mxUtils.button('Копировать', () => {
    const done = () => { status.textContent = 'Скопировано в буфер обмена'; };
    const fallback = () => {
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sql).then(done, fallback);
    else fallback();
  });
  copyBtn.className = 'geBtn';

  const fileName = (ui.currentPage ? ui.currentPage.getName() : 'schema').replace(/[\\/:*?"<>|]+/g, '_') + '.sql';
  const saveBtn = mxUtils.button('Сохранить .sql', () => {
    // В draw.io есть свой диалог сохранения (в desktop — системный); иначе — загрузка файла.
    if (typeof ui.saveData === 'function') {
      ui.saveData(fileName, 'sql', sql, 'text/plain;charset=utf-8');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([sql], { type: 'text/plain;charset=utf-8' }));
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  });
  saveBtn.className = 'geBtn';

  const closeBtn = mxUtils.button(mxResources.get('close') || 'Закрыть', () => ui.hideDialog());
  closeBtn.className = 'geBtn gePrimaryBtn';

  buttons.appendChild(copyBtn);
  buttons.appendChild(saveBtn);
  buttons.appendChild(closeBtn);
  div.appendChild(buttons);

  ui.showDialog(div, 760, 520, true, true);
  textarea.focus();
}

// ------------------------------------------------------------ список таблиц
//
// Галочки у таблиц схемы, поиск по имени, «Все» / «Ни одной» (для видимых по поиску)
// и «+ связанные». Отметки хранятся по имени и переживают правку SQL; новые таблицы
// появляются отмеченными.

function tablePicker() {
  const node = el('div', 'width:230px;flex:none;display:flex;flex-direction:column;gap:4px;min-height:0;');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'поиск таблицы';
  search.style.cssText = 'box-sizing:border-box;width:100%;padding:3px 4px;font-size:12px;';
  node.appendChild(search);

  const tools = el('div', 'display:flex;gap:4px;flex-wrap:wrap;');
  const smallButton = (text, title, fn) => {
    const b = mxUtils.button(text, fn);
    b.className = 'geBtn';
    b.title = title;
    b.style.cssText = 'margin:0;padding:0 6px;min-width:0;height:22px;font-size:11px;';
    tools.appendChild(b);
  };
  node.appendChild(tools);

  const list = el('div', 'flex:1;min-height:0;overflow:auto;border:1px solid rgba(128,128,128,0.4);padding:2px 4px;font-size:12px;');
  node.appendChild(list);
  const counter = el('div', 'font-size:11px;opacity:0.8;');
  node.appendChild(counter);

  const checked = new Map(); // имя → отмечена ли
  let schema = null;

  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return schema ? schema.tables.map(t => t.name).filter(n => !q || n.toLowerCase().includes(q)) : [];
  };

  function render() {
    list.textContent = '';
    const names = visible();
    for (const name of names) {
      const label = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked.get(name);
      box.addEventListener('change', () => {
        checked.set(name, box.checked);
        updateCounter();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(name));
      label.title = name;
      list.appendChild(label);
    }
    if (schema && !names.length) list.appendChild(el('div', 'opacity:0.6;', 'ничего не найдено'));
    if (!schema) list.appendChild(el('div', 'opacity:0.6;', 'здесь появятся таблицы из SQL'));
    updateCounter();
  }

  function updateCounter() {
    const total = schema ? schema.tables.length : 0;
    counter.textContent = total ? `выбрано ${selected().length} из ${total}` : '';
  }

  function selected() {
    return schema ? schema.tables.map(t => t.name).filter(n => checked.get(n)) : [];
  }

  smallButton('Все', 'Отметить все (видимые по поиску)', () => {
    visible().forEach(n => checked.set(n, true));
    render();
  });
  smallButton('Ни одной', 'Снять отметки (с видимых по поиску)', () => {
    visible().forEach(n => checked.set(n, false));
    render();
  });
  smallButton('+ связанные', 'Добавить таблицы, связанные с отмеченными', () => {
    if (!schema) return;
    withRelated(schema, selected()).forEach(n => checked.set(n, true));
    render();
  });
  search.addEventListener('input', render);

  render();
  return {
    node,
    selected,
    setSchema(next) {
      schema = next && next.tables.length ? next : null;
      if (schema) for (const t of schema.tables) if (!checked.has(t.name)) checked.set(t.name, true);
      render();
    }
  };
}

// Ширина текста так, как её нарисует draw.io (шрифт по умолчанию, html-подпись):
// по ней считается ширина таблиц и какие строки переносить.
function measureText(text, fontSize, bold) {
  return mxUtils.getSizeForString(mxUtils.htmlEntities(text), fontSize,
    mxConstants.DEFAULT_FONTFAMILY, null, bold ? mxConstants.FONT_BOLD : 0).width;
}

function checkbox(parent, text, checked) {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  label.appendChild(input);
  label.appendChild(document.createTextNode(text));
  parent.appendChild(label);
  return input;
}

// ------------------------------------------------------------------- вставка

function insertXml(ui, xml, replace) {
  const graph = ui.editor.graph;
  const doc = mxUtils.parseXml(xml);
  const imported = new mxGraphModel();
  new mxCodec(doc).decode(doc.documentElement, imported);
  const cells = imported.getChildren(imported.getChildAt(imported.getRoot(), 0)) || [];

  const model = graph.getModel();
  let inserted = [];

  // Одна транзакция — отменяется одним Ctrl+Z.
  model.beginUpdate();
  try {
    if (replace) {
      graph.removeCells(graph.getChildCells(graph.getDefaultParent(), true, true), true);
    }
    const pt = replace || graph.getChildCells(graph.getDefaultParent()).length === 0
      ? { x: 0, y: 0 }
      : freePoint(graph);
    inserted = graph.importCells(cells.slice(), pt.x, pt.y, graph.getDefaultParent());
  } finally {
    model.endUpdate();
  }

  if (inserted && inserted.length) {
    graph.setSelectionCells(inserted.filter(c => model.isVertex(c)));
    graph.scrollCellToVisible(inserted[0]);
  }
}

// Ставим новую диаграмму под существующим содержимым страницы.
function freePoint(graph) {
  const bounds = graph.getBoundingBoxFromGeometry(graph.getChildCells(graph.getDefaultParent()), true);
  return bounds ? { x: bounds.x, y: bounds.y + bounds.height + 40 } : { x: 0, y: 0 };
}

module.exports = { register, insertXml };

if (typeof Draw !== 'undefined' && Draw.loadPlugin) {
  Draw.loadPlugin(register);
}
