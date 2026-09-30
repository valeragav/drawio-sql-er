'use strict';

// Экспорт диаграммы в SQL: проверка «туда-обратно» —
// SQL → диаграмма → экспорт → снова разбор даёт ту же схему.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');
const { toGraphModelXml } = require('../src/drawio');
const { exportSql, parseIndexText, parseColumnText } = require('../src/export');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8');

const unescape = s => s
  .replace(/&quot;/g, '"').replace(/&#10;/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// XML графа → простой снимок ячеек (как его строит плагин по странице draw.io).
function cellsFromXml(xml) {
  const cells = [];
  const geo = body => {
    const m = /<mxGeometry x="([\d.-]+)" y="([\d.-]+)"/.exec(body);
    return m ? +m[2] : 0;
  };
  for (const m of xml.matchAll(/<UserObject label="([^"]*)" tooltip="([^"]*)" id="([^"]+)"><mxCell style="([^"]*)" vertex="1" parent="([^"]+)">(.*?)<\/mxCell><\/UserObject>/g)) {
    cells.push({ id: m[3], value: unescape(unescape(m[1])), tooltip: unescape(m[2]), style: unescape(m[4]), parent: m[5], vertex: true, y: geo(m[6]) });
  }
  for (const m of xml.matchAll(/<mxCell id="([^"]+)"(?: value="([^"]*)")? style="([^"]*)" (vertex|edge)="1" parent="([^"]+)"(?: source="([^"]+)" target="([^"]+)")?>(.*?)<\/mxCell>/g)) {
    cells.push({
      id: m[1], value: unescape(unescape(m[2] || '')), style: unescape(m[3]), parent: m[5],
      vertex: m[4] === 'vertex', edge: m[4] === 'edge', source: m[6], target: m[7], y: geo(m[8])
    });
  }
  return cells;
}

// Суть схемы для сравнения.
function essence(model) {
  return {
    tables: model.tables.filter(t => t.kind === 'table').map(t => ({
      name: t.name,
      columns: t.columns.map(c => [c.name, c.type.toLowerCase(), c.primaryKey, c.notNull, c.unique, c.comment || null]),
      indexes: t.indexes.map(i => [i.name, i.unique, i.columns.join(','), i.where]),
      comment: t.comment || null
    })).sort((a, b) => a.name.localeCompare(b.name)),
    relations: model.relations.map(r => `${r.parent}.${r.parentColumn}→${r.child}.${r.childColumn}`).sort(),
    enums: (model.enums || []).map(e => [e.name, e.values.join(',')])
  };
}

for (const example of ['shop.sql', 'ecommerce.sql', 'features.sql']) {
  test(`экспорт «туда-обратно»: ${example}`, () => {
    const original = parseSql(read(example));
    const { sql, warnings } = exportSql(cellsFromXml(toGraphModelXml(original)));
    assert.deepEqual(warnings, []);
    const again = parseSql(sql);
    assert.deepEqual(again.warnings, [], sql);
    assert.deepEqual(essence(again), essence(original));
  });
}

test('экспорт из режима коротких меток (PK, FK, UQ, NULL) восстанавливает ключи и NOT NULL', () => {
  const original = parseSql(read('shop.sql'));
  const { sql } = exportSql(cellsFromXml(toGraphModelXml(original, { detail: 'tags', showNullable: true })));
  const again = parseSql(sql);
  const pick = m => m.tables.map(t => [t.name, t.columns.map(c => [c.name, c.primaryKey, c.notNull, c.unique])]);
  assert.deepEqual(pick(again), pick(original));
  // внешние ключи — из линий на диаграмме
  assert.deepEqual(essence(again).relations, essence(original).relations);
});

test('правки на диаграмме попадают в SQL: переименование, новая колонка, связь нарисована вручную', () => {
  const original = parseSql(`
    CREATE TABLE authors (id INT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE books (id INT PRIMARY KEY, title TEXT NOT NULL, writer_id INT);
  `);
  const cells = cellsFromXml(toGraphModelXml(original));
  const header = cells.find(c => c.value === 'books');
  header.value = 'novels';                                           // переименовали таблицу
  const title = cells.find(c => c.value.startsWith('title :'));
  cells.push({ ...title, id: 'new-row', value: 'isbn : VARCHAR(13) UNIQUE', y: title.y + 1 }); // добавили строку
  const authorId = cells.find(c => c.value.startsWith('🔑 id') && c.parent === cells.find(x => x.value === 'authors').id);
  const writer = cells.find(c => c.value.startsWith('writer_id'));
  cells.push({ id: 'manual-edge', edge: true, style: 'endArrow=classic;', parent: '1', source: authorId.id, target: writer.id });

  const { sql } = exportSql(cells);
  const again = parseSql(sql);
  assert.deepEqual(again.tables.map(t => t.name), ['authors', 'novels']);
  assert.deepEqual(again.tables[1].columns.map(c => c.name), ['id', 'title', 'isbn', 'writer_id']);
  assert.match(sql, /ALTER TABLE novels ADD FOREIGN KEY \(writer_id\) REFERENCES authors \(id\);/);
  assert.deepEqual(again.relations.map(r => `${r.parent}→${r.child}.${r.childColumn}`), ['authors→novels.writer_id']);
});

test('разбор строк: колонка и индекс', () => {
  assert.deepEqual(parseColumnText('🔑 id : BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY 💬'),
    { name: 'id', rest: 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY', primaryKey: true, tags: null });
  assert.deepEqual(parseColumnText('user_id : INTEGER (FK, NULL)').tags, ['FK', 'NULL']);
  assert.deepEqual(parseIndexText("🔍 UNIQUE idx_e (lower(email), (a + 1)) USING gin INCLUDE (x) WHERE status <> 'x'"), {
    unique: true, name: 'idx_e', columns: 'lower(email), (a + 1)', method: 'gin', include: 'x', where: "status <> 'x'"
  });
});

test('таблицы создаются раньше тех, что на них ссылаются; представления и удалённые — комментарием', () => {
  const original = parseSql(`
    CREATE TABLE child (id INT PRIMARY KEY, p INT REFERENCES parent(id));
    CREATE TABLE parent (id INT PRIMARY KEY);
    CREATE VIEW v AS SELECT id FROM child;
  `);
  const cells = cellsFromXml(toGraphModelXml(original));
  const { sql } = exportSql(cells);
  assert.ok(sql.indexOf('CREATE TABLE parent') < sql.indexOf('CREATE TABLE child'));
  assert.match(sql, /-- VIEW v \(id\) — из child: текст запроса на диаграмме не хранится/);

  cells.find(c => c.value === 'child').style += 'sqlErRemoved=1;';
  assert.match(exportSql(cells).sql, /-- child: пропущена/);
});

test('переименованная на диаграмме таблица: ссылки REFERENCES на неё получают новое имя', () => {
  const original = parseSql(`
    CREATE TABLE users (id INT PRIMARY KEY);
    CREATE TABLE orders (id INT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id),
      buyer INT, FOREIGN KEY (buyer) REFERENCES users (id));
  `);
  const cells = cellsFromXml(toGraphModelXml(original));
  cells.find(c => c.value === 'users').value = 'app_users';
  const { sql } = exportSql(cells);
  assert.doesNotMatch(sql, /REFERENCES users\b/);
  const again = parseSql(sql);
  assert.deepEqual(again.warnings, []);
  assert.deepEqual(again.relations.map(r => `${r.parent}→${r.child}.${r.childColumn}`).sort(),
    ['app_users→orders.buyer', 'app_users→orders.user_id']);
});
