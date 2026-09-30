'use strict';

// Сборка DDL из строк системного каталога (без подключения к базе).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDdl } = require('../bridge/introspect');
const { parseSql } = require('../src/parser');

const catalog = {
  tables: [
    { oid: 1, qualified: 'public.users' },
    { oid: 2, qualified: 'public.orders' }
  ],
  columns: [
    { table_oid: 1, attnum: 1, name: 'id', type: 'integer', not_null: true, default_expr: "nextval('users_id_seq'::regclass)", identity: '', generated: '' },
    { table_oid: 1, attnum: 2, name: 'email', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' },
    { table_oid: 2, attnum: 1, name: 'id', type: 'bigint', not_null: true, default_expr: null, identity: 'a', generated: '' },
    { table_oid: 2, attnum: 2, name: 'user_id', type: 'integer', not_null: true, default_expr: null, identity: '', generated: '' },
    { table_oid: 2, attnum: 3, name: 'total', type: 'numeric(12,2)', not_null: true, default_expr: '0', identity: '', generated: '' },
    { table_oid: 2, attnum: 4, name: 'total_x2', type: 'numeric', not_null: false, default_expr: '(total * (2)::numeric)', identity: '', generated: 's' },
    { table_oid: 2, attnum: 5, name: 'note', type: 'text', not_null: false, default_expr: null, identity: '', generated: '' }
  ],
  constraints: [
    { table_oid: 1, name: 'users_pkey', type: 'p', columns: [1], def: 'PRIMARY KEY (id)' },
    { table_oid: 1, name: 'users_email_key', type: 'u', columns: [2], def: 'UNIQUE (email)' },
    { table_oid: 2, name: 'orders_pkey', type: 'p', columns: [1], def: 'PRIMARY KEY (id)' },
    { table_oid: 2, name: 'orders_user_id_fkey', type: 'f', columns: [2], def: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE' },
    { table_oid: 2, name: 'orders_total_check', type: 'c', columns: [3], def: 'CHECK (total >= 0::numeric)' },
    { table_oid: 2, name: 'orders_user_note_key', type: 'u', columns: [2, 5], def: 'UNIQUE (user_id, note)' }
  ],
  indexes: [
    { table_oid: 2, def: 'CREATE INDEX idx_orders_user ON public.orders USING btree (user_id)' }
  ]
};

test('DDL из каталога: serial, identity, inline-ограничения, табличные ограничения, индексы', () => {
  const sql = buildDdl(catalog);
  assert.match(sql, /CREATE TABLE public\.users \(\n {4}id serial PRIMARY KEY,\n {4}email text NOT NULL UNIQUE\n\);/);
  assert.match(sql, / {4}id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,/);
  assert.match(sql, / {4}user_id integer NOT NULL REFERENCES users\(id\) ON DELETE CASCADE,/);
  assert.match(sql, / {4}total numeric\(12,2\) NOT NULL DEFAULT 0 CHECK \(total >= 0\),/);
  assert.match(sql, / {4}total_x2 numeric GENERATED ALWAYS AS \(\(total \* 2\)\) STORED,/);
  assert.match(sql, / {4}CONSTRAINT orders_user_note_key UNIQUE \(user_id, note\)\n\);/);
  assert.match(sql, /CREATE INDEX idx_orders_user ON public\.orders USING btree \(user_id\);/);
});

test('DDL из каталога разбирается парсером в те же таблицы и связи', () => {
  const m = parseSql(buildDdl(catalog));
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.tables.map(t => t.name), ['users', 'orders']);
  assert.deepEqual(m.relations, [
    { parent: 'users', parentColumn: 'id', child: 'orders', childColumn: 'user_id', optional: false, oneToOne: false }
  ]);
  const orders = m.tables.find(t => t.name === 'orders');
  assert.equal(orders.indexes.length, 1);
  assert.equal(orders.columns.find(c => c.name === 'id').autoIncrement, true);
});

test('упрощение выражений, которые PostgreSQL хранит в нормализованном виде', () => {
  const { simplifyExpr } = require('../bridge/introspect');
  const cases = [
    ["CHECK (status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text]))",
      "CHECK (status IN ('draft', 'published', 'archived'))"],
    ["CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))",
      "CHECK (status IN ('a', 'b'))"],
    ["CHECK (kind <> ALL (ARRAY['x'::text, 'y'::text]))", "CHECK (kind NOT IN ('x', 'y'))"],
    ["CHECK ((price >= (0)::numeric))", 'CHECK (price >= 0)'],
    ['CHECK (total >= 0::numeric)', 'CHECK (total >= 0)'],
    ["CHECK (((rating >= 1) AND (rating <= 5)))", 'CHECK ((rating >= 1) AND (rating <= 5))'],
    ["'draft'::text", "'draft'"],
    ["'it''s'::character varying", "'it''s'"],
    ["'{}'::jsonb", "'{}'::jsonb"],
    ["'[]'::text[]", "'[]'::text[]"],
    ['now()', 'now()'],
    ["nextval('users_id_seq'::regclass)", "nextval('users_id_seq'::regclass)"],
    ['CREATE UNIQUE INDEX i ON public.p USING btree (external_id) WHERE (external_id IS NOT NULL)',
      'CREATE UNIQUE INDEX i ON public.p USING btree (external_id) WHERE (external_id IS NOT NULL)']
  ];
  for (const [input, expected] of cases) assert.equal(simplifyExpr(input), expected, input);
});

test('одинаковые ограничения под разными именами показываются один раз, с предупреждением', () => {
  const { buildDdl, duplicateConstraints } = require('../bridge/introspect');
  const check = n => ({ table_oid: 1, name: n, type: 'c', columns: [2],
    def: "CHECK (role = ANY (ARRAY['student'::text, 'admin'::text]))" });
  const cat = {
    tables: [{ oid: 1, name: 'users', qualified: 'public.users' }],
    columns: [
      { table_oid: 1, attnum: 1, name: 'id', type: 'integer', not_null: true, default_expr: null, identity: 'a', generated: '' },
      { table_oid: 1, attnum: 2, name: 'role', type: 'text', not_null: true, default_expr: "'student'::text", identity: '', generated: '' }
    ],
    constraints: [
      { table_oid: 1, name: 'users_pkey', type: 'p', columns: [1], def: 'PRIMARY KEY (id)' },
      check('users_role_check'), check('users_role_check1'), check('users_role_check2'), check('users_role_check3')
    ],
    indexes: []
  };
  const sql = buildDdl(cat);
  assert.equal(sql.match(/CHECK/g).length, 1, 'CHECK один раз');
  assert.match(sql, /role text NOT NULL DEFAULT 'student' CHECK \(role IN \('student', 'admin'\)\)/);
  assert.deepEqual(duplicateConstraints(cat), [
    "users: одинаковое ограничение CHECK (role IN ('student', 'admin')) повторяется 4 раза " +
    '(users_role_check, users_role_check1, users_role_check2, …) — показано один раз'
  ]);
});
