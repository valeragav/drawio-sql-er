'use strict';

// Разбор PostgreSQL DDL в модель для ER-диаграммы: таблицы (CREATE/ALTER TABLE), индексы,
// перечисления (CREATE/ALTER TYPE … ENUM), представления (CREATE [MATERIALIZED] VIEW)
// и комментарии (COMMENT ON). Всё остальное (функции, INSERT, …) пропускается.

// Слова, на которых заканчивается тип колонки и начинаются её ограничения.
const COLUMN_STOP = new Set([
  'CONSTRAINT', 'NOT', 'NULL', 'PRIMARY', 'REFERENCES', 'UNIQUE', 'DEFAULT',
  'CHECK', 'COLLATE', 'GENERATED', 'DEFERRABLE', 'INITIALLY'
]);

const SERIAL_TYPE = /^(SMALL|BIG)?SERIAL[248]?$/i;

// ---------------------------------------------------------------- токенизатор

function tokenize(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i];

    if (/\s/.test(c)) { i++; continue; }

    if (c === '-' && src[i + 1] === '-') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // В PostgreSQL блочные комментарии могут быть вложенными.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      continue;
    }

    const start = i;

    // Строки: '...', E'...' (с \-экранированием)
    if (c === "'" || ((c === 'E' || c === 'e') && src[i + 1] === "'")) {
      const escapes = c !== "'";
      i += escapes ? 2 : 1;
      while (i < n) {
        if (escapes && src[i] === '\\') { i += 2; continue; }
        if (src[i] === "'") {
          if (src[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: 'string', value: src.slice(start, i), start, end: i });
      continue;
    }

    // Строки в долларовых кавычках: $$...$$, $tag$...$tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = src.indexOf(tag, i + tag.length);
        i = e < 0 ? n : e + tag.length;
        tokens.push({ type: 'string', value: src.slice(start, i), start, end: i });
        continue;
      }
    }

    // Идентификатор в кавычках: "..." ("" — экранированная кавычка)
    if (c === '"') {
      let value = '';
      i++;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += src[i++];
      }
      tokens.push({ type: 'ident', value, start, end: i });
      continue;
    }

    const word = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(src.slice(i, i + 256));
    if (word) {
      i += word[0].length;
      tokens.push({ type: 'word', value: word[0], upper: word[0].toUpperCase(), start, end: i });
      continue;
    }

    const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
    if (num) {
      i += num[0].length;
      tokens.push({ type: 'number', value: num[0], start, end: i });
      continue;
    }

    if (c === ':' && src[i + 1] === ':') {
      i += 2;
      tokens.push({ type: 'punct', value: '::', start, end: i });
      continue;
    }

    i++;
    tokens.push({ type: 'punct', value: c, start, end: i });
  }

  return tokens;
}

function splitStatements(tokens) {
  const statements = [];
  let current = [];
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === ';') {
      if (current.length) statements.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length) statements.push(current);
  return statements;
}

// ---------------------------------------------------------- курсор по токенам

class Cursor {
  constructor(tokens, src) {
    this.tokens = tokens;
    this.src = src;
    this.pos = 0;
  }

  peek(k = 0) { return this.tokens[this.pos + k]; }
  next() { return this.tokens[this.pos++]; }
  done() { return this.pos >= this.tokens.length; }

  isWord(...words) {
    const t = this.peek();
    return !!t && t.type === 'word' && words.includes(t.upper);
  }

  isPunct(value) {
    const t = this.peek();
    return !!t && t.type === 'punct' && t.value === value;
  }

  acceptWord(...words) {
    if (this.isWord(...words)) return this.next();
    return null;
  }

  // Принимает последовательность слов целиком или ничего.
  acceptWords(...words) {
    for (let k = 0; k < words.length; k++) {
      const t = this.peek(k);
      if (!t || t.type !== 'word' || t.upper !== words[k]) return false;
    }
    this.pos += words.length;
    return true;
  }

  // Имя, возможно со схемой: public.users, "My Table"
  name() {
    const parts = [];
    const t = this.peek();
    if (!t || (t.type !== 'word' && t.type !== 'ident')) return null;
    parts.push(identValue(this.next()));
    while (this.isPunct('.') && this.peek(1) && (this.peek(1).type === 'word' || this.peek(1).type === 'ident')) {
      this.next();
      parts.push(identValue(this.next()));
    }
    return parts;
  }

