'use strict';

// Раскладка: циклы, порядок без пересечений, «окна» длинных связей, группы-блоки,
// сетка таблиц без связей, скорость на большой схеме.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSql } = require('../src/parser');
const { toGraphModelXml } = require('../src/drawio');
const { acyclicOrder } = require('../src/layout');

function geometry(xml) {
  const cells = new Map();
  for (const m of xml.matchAll(/<mxCell id="([^"]+)" value="([^"]*)" style="([^"]*)" vertex="1" parent="([^"]+)"><mxGeometry x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    cells.set(m[1], { id: m[1], name: m[2], style: m[3], parent: m[4], x: +m[5], y: +m[6], w: +m[7], h: +m[8] });
  }
  const top = [...cells.values()].filter(c => c.parent === '1');
  const tables = new Map(top.filter(c => /sqlErTable=1/.test(c.style)).map(c => [c.name, c]));
  const frames = new Map(top.filter(c => /sqlErGroup=1/.test(c.style)).map(c => [c.name, c]));
  const abs = id => {
    const c = cells.get(id);
    if (c.parent === '1') return { ...c, table: c };
    const p = cells.get(c.parent);
    return { ...c, x: p.x + c.x, y: p.y + c.y, table: p };
  };
  const edges = [];
  for (const m of xml.matchAll(/<mxCell id="(sqler-e\d+)" style="([^"]*)" edge="1" parent="1" source="([^"]+)" target="([^"]+)"><mxGeometry relative="1" as="geometry">(.*?)<\/mxGeometry>/g)) {
    const s = abs(m[3]);
    const t = abs(m[4]);
    const points = [...m[5].matchAll(/x="([\d.-]+)" y="([\d.-]+)"/g)].map(p => ({ x: +p[1], y: +p[2] }));
    const line = [{ x: /exitX=1/.test(m[2]) ? s.x + s.w : s.x, y: s.y + s.h / 2 }, ...points,
      { x: /entryX=1/.test(m[2]) ? t.x + t.w : t.x, y: t.y + t.h / 2 }];
    edges.push({ from: s.table.name, to: t.table.name, line });
  }
  return { tables, frames, edges };
}

const through = (a, b, t) => Math.min(a.x, b.x) < t.x + t.w - 1 && Math.max(a.x, b.x) > t.x + 1 &&
  Math.min(a.y, b.y) < t.y + t.h - 1 && Math.max(a.y, b.y) > t.y + 1;

