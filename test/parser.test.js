'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSql } = require('../src/parser');

const table = (model, name) => model.tables.find(t => t.name === name);
const column = (model, t, c) => table(model, t).columns.find(x => x.name === c);

test('колонки, типы и ограничения', () => {
  const m = parseSql(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      price NUMERIC(10, 2) DEFAULT 0 NOT NULL,
      tags TEXT[] DEFAULT '{}'::text[],
      seen TIMESTAMP WITH TIME ZONE,
      note TEXT DEFAULT 'a -- not a comment; still a string'
    );
  `);
  assert.deepEqual(m.warnings, []);
  const u = table(m, 'users');
  assert.deepEqual(u.columns.map(c => c.name), ['id', 'email', 'price', 'tags', 'seen', 'note']);
  assert.deepEqual(u.columns.map(c => c.type), [
    'SERIAL', 'VARCHAR(255)', 'NUMERIC(10, 2)', 'TEXT[]', 'TIMESTAMP WITH TIME ZONE', 'TEXT'
  ]);
  assert.equal(column(m, 'users', 'id').primaryKey, true);
  assert.equal(column(m, 'users', 'id').autoIncrement, true);
  assert.equal(column(m, 'users', 'email').unique, true);
  assert.equal(column(m, 'users', 'email').notNull, true);
  assert.equal(column(m, 'users', 'price').notNull, true);
  assert.equal(column(m, 'users', 'price').default, '0');
  assert.equal(column(m, 'users', 'tags').default, "'{}'::text[]");
  assert.equal(column(m, 'users', 'seen').notNull, false);
});

test('связи: инлайн REFERENCES, FOREIGN KEY, ссылка на PK по умолчанию', () => {
  const m = parseSql(`
    CREATE TABLE a (id INT PRIMARY KEY);
    CREATE TABLE b (
      id INT PRIMARY KEY,
      a_id INT NOT NULL REFERENCES a ON DELETE CASCADE,
      a2 INT,
      CONSTRAINT fk FOREIGN KEY (a2) REFERENCES a (id)
    );
  `);
  assert.deepEqual(m.relations, [
    { parent: 'a', parentColumn: 'id', child: 'b', childColumn: 'a_id', optional: false, oneToOne: false },
    { parent: 'a', parentColumn: 'id', child: 'b', childColumn: 'a2', optional: true, oneToOne: false }
  ]);
  assert.equal(column(m, 'b', 'a_id').foreignKey, true);
  assert.equal(column(m, 'b', 'a2').foreignKey, true);
});

test('один к одному: FK = PK или FK UNIQUE', () => {
  const m = parseSql(`
    CREATE TABLE p (id INT PRIMARY KEY);
    CREATE TABLE one (p_id INT PRIMARY KEY REFERENCES p(id));
    CREATE TABLE two (id INT PRIMARY KEY, p_id INT UNIQUE REFERENCES p(id));
    CREATE TABLE many (id INT PRIMARY KEY, p_id INT REFERENCES p(id));
  `);
  const byChild = Object.fromEntries(m.relations.map(r => [r.child, r.oneToOne]));
  assert.deepEqual(byChild, { one: true, two: true, many: false });
});

test('составной PK и составной UNIQUE', () => {
  const m = parseSql(`
    CREATE TABLE t (
      a INT NOT NULL,
      b TEXT NOT NULL,
      c INT,
      PRIMARY KEY (a, b),
      UNIQUE (b, c)
    );
  `);
  const t = table(m, 't');
  assert.deepEqual(t.primaryKey, ['a', 'b']);
  assert.deepEqual(t.columns.filter(c => c.primaryKey).map(c => c.name), ['a', 'b']);
  assert.deepEqual(t.compositeUniques, [['b', 'c']]);
});

test('ALTER TABLE ADD COLUMN / ADD CONSTRAINT', () => {
  const m = parseSql(`
    CREATE TABLE langs (id SERIAL PRIMARY KEY);
    CREATE TABLE courses (id SERIAL PRIMARY KEY);
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS language_id INTEGER REFERENCES langs(id) ON DELETE SET NULL;
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS language_id INTEGER;
    ALTER TABLE courses ADD title TEXT NOT NULL, ADD CONSTRAINT courses_title_key UNIQUE (title);
  `);
  const c = table(m, 'courses');
  assert.deepEqual(c.columns.map(x => x.name), ['id', 'language_id', 'title']);
  assert.equal(column(m, 'courses', 'title').unique, true);
  assert.equal(m.relations.length, 1);
  assert.equal(m.relations[0].optional, true);
});

test('формат pg_dump: схема public, ключи через ALTER TABLE ONLY', () => {
  const m = parseSql(`
    SET statement_timeout = 0;
    CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

    CREATE TABLE public.users (
        id integer NOT NULL,
        name text
    );
    CREATE SEQUENCE public.users_id_seq AS integer START WITH 1;
    ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

    CREATE TABLE public.posts (
        id integer NOT NULL,
        user_id integer NOT NULL
    );
    ALTER TABLE public.posts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
        SEQUENCE NAME public.posts_id_seq START WITH 1
    );

    ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.posts ADD CONSTRAINT posts_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.posts
        ADD CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  `);
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.tables.map(t => t.name), ['users', 'posts']);
  assert.equal(column(m, 'users', 'id').primaryKey, true);
  assert.equal(column(m, 'users', 'id').autoIncrement, true);
  assert.equal(column(m, 'posts', 'id').autoIncrement, true);
  assert.deepEqual(m.relations, [
    { parent: 'users', parentColumn: 'id', child: 'posts', childColumn: 'user_id', optional: false, oneToOne: false }
  ]);
});

test('имена в кавычках и другие схемы', () => {
  const m = parseSql(`
    CREATE TABLE "User Accounts" ("ID" INT PRIMARY KEY, "Name" TEXT);
    CREATE TABLE billing.invoices (id INT PRIMARY KEY, acc INT REFERENCES "User Accounts"("ID"));
  `);
  assert.deepEqual(m.tables.map(t => t.name), ['User Accounts', 'billing.invoices']);
  assert.equal(m.relations[0].parentColumn, 'ID');
});

test('ссылка на себя и неизвестную таблицу', () => {
  const m = parseSql(`
    CREATE TABLE cat (id INT PRIMARY KEY, parent_id INT REFERENCES cat(id));
    CREATE TABLE x (id INT PRIMARY KEY, y_id INT REFERENCES nowhere(id));
  `);
  assert.equal(m.relations.length, 1);
  assert.equal(m.relations[0].parent, 'cat');
  assert.equal(m.relations[0].child, 'cat');
  assert.equal(column(m, 'x', 'y_id').foreignKey, true);
  assert.equal(m.warnings.length, 1);
  assert.match(m.warnings[0], /nowhere/);
});

test('комментарии, вложенные /* */ и прочие инструкции пропускаются', () => {
  const m = parseSql(`
    /* внешний /* вложенный */ всё ещё комментарий; */
    -- CREATE TABLE fake (id INT);
    CREATE INDEX idx ON t(a);
    INSERT INTO t VALUES ('; CREATE TABLE nope (id int);');
    COMMENT ON TABLE t IS 'x';
    CREATE TABLE t (a INT);
    CREATE VIEW v AS SELECT 1;
  `);
  assert.deepEqual(m.tables.filter(t => t.kind === 'table').map(t => t.name), ['t']);
  assert.deepEqual(m.tables.filter(t => t.kind === 'view').map(t => t.name), ['v']);
});

test('пример examples/shop.sql', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'examples', 'shop.sql'), 'utf8');
  const m = parseSql(sql);
  assert.deepEqual(m.warnings, []);
  assert.equal(m.tables.length, 6);
  assert.equal(m.relations.length, 6);
  const inv = m.relations.find(r => r.child === 'invoices');
  assert.equal(inv.oneToOne, true);
  assert.equal(column(m, 'categories', 'id').autoIncrement, true);
  assert.equal(column(m, 'products', 'tags').type, 'TEXT[]');
});

test('CREATE INDEX: имя, метод, выражения, INCLUDE, WHERE', () => {
  const m = parseSql(`
    CREATE TABLE public.t (id INT PRIMARY KEY, a TEXT, b INT, "Mixed" INT, tags TEXT[]);
    CREATE INDEX idx_a ON t (a);
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_ab ON ONLY public.t USING btree (a, b DESC NULLS LAST) INCLUDE (tags);
    CREATE INDEX idx_tags ON t USING gin (tags) WITH (fastupdate = off);
    CREATE INDEX ON t (lower(a), ("Mixed" + 1));
    CREATE UNIQUE INDEX idx_b_partial ON t (b) WHERE b IS NOT NULL AND a <> 'x';
    CREATE INDEX idx_missing ON nowhere (x);
  `);
  const ix = table(m, 't').indexes;
  assert.deepEqual(ix.map(i => i.name), ['idx_a', 'idx_ab', 'idx_tags', null, 'idx_b_partial']);
  assert.deepEqual(ix[1], {
    name: 'idx_ab', unique: true, method: 'btree',
    columns: ['a', 'b DESC NULLS LAST'], include: ['tags'], where: null
  });
  assert.equal(ix[2].method, 'gin');
  assert.deepEqual(ix[3].columns, ['lower(a)', '("Mixed" + 1)']);
  assert.equal(ix[4].where, "b IS NOT NULL AND a <> 'x'");
  assert.equal(m.warnings.length, 1);
  assert.match(m.warnings[0], /idx_missing.*nowhere/);
});

test('уникальный индекс без WHERE помечает колонку UQ и даёт связь один к одному', () => {
  const m = parseSql(`
    CREATE TABLE p (id INT PRIMARY KEY);
    CREATE TABLE c (id INT PRIMARY KEY, p_id INT NOT NULL REFERENCES p(id), code TEXT, x INT);
    CREATE UNIQUE INDEX c_p_id_key ON c (p_id);
    CREATE UNIQUE INDEX c_code_partial ON c (code) WHERE code IS NOT NULL;
    CREATE UNIQUE INDEX c_x_expr ON c ((x + 1));
  `);
  assert.equal(column(m, 'c', 'p_id').unique, true);
  assert.equal(column(m, 'c', 'code').unique, false);
  assert.equal(column(m, 'c', 'x').unique, false);
  assert.equal(m.relations[0].oneToOne, true);
});

test('текст ограничений колонки и таблицы сохраняется как в SQL', () => {
  const m = parseSql(`
    CREATE TABLE t (
      id SERIAL PRIMARY KEY,
      a   TEXT   NOT NULL
              DEFAULT 'x',
      b INT,
      UNIQUE (a, b),
      CHECK (b > 0)
    );
    ALTER TABLE ONLY t ALTER COLUMN b SET DEFAULT 5;
    ALTER TABLE t ALTER COLUMN b SET NOT NULL;
    ALTER TABLE ONLY t ADD CONSTRAINT t_b_uq UNIQUE (b);
  `);
  assert.equal(column(m, 't', 'id').constraints, 'PRIMARY KEY');
  assert.equal(column(m, 't', 'a').constraints, "NOT NULL DEFAULT 'x'");
  assert.equal(column(m, 't', 'b').constraints, 'DEFAULT 5 NOT NULL');
  assert.deepEqual(table(m, 't').constraints, ['UNIQUE (a, b)', 'CHECK (b > 0)', 'CONSTRAINT t_b_uq UNIQUE (b)']);
});

test('pg_dump: GENERATED ... AS IDENTITY без параметров последовательности', () => {
  const m = parseSql(`
    CREATE TABLE public.posts (id integer NOT NULL);
    ALTER TABLE public.posts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
        SEQUENCE NAME public.posts_id_seq START WITH 1
    );
  `);
  assert.equal(column(m, 'posts', 'id').constraints, 'NOT NULL GENERATED ALWAYS AS IDENTITY');
});