  // Содержимое скобок (без самих скобок); курсор встаёт за ')'.
  group() {
    if (!this.isPunct('(')) return null;
    this.next();
    const inner = [];
    let depth = 1;
    while (!this.done()) {
      const t = this.next();
      if (t.type === 'punct' && t.value === '(') depth++;
      if (t.type === 'punct' && t.value === ')' && --depth === 0) break;
      inner.push(t);
    }
    return inner;
  }

  skipGroup() {
    this.group();
  }

  text(from, to) {
    if (to <= from) return '';
    return this.src.slice(this.tokens[from].start, this.tokens[to - 1].end).replace(/\s+/g, ' ').trim();
  }
}

function identValue(t) {
  // Имена без кавычек PostgreSQL приводит к нижнему регистру.
  return t.type === 'ident' ? t.value : t.value.toLowerCase();
}

function splitTopLevel(tokens) {
  const parts = [];
  let current = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      else if (t.value === ',' && depth === 0) {
        parts.push(current);
        current = [];
        continue;
      }
    }
    current.push(t);
  }
  if (current.length) parts.push(current);
  return parts;
}

function columnList(tokens) {
  return splitTopLevel(tokens)
    .map(part => part.find(t => t.type === 'word' || t.type === 'ident'))
    .filter(Boolean)
    .map(identValue);
}

// ------------------------------------------------------------------- парсер

function parseSql(src) {
  const state = { tables: [], byName: new Map(), enums: [], enumByName: new Map(), comments: [], warnings: [] };

  for (const stmt of splitStatements(tokenize(src))) {
    const cur = new Cursor(stmt, src);
    try {
      if (cur.isWord('CREATE')) parseCreate(cur, state);
      else if (cur.isWord('ALTER')) parseAlter(cur, state);
      else if (cur.isWord('COMMENT')) parseComment(cur, state);
    } catch (err) {
      state.warnings.push(`Не удалось разобрать: ${cur.text(0, Math.min(stmt.length, 8))}… (${err.message})`);
    }
  }

  return finalize(state);
}

function parseCreate(cur, state) {
  cur.next(); // CREATE
  if (cur.isWord('UNIQUE', 'INDEX')) return parseIndex(cur, state);
  cur.acceptWords('OR', 'REPLACE');
  cur.acceptWord('GLOBAL', 'LOCAL');
  cur.acceptWord('TEMP', 'TEMPORARY', 'UNLOGGED');
  if (cur.acceptWord('TYPE')) return parseType(cur, state);
  cur.acceptWord('RECURSIVE');
  if (cur.acceptWords('MATERIALIZED', 'VIEW')) return parseView(cur, state, true);
  if (cur.acceptWord('VIEW')) return parseView(cur, state, false);
  if (!cur.acceptWord('TABLE')) return;
  cur.acceptWords('IF', 'NOT', 'EXISTS');

  const parts = cur.name();
  if (!parts) return;

  // CREATE TABLE ... AS SELECT / PARTITION OF / OF type — колонок в скобках нет.
  const body = cur.group();
  if (!body) return;

  const table = addTable(state, parts);
  if (!table) return;

  for (const item of splitTopLevel(body)) {
    const c = new Cursor(item, cur.src);
    if (isTableConstraint(c)) parseTableConstraint(c, table);
    else if (!c.isWord('LIKE')) parseColumn(c, table);
  }
}

// CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [имя] ON [ONLY] таблица [USING метод]
//   (колонка | (выражение) [COLLATE …] [opclass] [ASC|DESC] [NULLS …], …)
//   [INCLUDE (…)] [NULLS [NOT] DISTINCT] [WITH (…)] [TABLESPACE …] [WHERE условие]
function parseIndex(cur, state) {
  const unique = !!cur.acceptWord('UNIQUE');
  if (!cur.acceptWord('INDEX')) return;
  cur.acceptWord('CONCURRENTLY');
  cur.acceptWords('IF', 'NOT', 'EXISTS');

  let name = null;
  if (!cur.isWord('ON')) {
    const parts = cur.name();
    if (!parts) return;
    name = parts[parts.length - 1];
  }
  if (!cur.acceptWord('ON')) return;
  cur.acceptWord('ONLY');

  const tableParts = cur.name();
  if (!tableParts) return;

  let method = null;
  if (cur.acceptWord('USING')) method = cur.next().value.toLowerCase();

  const group = cur.group();
  if (!group) return;
  const elements = splitTopLevel(group).map(part => tokensText(part, cur.src));

  const index = { name, unique, method, columns: elements, include: [], where: null };

  while (!cur.done()) {
    if (cur.acceptWord('INCLUDE')) { index.include = columnList(cur.group() || []); continue; }
    if (cur.acceptWord('WHERE')) {
      index.where = cur.text(cur.pos, cur.tokens.length);
      break;
    }
    if (cur.acceptWord('WITH')) { cur.skipGroup(); continue; }
    cur.next(); // NULLS [NOT] DISTINCT, TABLESPACE имя
  }

  const table = findTable(state, tableParts);
  if (!table) {
    state.warnings.push(`Индекс${name ? ' ' + name : ''} для неизвестной таблицы ${tableParts.join('.')}`);
    return;
  }
  table.indexes.push(index);
}

function tokensText(tokens, src) {
  if (!tokens.length) return '';
  return src.slice(tokens[0].start, tokens[tokens.length - 1].end).replace(/\s+/g, ' ').trim();
}

function parseAlter(cur, state) {
  cur.next(); // ALTER
  if (cur.acceptWord('TYPE')) return parseAlterType(cur, state);
  if (!cur.acceptWord('TABLE')) return;
  cur.acceptWords('IF', 'EXISTS');
  cur.acceptWord('ONLY');

  const parts = cur.name();
  if (!parts) return;
  cur.acceptWord('ONLY');
  if (cur.isPunct('*')) cur.next();

  const table = findTable(state, parts);
  const rest = cur.tokens.slice(cur.pos);

  for (const action of splitTopLevel(rest)) {
    const c = new Cursor(action, cur.src);

    if (c.acceptWord('ADD')) {
      if (!table) {
        state.warnings.push(`ALTER TABLE для неизвестной таблицы ${parts.join('.')}`);
        return;
      }
      if (isTableConstraint(c)) {
        parseTableConstraint(c, table);
      } else {
        c.acceptWord('COLUMN');
        const ifNotExists = c.acceptWords('IF', 'NOT', 'EXISTS');
        const name = c.peek() && identValue(c.peek());
        const existing = table.columns.find(col => col.name === name);
        if (existing && ifNotExists) continue;
        parseColumn(c, table);
      }
      continue;
    }

    // pg_dump: ALTER TABLE t ALTER COLUMN id ADD GENERATED ... AS IDENTITY (...)
    //          ALTER TABLE ONLY t ALTER COLUMN id SET DEFAULT nextval('seq'::regclass)
    if (table && c.acceptWord('ALTER')) {
      c.acceptWord('COLUMN');
      const colTok = c.next();
      const col = colTok && table.columns.find(x => x.name === identValue(colTok));
      if (!col) continue;
      const tail = action.slice(c.pos).map(t => t.upper || t.value.toLowerCase());
      const joined = tail.join(' ');
      if (joined.startsWith('ADD GENERATED') && tail.includes('IDENTITY')) {
        col.autoIncrement = true;
        // Без параметров последовательности: «GENERATED ALWAYS AS IDENTITY».
        const paren = action.findIndex((t, k) => k > c.pos && t.type === 'punct' && t.value === '(');
        addConstraintText(col, c.text(c.pos + 1, paren < 0 ? action.length : paren));
      } else if (joined.startsWith('SET DEFAULT')) {
        if (tail.includes('NEXTVAL')) col.autoIncrement = true;
        col.default = c.text(c.pos + 2, action.length);
        addConstraintText(col, 'DEFAULT ' + col.default);
      } else if (joined.startsWith('SET NOT NULL')) {
        col.notNull = true;
        addConstraintText(col, 'NOT NULL');
      } else if (joined.startsWith('DROP NOT NULL')) {
        col.notNull = false;
        col.constraints = col.constraints.replace(/\bNOT NULL\b\s*/i, '').trim();
      }
    }
  }
}