test('циклы ссылок: разворачивается как можно меньше связей', () => {
  // a → b → c → a и c → d: достаточно развернуть одну связь
  const rank = acyclicOrder(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd']]);
  const backward = [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd']].filter(([u, v]) => rank.get(u) > rank.get(v));
  assert.equal(backward.length, 1);
});

test('порядок в столбце: дети встают напротив своих родителей (без «перекрёста»)', () => {
  const m = parseSql(`
    CREATE TABLE p1 (id INT PRIMARY KEY);
    CREATE TABLE p2 (id INT PRIMARY KEY);
    CREATE TABLE c1 (id INT PRIMARY KEY, p INT REFERENCES p2(id));
    CREATE TABLE c2 (id INT PRIMARY KEY, p INT REFERENCES p1(id));`);
  const { tables } = geometry(toGraphModelXml(m));
  const above = (a, b) => tables.get(a).y < tables.get(b).y;
  assert.equal(above('p1', 'p2'), above('c2', 'c1'));
});

test('длинная связь проходит через «окно» между таблицами промежуточного столбца', () => {
  const m = parseSql(`
    CREATE TABLE a (id INT PRIMARY KEY);
    CREATE TABLE b1 (id INT PRIMARY KEY, a_id INT REFERENCES a(id), x TEXT, y TEXT, z TEXT);
    CREATE TABLE b2 (id INT PRIMARY KEY, a_id INT REFERENCES a(id), x TEXT, y TEXT, z TEXT);
    CREATE TABLE c (id INT PRIMARY KEY, b1 INT REFERENCES b1(id), b2 INT REFERENCES b2(id), a_id INT REFERENCES a(id));`);
  const { tables, edges } = geometry(toGraphModelXml(m));
  const long = edges.find(e => e.from === 'a' && e.to === 'c');
  const mid = [tables.get('b1'), tables.get('b2')];
  // горизонталь связи на уровне среднего столбца — не сквозь b1 и b2
  const col = { x: mid[0].x, w: mid[0].w };
  const crossing = long.line.slice(1).map((b, i) => [long.line[i], b])
    .find(([p, q]) => p.y === q.y && Math.min(p.x, q.x) <= col.x && Math.max(p.x, q.x) >= col.x + col.w);
  assert.ok(crossing, 'связь пересекает средний столбец по горизонтали');
  for (const t of mid) assert.ok(!through(crossing[0], crossing[1], t), `не сквозь ${t.name}`);
});

test('группы — блоки: группы на разных столбцах стоят рядом, а не друг под другом', () => {
  const m = parseSql(`
    CREATE TABLE shop_a (id INT PRIMARY KEY);
    CREATE TABLE shop_b (id INT PRIMARY KEY, a INT REFERENCES shop_a(id));
    CREATE TABLE blog_x (id INT PRIMARY KEY, b INT REFERENCES shop_b(id));
    CREATE TABLE blog_y (id INT PRIMARY KEY, x INT REFERENCES blog_x(id));`);
  const { frames } = geometry(toGraphModelXml(m, { groupBy: 'prefix' }));
  const shop = frames.get('shop');
  const blog = frames.get('blog');
  assert.ok(shop && blog);
  assert.ok(shop.x + shop.w < blog.x, 'shop левее blog');
  assert.ok(blog.y < shop.y + shop.h, 'по высоте блоки перекрываются — стоят рядом');
});

test('таблицы без связей — сеткой под схемой, а не столбцом справа', () => {
  const lonely = Array.from({ length: 6 }, (_, i) => `CREATE TABLE lonely${i} (id INT PRIMARY KEY, v TEXT);`).join('\n');
  const m = parseSql(`
    CREATE TABLE a (id INT PRIMARY KEY);
    CREATE TABLE b (id INT PRIMARY KEY, a_id INT REFERENCES a(id));
    ${lonely}`);
  const { tables } = geometry(toGraphModelXml(m));
  const linkedBottom = Math.max(...['a', 'b'].map(n => tables.get(n).y + tables.get(n).h));
  const rows = new Set();
  for (let i = 0; i < 6; i++) {
    const t = tables.get('lonely' + i);
    assert.ok(t.y > linkedBottom, `lonely${i} под схемой`);
    rows.add(t.y);
  }
  assert.ok(rows.size < 6, 'несколько таблиц в ряду');
});

test('большая схема (80 таблиц, 240 связей): быстро, без наложений и линий сквозь таблицы', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const name = i => `${['shop', 'blog', 'user'][i % 3]}_t${i}`;
  let sql = '';
  for (let i = 0; i < 80; i++) {
    sql += `CREATE TABLE ${name(i)} (id INT PRIMARY KEY`;
    if (i) for (let k = 0; k < 3; k++) sql += `, r${k} INT REFERENCES ${name(Math.floor(rnd() * i))}(id)`;
    sql += ', a TEXT);\n';
  }
  const m = parseSql(sql);
  const started = Date.now();
  const xml = toGraphModelXml(m, { groupBy: 'prefix' });
  assert.ok(Date.now() - started < 5000, `раскладка за ${Date.now() - started} мс`);

  const { tables, edges } = geometry(xml);
  const list = [...tables.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.name} и ${b.name} перекрываются`);
    }
  }
  for (const e of edges) {
    if (e.from === e.to) continue;
    for (let k = 1; k < e.line.length; k++) {
      const [p, q] = [e.line[k - 1], e.line[k]];
      assert.ok(p.x === q.x || p.y === q.y, `${e.from}→${e.to}: косой отрезок`);
      for (const t of list) {
        if (t.name !== e.from && t.name !== e.to) assert.ok(!through(p, q, t), `${e.from}→${e.to} сквозь ${t.name}`);
      }
    }
  }
});

// «Перепроложить связи» (page.js) по геометрии страницы: таблицы, строки, линии и
// сохранённые окна (sqlErVia) — так же, как это делает команда.
const { routeLinks } = require('../src/routing');

function pageLinks(xml) {
  const cells = new Map();
  for (const m of xml.matchAll(/(?:<mxCell id="([^"]+)" value="[^"]*"|<UserObject[^>]* id="([^"]+)"><mxCell) style="([^"]*)" vertex="1" parent="([^"]+)"><mxGeometry x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
    const id = m[1] || m[2];
    cells.set(id, { id, style: m[3], parent: m[4], x: +m[5], y: +m[6], w: +m[7], h: +m[8] });
  }
  const tables = [...cells.values()].filter(c => /sqlErTable=1/.test(c.style))
    .map(c => ({ id: c.id, x: c.x, y: c.y, width: c.w, height: c.h }));
  const tableOf = id => (cells.get(id).parent === '1' ? cells.get(id) : cells.get(cells.get(id).parent));
  const rowY = id => {
    const t = tableOf(id);
    const c = cells.get(id);
    return c === t ? t.y + t.h / 2 : t.y + c.y + c.h / 2;
  };
  const links = [];
  const points = [];
  for (const m of xml.matchAll(/<mxCell id="sqler-e\d+" style="([^"]*)" edge="1" parent="1" source="([^"]+)" target="([^"]+)"><mxGeometry relative="1" as="geometry">(.*?)<\/mxGeometry>/g)) {
    const from = tableOf(m[2]);
    const via = /sqlErVia=([^;]*)/.exec(m[1]);
    links.push({ from: from.id, to: tableOf(m[3]).id, key: m[2], sy: rowY(m[2]), ty: rowY(m[3]),
      via: via ? via[1].split(',').map(v => from.y + Number(v)) : undefined });
    points.push([...m[4].matchAll(/x="([\d.-]+)" y="([\d.-]+)"/g)].map(p => ({ x: +p[1], y: +p[2] })));
  }
  return { tables, links, points };
}

const round = pts => pts.map(p => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));

test('«Перепроложить связи» сразу после вставки не меняет линии (окна сохраняются в стиле)', () => {
  const fs = require('fs');
  const path = require('path');
  const model = parseSql(fs.readFileSync(path.join(__dirname, '..', 'examples', 'ecommerce.sql'), 'utf8'));
  for (const groupBy of ['none', 'prefix']) {
    const xml = toGraphModelXml(model, { groupBy });
    assert.match(xml, /sqlErVia=/, 'у длинных связей есть окна');
    const { tables, links, points } = pageLinks(xml);
    const routes = routeLinks(links, tables);
    routes.forEach((r, i) => assert.deepEqual(round(r.points), points[i], `связь ${i} (${groupBy})`));
  }
});

test('окно заняли передвинутой таблицей — связь идёт коридором, не сквозь таблицу', () => {
  const m = parseSql(`
    CREATE TABLE a (id INT PRIMARY KEY);
    CREATE TABLE b1 (id INT PRIMARY KEY, a_id INT REFERENCES a(id), x TEXT, y TEXT, z TEXT);
    CREATE TABLE b2 (id INT PRIMARY KEY, a_id INT REFERENCES a(id), x TEXT, y TEXT, z TEXT);
    CREATE TABLE c (id INT PRIMARY KEY, b1 INT REFERENCES b1(id), b2 INT REFERENCES b2(id), a_id INT REFERENCES a(id));`);
  const { tables, links } = pageLinks(toGraphModelXml(m));
  const i = links.findIndex(l => l.via);
  assert.ok(i >= 0, 'длинная связь с окном');
  // ставим таблицу среднего столбца прямо на окно
  const [from0, to0] = [links[i].from, links[i].to].map(id => tables.find(t => t.id === id));
  const middle = tables.find(t => t.x > from0.x && t.x < to0.x);
  middle.y = links[i].via[0] - 20;
  const routes = routeLinks(links, tables);
  assert.equal(routes[i].via, undefined, 'окно не использовано');
  const from = tables.find(t => t.id === links[i].from);
  const to = tables.find(t => t.id === links[i].to);
  const line = [{ x: from.x + from.width, y: links[i].sy }, ...routes[i].points, { x: to.x, y: links[i].ty }];
  for (let k = 1; k < line.length; k++) {
    for (const t of tables) {
      if (t === from || t === to) continue;
      assert.ok(!through(line[k - 1], line[k], { x: t.x, y: t.y, w: t.width, h: t.height }), `сквозь ${t.id}`);
    }
  }
});
