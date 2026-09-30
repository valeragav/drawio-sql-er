'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');
const { toGraphModelXml } = require('../src/drawio');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8');

// Разбираем сгенерированный XML обратно в геометрию: таблицы, строки, рёбра с точками.
function geometry(xml) {
  const vertices = new Map();
  for (const m of xml.matchAll(/<mxCell id="([^"]+)" value="([^"]*)"[^>]*vertex="1" parent="([^"]+)"><mxGeometry x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    vertices.set(m[1], { id: m[1], name: m[2], parent: m[3], x: +m[4], y: +m[5], w: +m[6], h: +m[7] });
  }
  const abs = id => {
    const v = vertices.get(id);
    if (v.parent === '1') return v;
    const p = vertices.get(v.parent);
    return { ...v, x: p.x + v.x, y: p.y + v.y };
  };
  const tables = [...vertices.values()].filter(v => v.parent === '1');
  const edges = [];
  for (const m of xml.matchAll(/<mxCell id="(sqler-e\d+)" style="([^"]*)" edge="1" parent="1" source="([^"]+)" target="([^"]+)"><mxGeometry relative="1" as="geometry">(.*?)<\/mxGeometry>/g)) {
    const points = [...m[5].matchAll(/<mxPoint x="([\d.-]+)" y="([\d.-]+)"\/>/g)].map(p => ({ x: +p[1], y: +p[2] }));
    edges.push({ id: m[1], style: m[2], source: abs(m[3]), target: abs(m[4]),
      sourceTable: vertices.get(vertices.get(m[3]).parent), targetTable: vertices.get(vertices.get(m[4]).parent), points });
  }
  return { tables, edges };
}

function polyline(e) {
  const start = { x: e.source.x + e.source.w, y: e.source.y + e.source.h / 2 };
  const end = { x: e.target.x, y: e.target.y + e.target.h / 2 };
  return [start, ...e.points, end];
}

// Отрезок проходит через внутренность таблицы?
function crosses(a, b, t) {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  return x1 < t.x + t.w - 1 && x2 > t.x + 1 && y1 < t.y + t.h - 1 && y2 > t.y + 1;
}

for (const example of ['shop.sql', 'ecommerce.sql']) {
  test(`трассировка ${example}: только прямые углы, линии не проходят сквозь таблицы`, () => {
    const { tables, edges } = geometry(toGraphModelXml(parseSql(read(example))));
    const routed = edges.filter(e => e.style.includes('exitX=1;') && e.style.includes('entryX=0;'));
    assert.ok(routed.length >= edges.length - 1, 'почти все связи трассируются (кроме петли на себя)');

    for (const e of routed) {
      const line = polyline(e);
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        assert.ok(a.x === b.x || a.y === b.y, `${e.id}: отрезок ${i} не горизонтальный и не вертикальный`);
        for (const t of tables) {
          assert.ok(!crosses(a, b, t), `${e.id}: отрезок ${i} проходит сквозь таблицу ${t.id}`);
        }
      }
    }
  });
}

test('связи из одной строки идут одним стволом, из разных — по разным дорожкам', () => {
  const { edges } = geometry(toGraphModelXml(parseSql(read('ecommerce.sql'))));
  const firstLane = new Map();
  const routed = edges.filter(e => e.style.includes('exitX=1;') && e.points.length);
  for (const e of routed) {
    const key = `${e.source.id}`;
    const lane = e.points[0].x;
    if (firstLane.has(key)) assert.equal(firstLane.get(key), lane, `ствол ${key}`);
    else firstLane.set(key, lane);
  }
  // разные источники с общим каналом — разные X
  const bySourceTableX = new Map();
  for (const [key, x] of firstLane) {
    const other = [...bySourceTableX].find(([k, v]) => v === x && k !== key);
    assert.ok(!other, `источники ${key} и ${other && other[0]} на одной дорожке`);
    bySourceTableX.set(key, x);
  }
});

test('таблица без родителей встаёт рядом со своими детьми', () => {
  const { edges } = geometry(toGraphModelXml(parseSql(read('ecommerce.sql'))));
  const e = edges.find(x => x.sourceTable.name === 'coupons' && x.targetTable.name === 'orders');
  assert.ok(e, 'связь coupons → orders');
  // соседние столбцы: только спуск по дорожке (две точки), без коридора через столбец
  assert.ok(e.points.length <= 2, 'coupons → orders без перескока через столбец');
});