function isTableConstraint(c) {
  return c.isWord('CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE');
}

function addConstraintText(col, text) {
  col.constraints = col.constraints ? col.constraints + ' ' + text : text;
}

function parseTableConstraint(c, table) {
  // Текст ограничения как в SQL — для блока под колонками.
  const text = c.text(c.pos, c.tokens.length);
  if (text) table.constraints.push(text);

  if (c.acceptWord('CONSTRAINT')) c.next(); // имя ограничения

  if (c.acceptWords('PRIMARY', 'KEY')) {
    table.primaryKey = columnList(c.group() || []);
  } else if (c.acceptWord('UNIQUE')) {
    c.acceptWords('NULLS', 'NOT', 'DISTINCT') || c.acceptWords('NULLS', 'DISTINCT');
    const cols = columnList(c.group() || []);
    if (cols.length) table.uniques.push(cols);
  } else if (c.acceptWords('FOREIGN', 'KEY')) {
    const columns = columnList(c.group() || []);
    if (!c.acceptWord('REFERENCES')) return;
    const ref = parseReference(c);
    if (columns.length && ref) table.foreignKeys.push({ columns, ...ref });
  }
  // CHECK / EXCLUDE на диаграмме не показываем.
}

function parseReference(c) {
  const refTable = c.name();
  if (!refTable) return null;
  const group = c.isPunct('(') ? c.group() : null;
  return { refTable, refColumns: group ? columnList(group) : null };
}

