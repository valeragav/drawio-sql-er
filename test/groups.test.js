'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { computeGroups } = require('../src/groups');
const { parseSql } = require('../src/parser');
const { toGraphModelXml } = require('../src/drawio');

const toObj = m => Object.fromEntries(m);

test('группы по префиксам: «_»-префикс и множественное число', () => {
  const names = ['users', 'courses', 'course_modules', 'lessons', 'lesson_progress', 'lesson_assignments',
    'articles', 'article_tags', 'article_tag_links', 'categories', 'category_links', 'payments', 'scratch_a', 'scratch_b'];
  assert.deepEqual(toObj(computeGroups(names, 'prefix')), {
    course: ['courses', 'course_modules'],
    lesson: ['lessons', 'lesson_progress', 'lesson_assignments'],
    article: ['articles', 'article_tags', 'article_tag_links'],
    category: ['categories', 'category_links'],
    scratch: ['scratch_a', 'scratch_b']
  });
});

test('группы по схемам — только если схем больше одной', () => {
  // в public одна таблица — группы из одной не бывает
  assert.deepEqual(toObj(computeGroups(['users', 'billing.invoices', 'billing.payments'], 'schema')),
    { billing: ['billing.invoices', 'billing.payments'] });
  assert.deepEqual(toObj(computeGroups(['users', 'orders', 'billing.invoices', 'billing.payments'], 'schema')),
    { public: ['users', 'orders'], billing: ['billing.invoices', 'billing.payments'] });
  assert.deepEqual(toObj(computeGroups(['users', 'orders'], 'schema')), {});
  assert.deepEqual(toObj(computeGroups(['a', 'b'], 'none')), {});
});

// Разбор геометрии: рамки групп и таблицы.
function frames(xml) {
  const cells = [...xml.matchAll(/<mxCell id="([^"]+)" value="([^"]*)" style="([^"]*)" vertex="1" parent="1"><mxGeometry x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map(m => ({ id: m[1], name: m[2], style: m[3], x: +m[4], y: +m[5], w: +m[6], h: +m[7] }));
  return { groups: cells.filter(c => /sqlErGroup=1/.test(c.style)), tables: cells.filter(c => /sqlErTable=1/.test(c.style)) };
}
const inside = (t, f) => t.x >= f.x && t.y >= f.y && t.x + t.w <= f.x + f.w && t.y + t.h <= f.y + f.h;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('рамки групп: свои таблицы внутри, чужие — не пересекают рамку; рамки не пересекаются', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'examples', 'ecommerce.sql'), 'utf8') + `
    CREATE TABLE order_notes (id INT PRIMARY KEY, order_id BIGINT REFERENCES orders(id));
    CREATE TABLE product_tags (id INT PRIMARY KEY, product_id BIGINT REFERENCES products(id));`;
  const model = parseSql(sql);
  const xml = toGraphModelXml(model, { groupBy: 'prefix' });
  const { groups, tables } = frames(xml);
  const expected = computeGroups(model.tables.map(t => t.name), 'prefix');
  assert.deepEqual(groups.map(g => g.name).sort(), [...expected.keys()].sort());

  for (const g of groups) {
    const members = expected.get(g.name);
    for (const t of tables) {
      if (members.includes(t.name)) assert.ok(inside(t, g), `${t.name} внутри рамки ${g.name}`);
      else assert.ok(!overlaps(t, g), `${t.name} не пересекает рамку ${g.name}`);
    }
  }
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) assert.ok(!overlaps(groups[i], groups[j]), 'рамки не пересекаются');
  }
  // рамки — первыми в XML (позади таблиц)
  assert.ok(xml.indexOf('sqlErGroup=1') < xml.indexOf('sqlErTable=1'));
});

test('без группировки рамок нет', () => {
  const model = parseSql(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ecommerce.sql'), 'utf8'));
  assert.doesNotMatch(toGraphModelXml(model), /sqlErGroup/);
});
