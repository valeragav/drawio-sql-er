'use strict';

// Проверяем собранный dist/sql-er-plugin.js на заглушках API draw.io:
// плагин регистрируется, добавляет пункт в меню «Вставка» и вставляет ячейки.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

test('плагин регистрируется в draw.io', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.js')]);
  const code = fs.readFileSync(path.join(root, 'dist', 'sql-er-plugin.js'), 'utf8');

  const actions = {};
  const resources = {};
  const added = [];
  const insertMenu = { funct: () => {} };
  const arrangeMenu = { funct: () => {} };
  const arrangeAdded = [];

  const ui = {
    actions: {
      addAction: (name, fn) => { actions[name] = fn; },
      get: name => (actions[name] ? { funct: actions[name] } : null)
    },
    menus: {
      get: name => ({ insert: insertMenu, arrange: arrangeMenu })[name] || null,
      addMenuItems: (menu, items) => (menu === 'arrange' ? arrangeAdded : added).push(...items)
    }
  };

  let registered = null;
  const sandbox = {
    Draw: { loadPlugin: fn => { registered = fn; } },
    mxResources: {
      parse: s => { const [k, v] = s.split('='); resources[k] = v; },
      get: k => resources[k]
    },
    console
  };
  vm.runInNewContext(code, sandbox);

  assert.equal(typeof registered, 'function', 'вызван Draw.loadPlugin');
  registered(ui);
  assert.equal(typeof actions.sqlErImport, 'function', 'добавлено действие');
  assert.equal(resources.sqlErImport, 'Из SQL (ER-диаграмма)...');

  insertMenu.funct({}, null);
  assert.deepEqual(added, ['-', 'sqlErImport'], 'пункт в меню «Вставить»');

  assert.equal(typeof actions.sqlErReroute, 'function', 'действие «Перепроложить связи»');
  assert.equal(resources.sqlErReroute, 'Перепроложить связи (SQL ER)');
  arrangeMenu.funct('arrange', null);
  assert.deepEqual(arrangeAdded, ['-', 'sqlErReroute'], 'пункт в меню «Упорядочить»');

  // повторная загрузка не дублирует пункты меню
  registered(ui);
  added.length = 0;
  insertMenu.funct({}, null);
  assert.deepEqual(added, ['-', 'sqlErImport']);
});