function parseColumn(c, table) {
  const nameTok = c.next();
  if (!nameTok || (nameTok.type !== 'word' && nameTok.type !== 'ident')) return;

  const col = {
    name: identValue(nameTok),
    type: '',
    notNull: false,
    primaryKey: false,
    unique: false,
    autoIncrement: false,
    default: null,
    constraints: '', // всё после типа, как написано в SQL
    comment: null
  };

  // Тип: всё до первого ключевого слова ограничения (скобки целиком).
  const typeStart = c.pos;
  while (!c.done()) {
    if (c.isPunct('(')) { c.skipGroup(); continue; }
    const t = c.peek();
    if (t.type === 'word' && COLUMN_STOP.has(t.upper)) break;
    c.next();
  }
  col.type = c.text(typeStart, c.pos);
  const constraintsStart = c.pos;
  if (SERIAL_TYPE.test(col.type)) {
    col.autoIncrement = true;
    col.notNull = true;
  }

  while (!c.done()) {
    if (c.acceptWord('CONSTRAINT')) { c.next(); continue; }
    if (c.acceptWords('NOT', 'NULL')) { col.notNull = true; continue; }
    if (c.acceptWord('NULL')) { continue; }
    if (c.acceptWords('PRIMARY', 'KEY')) { col.primaryKey = true; continue; }
    if (c.acceptWord('UNIQUE')) {
      c.acceptWords('NULLS', 'NOT', 'DISTINCT') || c.acceptWords('NULLS', 'DISTINCT');
      col.unique = true;
      continue;
    }
    if (c.acceptWord('REFERENCES')) {
      const ref = parseReference(c);
      if (ref) table.foreignKeys.push({ columns: [col.name], ...ref });
      continue;
    }
    if (c.acceptWord('DEFAULT')) {
      const from = c.pos;
      // Минимум один токен (DEFAULT NULL), дальше — до следующего ограничения.
      if (c.isPunct('(')) c.skipGroup(); else c.next();
      while (!c.done()) {
        if (c.isPunct('(')) { c.skipGroup(); continue; }
        const t = c.peek();
        if (t.type === 'word' && COLUMN_STOP.has(t.upper)) break;
        c.next();
      }
      col.default = c.text(from, c.pos);
      if (/^nextval\s*\(/i.test(col.default)) col.autoIncrement = true;
      continue;
    }
    if (c.acceptWord('CHECK')) { c.skipGroup(); c.acceptWords('NO', 'INHERIT'); continue; }
    if (c.acceptWord('GENERATED')) {
      c.acceptWord('ALWAYS') || c.acceptWords('BY', 'DEFAULT');
      c.acceptWord('AS');
      if (c.acceptWord('IDENTITY')) {
        col.autoIncrement = true;
        col.notNull = true;
        if (c.isPunct('(')) c.skipGroup();
      } else if (c.isPunct('(')) {
        c.skipGroup();
        c.acceptWord('STORED', 'VIRTUAL');
      }
      continue;
    }
    // ON DELETE / ON UPDATE, MATCH FULL, DEFERRABLE, COLLATE "x" и т.п. — пропускаем.
    c.next();
  }

  col.constraints = c.text(constraintsStart, c.tokens.length);
  table.columns.push(col);
}

// ------------------------------------------------------ ENUM, VIEW, COMMENT

// Строковый литерал → значение: 'it''s' → it's, E'a\'b' → a'b, $$…$$ → …
function stringValue(t) {
  if (!t || t.type !== 'string') return null;
  const v = t.value;
  if (/^[Ee]'/.test(v)) return v.slice(2, -1).replace(/\\(.)/g, '$1').replace(/''/g, "'");
  if (v.startsWith('$')) return v.replace(/^\$[^$]*\$/, '').replace(/\$[^$]*\$$/, '');
  return v.slice(1, -1).replace(/''/g, "'");
}

// CREATE TYPE имя AS ENUM ('a', 'b', …) — составные и прочие типы пропускаем.
function parseType(cur, state) {
  const parts = cur.name();
  if (!parts || !cur.acceptWord('AS') || !cur.acceptWord('ENUM')) return;
  const values = (cur.group() || []).filter(t => t.type === 'string').map(stringValue);
  const key = tableKey(parts);
  if (state.enumByName.has(key)) {
    state.warnings.push(`Тип ${parts.join('.')} объявлен повторно — взято первое объявление`);
    return;
  }
  const en = { name: displayName(parts), parts, values, comment: null };
  state.enums.push(en);
  state.enumByName.set(key, en);
}

// ALTER TYPE имя ADD VALUE [IF NOT EXISTS] 'x' [BEFORE | AFTER 'y']  |  RENAME VALUE 'a' TO 'b'.
function parseAlterType(cur, state) {
  const parts = cur.name();
  if (!parts) return;
  const en = findEnum(state, parts);
  if (!en) return;
  if (cur.acceptWords('ADD', 'VALUE')) {
    cur.acceptWords('IF', 'NOT', 'EXISTS');
    const value = stringValue(cur.next());
    if (value === null || en.values.includes(value)) return;
    let at = en.values.length;
    if (cur.isWord('BEFORE', 'AFTER')) {
      const after = cur.next().upper === 'AFTER';
      const i = en.values.indexOf(stringValue(cur.next()));
      if (i >= 0) at = after ? i + 1 : i;
    }
    en.values.splice(at, 0, value);
  } else if (cur.acceptWords('RENAME', 'VALUE')) {
    const from = stringValue(cur.next());
    cur.acceptWord('TO');
    const to = stringValue(cur.next());
    const i = en.values.indexOf(from);
    if (i >= 0 && to !== null) en.values[i] = to;
  }
}

function findEnum(state, parts) {
  const exact = state.enumByName.get(tableKey(parts));
  if (exact) return exact;
  const last = parts[parts.length - 1].toLowerCase();
  const matches = state.enums.filter(e => e.parts[e.parts.length - 1].toLowerCase() === last);
  return matches.length === 1 ? matches[0] : null;
}

// CREATE [MATERIALIZED] VIEW [IF NOT EXISTS] имя [(колонки)] [WITH (…)] AS SELECT …
// Колонки — из списка в скобках или из SELECT (псевдонимы AS, t.col → col, *);
// зависимости — таблицы из FROM / JOIN (кроме имён из WITH).
function parseView(cur, state, materialized) {
  cur.acceptWords('IF', 'NOT', 'EXISTS');
  const parts = cur.name();
  if (!parts) return;
  const explicit = cur.isPunct('(') ? columnList(cur.group()) : null;
  if (cur.acceptWord('WITH')) cur.skipGroup();
  if (!cur.acceptWord('AS')) return;
  const query = cur.tokens.slice(cur.pos);

  const view = addTable(state, parts, materialized ? 'materialized view' : 'view');
  if (!view) return;
  for (const name of explicit || selectColumns(query)) view.columns.push(blankColumn(name));
  view.deps = viewDependencies(query);
}

function blankColumn(name) {
  return {
    name, type: '', notNull: false, primaryKey: false, unique: false,
    autoIncrement: false, default: null, constraints: '', comment: null
  };
}

const isWordTok = (t, ...words) => !!t && t.type === 'word' && words.includes(t.upper);
const isPunctTok = (t, value) => !!t && t.type === 'punct' && t.value === value;

// Имена колонок результата первого SELECT верхнего уровня.
function selectColumns(tokens) {
  const ENDS = ['FROM', 'UNION', 'EXCEPT', 'INTERSECT', 'ORDER', 'LIMIT', 'WHERE', 'GROUP'];
  let depth = 0;
  let start = -1;
  let end = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isPunctTok(t, '(')) depth++;
    else if (isPunctTok(t, ')')) depth--;
    else if (depth === 0 && start < 0 && isWordTok(t, 'SELECT')) start = i + 1;
    else if (depth === 0 && start >= 0 && isWordTok(t, ...ENDS)) {
      end = i;
      break;
    }
  }
  if (start < 0) return [];
  let items = tokens.slice(start, end);
  if (isWordTok(items[0], 'ALL')) items = items.slice(1);
  if (isWordTok(items[0], 'DISTINCT')) {
    items = items.slice(1);
    if (isWordTok(items[0], 'ON') && isPunctTok(items[1], '(')) {
      let d = 0;
      let k = 1;
      for (; k < items.length; k++) {
        if (isPunctTok(items[k], '(')) d++;
        if (isPunctTok(items[k], ')') && --d === 0) break;
      }
      items = items.slice(k + 1);
    }
  }
  return splitTopLevel(items).map(outputName).filter(Boolean);
}

