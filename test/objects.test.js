'use strict';

// ENUM, представления (VIEW) и комментарии (COMMENT ON).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');
const { toGraphModelXml } = require('../src/drawio');
const { selectTables, withRelated } = require('../src/select');
const { buildDdl } = require('../bridge/introspect');

const features = parseSql(fs.readFileSync(path.join(__dirname, '..', 'examples', 'features.sql'), 'utf8'));
const table = (m, n) => m.tables.find(t => t.name === n);

test('ENUM: значения, ALTER TYPE ADD VALUE (в конец и AFTER), связи с колонками (и массивами)', () => {
  assert.deepEqual(features.warnings, []);
  assert.deepEqual(features.enums.map(e => [e.name, e.values]), [
    ['order_status', ['new', 'paid', 'refunded', 'shipped', 'cancelled']],
    ['user_role', ['student', 'teacher', 'admin']]
  ]);
  assert.deepEqual(features.enumLinks, [
    { enum: 'user_role', table: 'users', column: 'role' },
    { enum: 'order_status', table: 'orders', column: 'status' },
    { enum: 'order_status', table: 'orders', column: 'history' }
  ]);
});

test('ALTER TYPE: BEFORE, IF NOT EXISTS, RENAME VALUE; тип со схемой и в кавычках', () => {
  const m = parseSql(`
    CREATE TYPE app."Level" AS ENUM ('low', 'high');
    ALTER TYPE app."Level" ADD VALUE 'mid' BEFORE 'high';
    ALTER TYPE app."Level" ADD VALUE IF NOT EXISTS 'low';
    ALTER TYPE app."Level" RENAME VALUE 'high' TO 'top';
    CREATE TABLE t (id INT PRIMARY KEY, lvl app."Level");
  `);
  assert.deepEqual(m.enums[0].values, ['low', 'mid', 'top']);
  assert.deepEqual(m.enumLinks, [{ enum: 'app.Level', table: 't', column: 'lvl' }]);
});

test('VIEW: колонки из SELECT и из списка, зависимости из FROM/JOIN, без CTE и функций', () => {
  const m = parseSql(`
    CREATE TABLE a (id INT PRIMARY KEY, name TEXT);
    CREATE TABLE b (id INT PRIMARY KEY, a_id INT REFERENCES a(id));
    CREATE VIEW v AS
      WITH recent AS (SELECT * FROM b)
      SELECT a.id, a.name AS title, count(*) cnt, upper(a.name), recent.*
      FROM a LEFT JOIN recent ON recent.a_id = a.id, generate_series(1, 3) g
      WHERE a.id IN (SELECT a_id FROM b);
    CREATE OR REPLACE VIEW w (x, y) AS SELECT 1, 2 FROM v;
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv AS SELECT DISTINCT ON (id) id FROM ONLY a;
  `);
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(table(m, 'v').columns.map(c => c.name), ['id', 'title', 'cnt', 'upper', '*']);
  assert.deepEqual(table(m, 'w').columns.map(c => c.name), ['x', 'y']);
  assert.deepEqual(table(m, 'mv').kind, 'materialized view');
  assert.deepEqual(table(m, 'mv').columns.map(c => c.name), ['id']);
  assert.deepEqual(m.viewDeps.map(d => `${d.table}→${d.view}`).sort(), ['a→mv', 'a→v', 'b→v', 'v→w']);
});

test('COMMENT ON: таблица, колонка, тип, представление; IS NULL снимает комментарий', () => {
  assert.equal(table(features, 'users').comment, 'Пользователи сервиса');
  assert.equal(table(features, 'users').columns.find(c => c.name === 'role').comment, 'Роль определяет доступ к разделам');
  assert.equal(features.enums[0].comment, 'Жизненный цикл заказа');
  assert.equal(table(features, 'active_orders').comment, 'Заказы, которые ещё в работе');
  assert.equal(table(features, 'revenue_by_user').comment, 'Обновляется раз в сутки');

  const m = parseSql(`CREATE TABLE t (id INT); COMMENT ON TABLE t IS 'x'; COMMENT ON TABLE t IS NULL;`);
  assert.equal(m.tables[0].comment, null);
});

test('диаграмма: блоки ENUM и представлений, их связи, комментарии и подсказки', () => {
  const xml = toGraphModelXml(features);
  // заголовки
  assert.match(xml, /value="«enum» order_status"[^>]*style="[^"]*fontStyle=3;[^"]*rounded=1;/);
  assert.match(xml, /value="active_orders \(view\)"[^>]*style="[^"]*dashed=1;/);
  assert.match(xml, /value="revenue_by_user \(materialized view\)"/);
  // значения ENUM — строки
  for (const v of ['new', 'paid', 'refunded', 'shipped', 'cancelled']) assert.match(xml, new RegExp(`value="${v}"`));
  // комментарий таблицы — мелкая курсивная строка
  assert.match(xml, /value="Пользователи сервиса" style="[^"]*textOpacity=60;fontStyle=2;/);
  // комментарий колонки — подсказка + значок
  assert.match(xml, /<UserObject label="role : user_role NOT NULL DEFAULT 'student' 💬" tooltip="Роль определяет доступ к разделам"/);
  // связи: 1 FK + 3 колонки → ENUM + 4 таблица → представление
  const styles = [...xml.matchAll(/<mxCell id="sqler-e\d+" style="([^"]*)"/g)].map(m => m[1]);
  assert.equal(styles.length, 8);
  assert.equal(styles.filter(s => /dashPattern=2 3/.test(s)).length, 3, 'пунктир к колонкам ENUM');
  assert.equal(styles.filter(s => /endArrow=open/.test(s)).length, 4, 'стрелки к представлениям');
});

