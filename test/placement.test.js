'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { placeNewTables } = require('../src/placement');

const box = (name, x, y, width = 200, height = 100) => ({ name, x, y, width, height });
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('новая таблица встаёт справа от родителя, слева от ребёнка, иначе под диаграммой', () => {
  const existing = [box('users', 40, 40), box('orders', 400, 40)];
  const incoming = [
    { name: 'sessions', width: 200, height: 80 },   // ссылается на users → справа от users
    { name: 'regions', width: 180, height: 80 },    // на неё ссылается users → слева от users
    { name: 'logs', width: 200, height: 80 }        // без связей → под диаграммой
  ];
  const relations = [
    { parent: 'users', child: 'orders' },
    { parent: 'users', child: 'sessions' },
    { parent: 'regions', child: 'users' }
  ];
  const pos = placeNewTables(existing, incoming, relations);

  assert.equal(pos.get('sessions').x, 40 + 200 + 120);
  assert.equal(pos.get('regions').x, 40 - 180 - 120);
  assert.ok(pos.get('logs').y > 140, 'logs ниже всех таблиц');

  const all = existing.concat(incoming.map(t => ({ ...t, ...pos.get(t.name) })));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.ok(!overlap(all[i], all[j]), `${all[i].name} и ${all[j].name} не перекрываются`);
    }
  }
});

test('если место справа от родителя занято — сдвигается вниз', () => {
  const existing = [box('users', 40, 40), box('orders', 360, 40, 200, 300)];
  const pos = placeNewTables(existing, [{ name: 'sessions', width: 200, height: 80 }],
    [{ parent: 'users', child: 'sessions' }, { parent: 'users', child: 'orders' }]);
  const s = { name: 'sessions', width: 200, height: 80, ...pos.get('sessions') };
  assert.ok(!overlap(s, existing[1]), 'не на месте orders');
  assert.ok(s.y >= 340, 'ниже orders');
});

test('цепочка новых таблиц цепляется друг за друга', () => {
  const existing = [box('users', 40, 40)];
  const incoming = [
    { name: 'order_items', width: 200, height: 80 },  // ссылается на orders (тоже новую)
    { name: 'orders', width: 200, height: 80 }        // ссылается на users
  ];
  const pos = placeNewTables(existing, incoming,
    [{ parent: 'users', child: 'orders' }, { parent: 'orders', child: 'order_items' }]);
  assert.ok(pos.get('orders').x > 40, 'orders правее users');
  assert.ok(pos.get('order_items').x > pos.get('orders').x, 'order_items правее orders');
});