// Имя колонки результата: «expr AS x» → x, «t.col» → col, «col» → col, «expr x» → x, «*» → *.
function outputName(item) {
  if (!item.length) return null;
  const last = item[item.length - 1];
  const prev = item[item.length - 2];
  if (isPunctTok(last, '*')) return '*';
  // Вызов функции без псевдонима — PostgreSQL называет колонку именем функции: upper(x) → upper.
  if (isPunctTok(last, ')') && item[0].type === 'word' && isPunctTok(item[1], '(')) return identValue(item[0]);
  if (last.type === 'ident' || last.type === 'word') {
    if (item.length === 1 || isWordTok(prev, 'AS') || isPunctTok(prev, '.')) return identValue(last);
    if (prev && !(prev.type === 'punct' && prev.value !== ')')) return identValue(last);
  }
  return '?column?';
}

const FROM_STOP = ['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL', 'ON', 'GROUP',
  'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'HAVING', 'WINDOW', 'USING', 'OFFSET', 'FETCH', 'FOR'];

// Таблицы из FROM / JOIN на любой глубине (в подзапросах тоже), кроме имён CTE (WITH x AS …).
function viewDependencies(tokens) {
  const ctes = new Set();
  for (let i = 1; i + 2 < tokens.length; i++) {
    const t = tokens[i];
    if ((t.type === 'word' || t.type === 'ident') && isWordTok(tokens[i + 1], 'AS') &&
        isPunctTok(tokens[i + 2], '(') &&
        (isWordTok(tokens[i - 1], 'WITH', 'RECURSIVE') || isPunctTok(tokens[i - 1], ','))) {
      ctes.add(identValue(t));
    }
  }

  const deps = [];
  const seen = new Set();
  const add = parts => {
    if (parts.length === 1 && ctes.has(parts[0])) return;
    const key = parts.join('.').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deps.push(parts);
    }
  };

  const c = new Cursor(tokens, '');
  while (!c.done()) {
    const t = c.next();
    if (!isWordTok(t, 'FROM', 'JOIN')) continue;
    for (;;) {
      c.acceptWord('ONLY', 'LATERAL');
      if (c.isPunct('(')) break; // подзапрос — его FROM встретим дальше
      const parts = c.name();
      if (!parts) break;
      if (c.isPunct('(')) break; // функция: FROM generate_series(…)
      add(parts);
      if (t.upper === 'JOIN') break;
      c.acceptWord('AS');
      const next = c.peek();
      if (next && (next.type === 'ident' || (next.type === 'word' && !FROM_STOP.includes(next.upper)))) {
        c.next();
        if (c.isPunct('(')) c.skipGroup(); // псевдоним со списком колонок
      }
      if (!c.isPunct(',')) break;
      c.next();
    }
  }
  return deps;
}

