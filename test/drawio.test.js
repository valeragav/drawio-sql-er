'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');
const { toGraphModelXml, columnLabel } = require('../src/drawio');

const shop = parseSql(fs.readFileSync(path.join(__dirname, '..', 'examples', 'shop.sql'), 'utf8'));

function cells(xml) {
  return [...xml.matchAll(/<mxCell ([^>]*?)\/?>/g)].map(m =>
    Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]])));
}

test('подписи колонок: короткие метки', () => {
  const opts = { detail: 'tags', showNullable: true };
  assert.equal(columnLabel({ name: 'id', type: 'SERIAL', primaryKey: true, notNull: true, autoIncrement: true }, opts),
    '🔑 id : SERIAL (PK)');
  assert.equal(columnLabel({ name: 'id', type: 'INTEGER', primaryKey: true, notNull: true, autoIncrement: true }, opts),
    '🔑 id : INTEGER (PK, AI)');
  assert.equal(columnLabel({ name: 'user_id', type: 'INTEGER', foreignKey: true }, opts),
    'user_id : INTEGER (FK, NULL)');
  assert.equal(columnLabel({ name: 'user_id', type: 'INTEGER', foreignKey: true }, { detail: 'tags', showNullable: false }),
    'user_id : INTEGER (FK)');
});

test('таблица на каждую запись, строка на каждую колонку, рёбра ссылаются на существующие ячейки', () => {
  const xml = toGraphModelXml(shop);
  const all = cells(xml);
  const ids = new Set(all.map(c => c.id));
  assert.equal(ids.size, all.length, 'id уникальны');

  const tables = all.filter(c => c.parent === '1' && c.vertex === '1');
  assert.deepEqual(tables.map(c => c.value).sort(), shop.tables.map(t => t.name).sort());

  const rows = all.filter(c => c.vertex === '1' && c.parent !== '1' &&
    !c.style.startsWith('line;') && !c.style.includes('textOpacity'));
  const columnCount = shop.tables.reduce((n, t) => n + t.columns.length, 0);
  assert.equal(rows.length, columnCount);

  const edges = all.filter(c => c.edge === '1');
  assert.equal(edges.length, shop.relations.length);
  for (const e of edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `ребро ${e.id} ссылается на существующие ячейки`);
  }
});

test('без раскраски: нет заданных цветов заливки и линий', () => {
  const xml = toGraphModelXml(shop);
  assert.doesNotMatch(xml, /(fillColor|strokeColor|fontColor)=#/);
});

test('стрелки: обязательный/необязательный родитель, один-ко-многим/один-к-одному', () => {
  const xml = toGraphModelXml(shop);
  const edges = cells(xml).filter(c => c.edge === '1');
  const styles = edges.map(e => e.style);
  // categories.parent_id допускает NULL → ERzeroToOne у родителя
  assert.ok(styles.some(s => s.includes('startArrow=ERzeroToOne') && s.includes('endArrow=ERmany')));
  // invoices.order_id — PK и FK → один к одному
  assert.ok(styles.some(s => s.includes('startArrow=ERmandOne') && s.includes('endArrow=ERzeroToOne')));
  // ссылка на себя рисуется петлёй
  assert.ok(styles.some(s => s.includes('orthogonalEdgeStyle')));
});

test('раскладка: родитель левее ребёнка, таблицы не перекрываются', () => {
  const xml = toGraphModelXml(shop);
  const geo = new Map();
  for (const m of xml.matchAll(/<mxCell id="([^"]+)" value="([^"]*)"[^>]*parent="1"><mxGeometry x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    geo.set(m[2], { x: +m[3], y: +m[4], w: +m[5], h: +m[6] });
  }
  for (const r of shop.relations) {
    if (r.parent !== r.child) assert.ok(geo.get(r.parent).x < geo.get(r.child).x, `${r.parent} левее ${r.child}`);
  }
  const boxes = [...geo.values()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, 'таблицы не перекрываются');
    }
  }
});

test('спецсимволы экранируются', () => {
  const m = parseSql(`CREATE TABLE "a<b>&""c" (x INT);`);
  assert.equal(m.tables[0].name, 'a<b>&"c');
  const xml = toGraphModelXml(m);
  assert.match(xml, /value="a&amp;lt;b&amp;gt;&amp;amp;&quot;c"/);
});

test('индексы: разделитель и строки под колонками, отключаются опцией', () => {
  const xml = toGraphModelXml(shop);
  const all = cells(xml);
  const products = all.find(c => c.value === 'products');
  const rows = all.filter(c => c.parent === products.id);
  const labels = rows.map(r => r.value);
  const divider = rows.findIndex(r => r.style.startsWith('line;'));
  assert.equal(divider, 5, 'разделитель сразу после 5 колонок');
  assert.deepEqual(labels.slice(divider + 1), [
    '🔍 idx_products_category_id (category_id)',
    '🔍 idx_products_tags (tags) USING gin'
  ]);
  assert.ok(labels.includes('🔍 idx_products_tags (tags) USING gin'));

  const orders = all.find(c => c.value === 'orders');
  assert.ok(all.some(c => c.parent === orders.id &&
    c.value === "🔍 idx_orders_active (customer_id) WHERE status &amp;lt;&amp;gt; 'shipped'"));

  const without = cells(toGraphModelXml(shop, { showIndexes: false }));
  assert.ok(!without.some(c => (c.value || '').startsWith('🔍')));
  // у products нет ограничений уровня таблицы — без индексов нет и разделителя
  const productsId = without.find(c => c.value === 'products').id;
  assert.ok(!without.some(c => c.parent === productsId && c.style.startsWith('line;')));
});

test('высота таблицы = сумма строк, строки идут подряд', () => {
  const xml = toGraphModelXml(shop);
  const geo = [...xml.matchAll(/<mxCell id="([^"]+)"[^>]*parent="([^"]+)"><mxGeometry x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)]
    .map(m => ({ id: m[1], parent: m[2], y: +m[3], h: +m[4] }));
  for (const t of geo.filter(g => g.parent === '1')) {
    const rows = geo.filter(g => g.parent === t.id);
    let y = 30;
    for (const r of rows) { assert.equal(r.y, y); y += r.h; }
    assert.equal(t.h, y, `высота ${t.id}`);
  }
});

test('подписи колонок: ограничения как в SQL (по умолчанию)', () => {
  const m = parseSql(`
    CREATE TABLE categories (id INT PRIMARY KEY);
    CREATE TABLE products (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      category_id INT NOT NULL REFERENCES categories(id),
      sku         TEXT NOT NULL UNIQUE,
      description TEXT,
      price       NUMERIC(12,2) NOT NULL CHECK (price >= 0),
      stock       INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT stock_vs_price CHECK (stock < 1000 OR price > 0)
    );
  `);
  const xml = toGraphModelXml(m);
  const labels = cells(xml).filter(c => c.vertex === '1').map(c => c.value);
  for (const expected of [
    '🔑 id : BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
    'category_id : INT NOT NULL REFERENCES categories(id)',
    'sku : TEXT NOT NULL UNIQUE',
    'description : TEXT',
    'price : NUMERIC(12,2) NOT NULL CHECK (price &amp;gt;= 0)',
    'stock : INT NOT NULL DEFAULT 0 CHECK (stock &amp;gt;= 0)',
    'created_at : TIMESTAMPTZ NOT NULL DEFAULT now()',
    'CONSTRAINT stock_vs_price CHECK (stock &amp;lt; 1000 OR price &amp;gt; 0)'
  ]) {
    assert.ok(labels.includes(expected), expected);
  }
});
