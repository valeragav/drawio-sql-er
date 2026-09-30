'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');
const { selectTables, withRelated } = require('../src/select');
const { toGraphModelXml } = require('../src/drawio');

const shop = parseSql(fs.readFileSync(path.join(__dirname, '..', 'examples', 'shop.sql'), 'utf8'));

test('выбор таблиц: остаются только выбранные и связи между ними', () => {
  const part = selectTables(shop, ['orders', 'order_items', 'products']);
  assert.deepEqual(part.tables.map(t => t.name), ['products', 'orders', 'order_items']);
  assert.deepEqual(part.relations.map(r => `${r.parent}→${r.child}`).sort(),
    ['orders→order_items', 'products→order_items']);
  // исходная схема не изменилась
  assert.equal(shop.tables.length, 6);
});

test('FK на невыбранную таблицу остаётся в строке колонки, но без линии', () => {
  const part = selectTables(shop, ['orders']);
  const xml = toGraphModelXml(part);
  assert.match(xml, /customer_id : BIGINT NOT NULL/);
  assert.doesNotMatch(xml, /edge="1"/);
});

test('«+ связанные»: добавляет родителей и детей выбранных таблиц (один шаг)', () => {
  assert.deepEqual(withRelated(shop, ['orders']).sort(), ['customers', 'invoices', 'order_items', 'orders']);
  assert.deepEqual(withRelated(shop, ['categories']).sort(), ['categories', 'products']);
  assert.deepEqual(withRelated(shop, []), []);
});