// COMMENT ON TABLE | VIEW | MATERIALIZED VIEW | TYPE имя IS '…' | NULL;  COMMENT ON COLUMN t.c IS '…'.
function parseComment(cur, state) {
  cur.next(); // COMMENT
  if (!cur.acceptWord('ON')) return;
  let kind;
  if (cur.acceptWords('MATERIALIZED', 'VIEW')) kind = 'view';
  else if (cur.isWord('TABLE', 'VIEW', 'TYPE', 'COLUMN')) kind = cur.next().upper.toLowerCase();
  else return;
  const parts = cur.name();
  if (!parts || !cur.acceptWord('IS')) return;
  const tok = cur.next();
  const text = isWordTok(tok, 'NULL') ? null : stringValue(tok);
  state.comments.push({ kind, parts, text });
}

// ------------------------------------------------------------------ таблицы

function tableKey(parts) {
  return parts.join('.').toLowerCase();
}

function addTable(state, parts, kind = 'table') {
  const key = tableKey(parts);
  if (state.byName.has(key)) {
    state.warnings.push(`Таблица ${parts.join('.')} объявлена повторно — взято первое объявление`);
    return null;
  }
  const table = {
    name: displayName(parts),
    parts,
    kind, // 'table' | 'view' | 'materialized view'
    comment: null,
    deps: [], // для представлений: таблицы из FROM / JOIN
    columns: [],
    primaryKey: [],
    uniques: [],
    foreignKeys: [],
    indexes: [],
    constraints: [] // ограничения уровня таблицы, как написаны в SQL
  };
  state.tables.push(table);
  state.byName.set(key, table);
  return table;
}

function displayName(parts) {
  return parts.length > 1 && parts[parts.length - 2] === 'public'
    ? parts[parts.length - 1]
    : parts.join('.');
}

// Сначала точное совпадение (со схемой), потом — только по имени таблицы.
function findTable(state, parts) {
  const exact = state.byName.get(tableKey(parts));
  if (exact) return exact;
  const last = parts[parts.length - 1].toLowerCase();
  const matches = state.tables.filter(t => t.parts[t.parts.length - 1].toLowerCase() === last);
  return matches.length === 1 ? matches[0] : null;
}

// ------------------------------------------------------------ итоговая модель

// Имя колонки из элемента индекса ("email", "\"Email\" DESC"); для выражений — null.
function indexColumnName(element) {
  const m = /^("(?:[^"]|"")+"|[A-Za-z_\u0080-￿][\w$\u0080-￿]*)(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?$/i.exec(element);
  if (!m) return null;
  return m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1].toLowerCase();
}

function sameSet(a, b) {
  return a.length === b.length && a.every(x => b.includes(x));
}

