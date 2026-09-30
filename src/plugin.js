'use strict';

// Плагин draw.io: «Вставка → Из SQL (ER-диаграмма)…».
// Окно с полем для PostgreSQL DDL; по кнопке «Вставить» строит таблицы и связи на текущей странице.

const { parseSql } = require('./parser');
const { toGraphModelXml } = require('./drawio');

const ACTION = 'sqlErImport';

function register(ui) {
  // Повторная загрузка (обновлённая сборка): меню уже дополнено — только подменяем обработчик.
  const existing = ui.actions.get && ui.actions.get(ACTION);
  if (existing) {
    existing.funct = () => showDialog(ui);
    return;
  }
  mxResources.parse(ACTION + '=Из SQL (ER-диаграмма)...');

  ui.actions.addAction(ACTION, () => showDialog(ui));

  const menu = ui.menus.get('insert');
  if (menu) {
    const original = menu.funct;
    menu.funct = function (m, parent) {
      original.apply(this, arguments);
      ui.menus.addMenuItems(m, ['-', ACTION], parent);
    };
  }
}

// ---------------------------------------------------------------------- окно

function showDialog(ui) {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;flex-direction:column;height:100%;box-sizing:border-box;gap:8px;';

  const title = document.createElement('div');
  title.textContent = 'Вставьте PostgreSQL DDL (CREATE TABLE / ALTER TABLE) или откройте .sql-файл';
  title.style.cssText = 'font-weight:bold;';
  div.appendChild(title);

  const textarea = document.createElement('textarea');
  textarea.setAttribute('spellcheck', 'false');
  textarea.setAttribute('wrap', 'off');
  textarea.placeholder =
    'CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE\n);\n\n' +
    'CREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  user_id INTEGER NOT NULL REFERENCES users(id)\n);';
  textarea.style.cssText =
    'flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;' +
    'font-family:Consolas,Menlo,monospace;font-size:12px;padding:6px;';
  div.appendChild(textarea);

  const status = document.createElement('div');
  status.style.cssText = 'min-height:16px;font-size:12px;opacity:0.8;white-space:pre-wrap;max-height:60px;overflow:auto;';
  div.appendChild(status);

  const updateStatus = () => {
    if (!textarea.value.trim()) { status.textContent = ''; return; }
    const model = parseSql(textarea.value);
    const indexes = model.tables.reduce((n, t) => n + t.indexes.length, 0);
    let text = `Таблиц: ${model.tables.length}, связей: ${model.relations.length}, индексов: ${indexes}`;
    if (model.warnings.length) text += '\n⚠ ' + model.warnings.join('\n⚠ ');
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
      textarea.value = reader.result;
      updateStatus();
    };
    reader.readAsText(file);
  };

  textarea.addEventListener('dragover', e => e.preventDefault());
  textarea.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      e.preventDefault();
      loadFile(e.dataTransfer.files[0]);
    }
  });

  const options = document.createElement('div');
  options.style.cssText = 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;';
  const replaceBox = checkbox(options, 'Заменить содержимое страницы', false);
  const detailBox = checkbox(options, 'Ограничения как в SQL', true);
  const nullableBox = checkbox(options, 'Показывать NULL', true);
  const indexesBox = checkbox(options, 'Показывать индексы', true);
  // «NULL» — метка короткого режима; в режиме SQL видно, есть ли NOT NULL.
  const syncNullable = () => {
    nullableBox.disabled = detailBox.checked;
    nullableBox.parentNode.style.opacity = detailBox.checked ? '0.5' : '';
  };
  detailBox.addEventListener('change', syncNullable);
  syncNullable();
  div.appendChild(options);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.sql,.ddl,.txt,text/plain';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
  div.appendChild(fileInput);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

  const openBtn = mxUtils.button('Открыть .sql…', () => fileInput.click());
  openBtn.className = 'geBtn';
  openBtn.style.marginRight = 'auto';

  const cancelBtn = mxUtils.button(mxResources.get('cancel') || 'Отмена', () => ui.hideDialog());
  cancelBtn.className = 'geBtn';

  const insertBtn = mxUtils.button('Вставить', () => {
    const model = parseSql(textarea.value);
    if (!model.tables.length) {
      status.textContent = 'В SQL не найдено ни одного CREATE TABLE';
      return;
    }
    const xml = toGraphModelXml(model, {
      detail: detailBox.checked ? 'sql' : 'tags',
      showNullable: nullableBox.checked,
      showIndexes: indexesBox.checked
    });
    insertXml(ui, xml, replaceBox.checked);
    ui.hideDialog();
    if (model.warnings.length && typeof console !== 'undefined') {
      console.warn('[sql-er] ' + model.warnings.join('\n[sql-er] '));
    }
  });
  insertBtn.className = 'geBtn gePrimaryBtn';

  buttons.appendChild(openBtn);
  buttons.appendChild(cancelBtn);
  buttons.appendChild(insertBtn);
  div.appendChild(buttons);

  ui.showDialog(div, 640, 480, true, true);
  textarea.focus();
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