test('галочки: без ENUM, без представлений, без комментариев', () => {
  const xml = toGraphModelXml(features, { showEnums: false, showViews: false, showComments: false });
  assert.doesNotMatch(xml, /«enum»|\(view\)|\(materialized view\)/);
  assert.doesNotMatch(xml, /UserObject|💬|Пользователи сервиса/);
  assert.equal([...xml.matchAll(/edge="1"/g)].length, 1, 'остался только внешний ключ');
});

test('выбор таблиц: ENUM — только используемые выбранными, «+ связанные» учитывает представления', () => {
  const onlyUsers = selectTables(features, ['users']);
  assert.deepEqual(onlyUsers.enums.map(e => e.name), ['user_role']);
  assert.deepEqual(onlyUsers.viewDeps, []);
  const all = selectTables(features, features.tables.map(t => t.name));
  assert.equal(all.enums.length, 2);
  assert.deepEqual(withRelated(features, ['active_orders']).sort(), ['active_orders', 'orders', 'users']);
});

test('SQL из каталога базы: ENUM, представления, комментарии, приведение к ENUM убрано', () => {
  const sql = buildDdl({
    tables: [{ oid: 1, name: 'orders', qualified: 'public.orders', comment: 'Заказы' }],
    columns: [
      { table_oid: 1, attnum: 1, name: 'id', type: 'integer', not_null: true, default_expr: null, identity: 'a', generated: '', comment: null },
      { table_oid: 1, attnum: 2, name: 'status', type: 'order_status', not_null: true, default_expr: "'new'::order_status", identity: '', generated: '', comment: "Статус 'заказа'" }
    ],
    constraints: [{ table_oid: 1, name: 'orders_pkey', type: 'p', columns: [1], def: 'PRIMARY KEY (id)' }],
    indexes: [],
    enums: [{ qualified: 'public.order_status', labels: ['new', "it's"], comment: null }],
    views: [{ kind: 'v', qualified: 'public.open_orders', columns: ['id'], def: " SELECT id\n   FROM orders;", comment: 'Открытые' }]
  });
  assert.match(sql, /CREATE TYPE public\.order_status AS ENUM \('new', 'it''s'\);/);
  assert.match(sql, /status order_status NOT NULL DEFAULT 'new'\n/);
  assert.match(sql, /CREATE VIEW public\.open_orders \(id\) AS\nSELECT id\n {3}FROM orders;/);
  assert.match(sql, /COMMENT ON COLUMN public\.orders\.status IS 'Статус ''заказа''';/);

  const m = parseSql(sql);
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.enums[0].values, ['new', "it's"]);
  assert.equal(m.tables.find(t => t.name === 'orders').columns[1].comment, "Статус 'заказа'");
  assert.deepEqual(m.viewDeps, [{ table: 'orders', view: 'open_orders' }]);
});

test('«--»-комментарии: у колонки (в конце строки и над ней), у таблицы, ENUM и представления', () => {
  const m = parseSql(`
-- ============================================================
-- ЧАСТЬ 1: раздел (отделён пустой строкой — не комментарий таблицы)
-- ============================================================

-- ---------- языки программирования ----------
CREATE TABLE langs (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,   -- напр. 'Python', 'Scratch'
    -- порядок в списке
    -- (меньше — выше)
    position INT NOT NULL DEFAULT 0,
    slug TEXT -- для URL
);

CREATE TABLE posts ( -- записи блога
    id INT PRIMARY KEY, lang_id INT REFERENCES langs(id) -- язык записи
);
COMMENT ON TABLE posts IS 'Из COMMENT ON — важнее';

-- статусы
CREATE TYPE status AS ENUM ('a', 'b');
-- активные языки
CREATE VIEW active_langs AS SELECT id FROM langs;
ALTER TABLE langs ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false; -- в архиве
  `);
  const langs = m.tables.find(t => t.name === 'langs');
  assert.equal(langs.comment, 'языки программирования');
  assert.deepEqual(langs.columns.map(c => [c.name, c.comment]), [
    ['id', null],
    ['name', "напр. 'Python', 'Scratch'"],
    ['position', 'порядок в списке (меньше — выше)'],
    ['slug', 'для URL'],
    ['archived', 'в архиве']
  ]);
  const posts = m.tables.find(t => t.name === 'posts');
  assert.equal(posts.comment, 'Из COMMENT ON — важнее');
  assert.equal(posts.columns.find(c => c.name === 'lang_id').comment, 'язык записи');
  assert.equal(m.enums[0].comment, 'статусы');
  assert.equal(m.tables.find(t => t.name === 'active_langs').comment, 'активные языки');
});
