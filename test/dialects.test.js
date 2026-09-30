'use strict';

// MySQL и SQLite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');
const { toGraphModelXml } = require('../src/drawio');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8');
const table = (m, n) => m.tables.find(t => t.name === n);
const col = (m, t, c) => table(m, t).columns.find(x => x.name === c);

test('MySQL (mysqldump): `имена` с регистром, AUTO_INCREMENT, COMMENT, KEY, UNIQUE KEY, ENGINE', () => {
  const m = parseSql(read('mysql.sql'));
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.tables.map(t => t.name), ['Users', 'Orders']);

  assert.equal(col(m, 'Users', 'id').type, 'int unsigned');
  assert.equal(col(m, 'Users', 'id').autoIncrement, true);
  assert.equal(col(m, 'Users', 'id').primaryKey, true);
  assert.equal(col(m, 'Users', 'email').type, 'varchar(255)');
  assert.equal(col(m, 'Users', 'email').comment, 'Логин');
  assert.doesNotMatch(col(m, 'Users', 'email').constraints, /COMMENT/);
  assert.equal(col(m, 'Users', 'email').unique, true, 'UNIQUE KEY по одной колонке');
  assert.equal(col(m, 'Users', 'role').type, "enum('student','teacher','admin')");
  assert.equal(col(m, 'Users', 'updated_at').default, 'NULL');
  assert.equal(table(m, 'Users').comment, 'Пользователи');

  assert.deepEqual(table(m, 'Users').indexes.map(i => [i.name, i.method, i.columns]), [['idx_users_role', 'btree', ['`role`']]]);
  assert.deepEqual(table(m, 'Orders').indexes.map(i => [i.name, i.method]),
    [['fk_orders_user', null], ['ft_orders_note', 'fulltext'], ['idx_orders_total', null]]);
  assert.equal(table(m, 'Orders').comment, 'заказы', '# комментарий над таблицей');

  assert.deepEqual(m.relations.map(r => `${r.parent}.${r.parentColumn}→${r.child}.${r.childColumn}`), ['Users.id→Orders.user_id']);
  assert.equal(m.relations[0].optional, false);
});

test('SQLite: [имена], AUTOINCREMENT, FOREIGN KEY(…), WITHOUT ROWID', () => {
  const m = parseSql(read('sqlite.sql'));
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.tables.map(t => t.name), ['authors', 'books']);
  assert.equal(col(m, 'authors', 'id').autoIncrement, true);
  assert.equal(col(m, 'authors', 'id').primaryKey, true);
  assert.equal(col(m, 'books', 'title').type, 'TEXT');
  assert.deepEqual(m.relations.map(r => `${r.parent}→${r.child}.${r.childColumn}`), ['authors→books.author_id']);
  assert.equal(table(m, 'books').indexes[0].name, 'idx_books_author');
});

test('признаки MySQL не ломают PostgreSQL: «#» — не комментарий, имена — в нижнем регистре', () => {
  const m = parseSql(`CREATE TABLE Items (Id INT PRIMARY KEY, flags INT CHECK (flags # 1 >= 0), tags TEXT[]);`);
  assert.deepEqual(m.tables.map(t => t.name), ['items']);
  assert.deepEqual(m.tables[0].columns.map(c => c.name), ['id', 'flags', 'tags']);
  assert.equal(m.tables[0].columns[2].type, 'TEXT[]');
});

test('диаграмма из MySQL: связи и индексы на месте', () => {
  const xml = toGraphModelXml(parseSql(read('mysql.sql')));
  assert.equal([...xml.matchAll(/edge="1"/g)].length, 1);
  assert.match(xml, /🔍 ft_orders_note \(`note`\) USING fulltext/);
  assert.match(xml, /tooltip="Логин"/);
});