function finalize(state) {
  const { tables, warnings } = state;

  for (const table of tables) {
    // PRIMARY KEY на колонке и на таблице — приводим к одному виду.
    const inlinePk = table.columns.filter(c => c.primaryKey).map(c => c.name);
    if (!table.primaryKey.length) table.primaryKey = inlinePk;

    for (const col of table.columns) {
      col.primaryKey = table.primaryKey.includes(col.name);
      if (col.primaryKey) col.notNull = true;
      col.foreignKey = false;
    }

    for (const cols of table.uniques) {
      if (cols.length === 1) {
        const col = table.columns.find(c => c.name === cols[0]);
        if (col) col.unique = true;
      }
    }
    table.compositeUniques = table.uniques.filter(u => u.length > 1);

    // Уникальный индекс без WHERE по обычным колонкам работает как UNIQUE-ограничение:
    // помечаем колонку UQ и учитываем его при определении связи «один к одному».
    table.uniqueIndexSets = [];
    for (const ix of table.indexes) {
      if (!ix.unique || ix.where) continue;
      const cols = ix.columns.map(indexColumnName);
      if (!cols.every(n => n && table.columns.some(c => c.name === n))) continue;
      table.uniqueIndexSets.push(cols);
      if (cols.length === 1) table.columns.find(c => c.name === cols[0]).unique = true;
    }
  }

  const relations = [];

  for (const child of tables) {
    for (const fk of child.foreignKeys) {
      for (const name of fk.columns) {
        const col = child.columns.find(c => c.name === name);
        if (col) col.foreignKey = true;
      }

      const parent = findTable(state, fk.refTable);
      if (!parent) {
        warnings.push(`${child.name}: ссылка на неизвестную таблицу ${fk.refTable.join('.')}`);
        continue;
      }

      const refColumns = fk.refColumns && fk.refColumns.length ? fk.refColumns : parent.primaryKey;
      if (!refColumns.length) {
        warnings.push(`${child.name}: у таблицы ${parent.name} нет первичного ключа для ссылки`);
        continue;
      }

      const childCols = fk.columns.map(n => child.columns.find(c => c.name === n)).filter(Boolean);
      const singleUniques = child.columns.filter(c => c.unique).map(c => [c.name]);
      const oneToOne = sameSet(fk.columns, child.primaryKey) ||
        child.uniques.concat(singleUniques, child.uniqueIndexSets).some(u => sameSet(u, fk.columns));

      const relation = {
        parent: parent.name,
        parentColumn: refColumns[0],
        child: child.name,
        childColumn: fk.columns[0],
        // Может ли у дочерней записи не быть родителя (FK допускает NULL).
        optional: childCols.some(c => !c.notNull),
        oneToOne
      };
      // Составной ключ: остальные пары колонок (рисуются пунктиром рядом с основной линией).
      if (fk.columns.length > 1) {
        relation.extraColumns = fk.columns.slice(1)
          .map((childColumn, k) => ({ parentColumn: refColumns[k + 1], childColumn }))
          .filter(pair => pair.parentColumn);
      }
      relations.push(relation);
    }
  }

  // COMMENT ON … — в конце, потому что pg_dump пишет комментарии после всех объектов.
  for (const cm of state.comments) {
    if (cm.kind === 'column') {
      if (cm.parts.length < 2) continue;
      const table = findTable(state, cm.parts.slice(0, -1));
      const col = table && table.columns.find(c => c.name === cm.parts[cm.parts.length - 1]);
      if (col) col.comment = cm.text;
    } else if (cm.kind === 'type') {
      const en = findEnum(state, cm.parts);
      if (en) en.comment = cm.text;
    } else {
      const table = findTable(state, cm.parts);
      if (table) table.comment = cm.text;
    }
  }

  // Колонки типа-перечисления (в т.ч. массивы: status[]) → связь с блоком ENUM.
  const enumLinks = [];
  for (const table of tables) {
    for (const col of table.columns) {
      if (!col.type) continue;
      // Имя типа как в PostgreSQL: без кавычек — в нижний регистр, в кавычках — как есть.
      const base = col.type.replace(/\s*\[\]$/, '').replace(/\s+ARRAY$/i, '');
      const typeParts = base.split('.').map(p => (/^".*"$/.test(p) ? p.slice(1, -1) : p.toLowerCase()));
      const en = findEnum(state, typeParts);
      if (en) enumLinks.push({ enum: en.name, table: table.name, column: col.name });
    }
  }

  // Представление ← таблицы (и другие представления) из его FROM / JOIN.
  const viewDeps = [];
  for (const view of tables) {
    for (const parts of view.deps) {
      const source = findTable(state, parts);
      if (source && source !== view) viewDeps.push({ table: source.name, view: view.name });
    }
  }

  return {
    enums: state.enums.map(e => ({ name: e.name, values: e.values.slice(), comment: e.comment })),
    enumLinks,
    viewDeps,
    tables: tables.map(t => ({
      name: t.name,
      kind: t.kind,
      comment: t.comment,
      columns: t.columns.map(c => ({
        name: c.name,
        type: c.type,
        primaryKey: c.primaryKey,
        foreignKey: c.foreignKey,
        unique: c.unique,
        notNull: c.notNull,
        autoIncrement: c.autoIncrement,
        default: c.default,
        constraints: c.constraints,
        comment: c.comment
      })),
      primaryKey: t.primaryKey,
      compositeUniques: t.compositeUniques,
      constraints: t.constraints,
      indexes: t.indexes
    })),
    relations,
    warnings
  };
}

module.exports = { parseSql, tokenize };
