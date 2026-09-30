'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');
const { toMermaid, mermaidType, mermaidName } = require('../src/mermaid');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8');

test('типы и имена приводятся к тому, что принимает Mermaid', () => {
  assert.equal(mermaidType('NUMERIC(12, 2)'), 'NUMERIC(12_2)');
  assert.equal(mermaidType('TIMESTAMP WITH TIME ZONE'), 'TIMESTAMP_WITH_TIME_ZONE');
  assert.equal(mermaidType("enum('a','b')"), 'enum');
  assert.equal(mermaidType('TEXT[]'), 'TEXT[]');
  assert.equal(mermaidName('billing.invoices'), 'billing_invoices');
  assert.equal(mermaidName('User Accounts'), 'User_Accounts');
});

test('erDiagram: сущности, ключи, комментарии, связи', () => {
  const m = parseSql(read('features.sql'));
  const text = toMermaid(m);
  assert.match(text, /^erDiagram\n/);
  assert.match(text, /    %% ENUM order_status: new, paid, refunded, shipped, cancelled/);
  assert.match(text, / {4}users \{\n {8}SERIAL id PK\n {8}TEXT email UK\n {8}user_role role "Роль определяет доступ к разделам"\n {4}\}/);
  assert.match(text, / {4}users \|\|\.\.o\{ orders : "user_id"/);
  assert.match(text, /%% active_orders — представление/);
  assert.match(text, /%% active_orders читает из orders/);
});

test('FK в составе PK: связь «идентифицирующая» (--) и обязательная (||); FK с NULL — |o; один к одному — o|', () => {
  const m = parseSql(`
    CREATE TABLE a (id INT PRIMARY KEY);
    CREATE TABLE b (a_id INT REFERENCES a(id), n INT, PRIMARY KEY (a_id, n));
    CREATE TABLE c (id INT PRIMARY KEY, a_id INT UNIQUE REFERENCES a(id));
  `);
  const text = toMermaid(m);
  assert.match(text, /a \|\|--o\{ b : "a_id"/);
  assert.match(text, /a \|o\.\.o\| c : "a_id"/);
});

test('каждая строка — допустимая для Mermaid (без запятых и пробелов в типах и именах)', () => {
  for (const f of ['ecommerce.sql', 'mysql.sql', 'sqlite.sql', 'features.sql']) {
    const text = toMermaid(parseSql(read(f)));
    for (const line of text.split('\n')) {
      if (!line.trim() || line.trim().startsWith('%%') || /^erDiagram$|\{$|^\s*\}$/.test(line)) continue;
      const attr = /^ {8}(\S+) (\S+)( (PK|FK|UK)(, (PK|FK|UK))*)?( "[^"]*")?$/.exec(line);
      const rel = /^ {4}\S+ (\|\||\|o)(--|\.\.)(o\{|o\|) \S+ : "[^"]*"$/.exec(line);
      assert.ok(attr || rel, `${f}: строка «${line}»`);
    }
  }
  assert.match(toMermaid(parseSql('CREATE TABLE t (id INT);'), { markdown: true }), /^```mermaid\nerDiagram\n[\s\S]*```\n$/);
});
