/*! drawio-sql-er 0.1.0 — draw.io plugin: PostgreSQL DDL → ER diagram */
(function () {
  var defs = {}, cache = {};
  function require(name) {
    var key = name.replace(/^\.\//, '');
    if (!cache[key]) {
      var module = cache[key] = { exports: {} };
      defs[key](module, module.exports, require);
    }
    return cache[key].exports;
  }

  defs["parser"] = function (module, exports, require) {
'use strict';

// Разбор PostgreSQL DDL (CREATE TABLE / ALTER TABLE) в модель для ER-диаграммы.
// Всё остальное (индексы, функции, INSERT, COMMENT ON ...) пропускается.

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
  const state = { tables: [], byName: new Map(), warnings: [] };

  for (const stmt of splitStatements(tokenize(src))) {
    const cur = new Cursor(stmt, src);
    try {
      if (cur.isWord('CREATE')) parseCreate(cur, state);
      else if (cur.isWord('ALTER')) parseAlter(cur, state);
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
    constraints: '' // всё после типа, как написано в SQL
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

// ------------------------------------------------------------------ таблицы

function tableKey(parts) {
  return parts.join('.').toLowerCase();
}

function addTable(state, parts) {
  const key = tableKey(parts);
  if (state.byName.has(key)) {
    state.warnings.push(`Таблица ${parts.join('.')} объявлена повторно — взято первое объявление`);
    return null;
  }
  const table = {
    name: displayName(parts),
    parts,
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

  return {
    tables: tables.map(t => ({
      name: t.name,
      columns: t.columns.map(c => ({
        name: c.name,
        type: c.type,
        primaryKey: c.primaryKey,
        foreignKey: c.foreignKey,
        unique: c.unique,
        notNull: c.notNull,
        autoIncrement: c.autoIncrement,
        default: c.default,
        constraints: c.constraints
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

  };

  defs["routing"] = function (module, exports, require) {
'use strict';

// Ортогональная трассировка связей между таблицами.
//
// Таблицы группируются в «столбцы» по фактическому расположению (пересекающиеся по X).
// Между соседними столбцами — свободный канал, в нём вертикальные «дорожки».
// Связь из строки родителя в строку ребёнка:
//   - выходит сбоку до своей дорожки в ближайшем канале;
//   - если таблицы в соседних столбцах — идёт по дорожке до строки ребёнка и входит сбоку;
//   - иначе идёт по горизонтальному «коридору» между таблицами промежуточных столбцов
//     до дорожки в канале у ребёнка, а оттуда — к его строке.
// Связи из одной строки (один источник) делят дорожку — «ствол» с ответвлениями,
// разные источники идут по разным дорожкам. Каналы и коридоры свободны от таблиц,
// поэтому линии не проходят сквозь таблицы.
//
// Работает и для только что построенной раскладки, и для таблиц, которые пользователь
// передвинул (команда «Перепроложить связи»).

const LANE_SPACING = 12;  // расстояние между соседними дорожками в канале
const GAP_PADDING = 36;   // от таблицы до крайней дорожки (место под значки связи)
const MIN_GAP = 100;
const TRACK_STEP = 10;    // шаг горизонтальных дорожек в коридоре
const CLEARANCE = 14;     // отступ коридора от таблиц
const LOOP_OFFSET = 30;   // петля «ссылка на себя» — слева от таблицы

// Столбцы по фактическому расположению: таблицы, пересекающиеся по X, — в одном столбце.
function deriveColumns(tables) {
  const sorted = tables.slice().sort((a, b) => a.x - b.x);
  const columns = [];
  for (const t of sorted) {
    const last = columns[columns.length - 1];
    if (last && t.x < last.right) {
      last.tables.push(t);
      last.right = Math.max(last.right, t.x + t.width);
    } else {
      columns.push({ left: t.x, right: t.x + t.width, tables: [t] });
    }
  }
  const columnOf = new Map();
  columns.forEach((c, i) => c.tables.forEach(t => columnOf.set(t.id, i)));
  return { columns, columnOf };
}

// Какие каналы использует связь: номер канала g — промежуток справа от столбца g.
function gapsOf(link, columnOf) {
  if (link.from === link.to) return [];
  const a = columnOf.get(link.from);
  const b = columnOf.get(link.to);
  if (a < b) return b - 1 === a ? [a] : [a, b - 1];
  if (a > b) return a - 1 === b ? [b] : [a - 1, b];
  return [a];
}

// Дорожки в каждом канале: ключ источника → номер дорожки.
// Порядок — по высоте строки-источника, чтобы стволы меньше пересекались.
function planLanes(links, columnOf) {
  const perGap = new Map();
  for (const link of links) {
    for (const g of gapsOf(link, columnOf)) {
      if (!perGap.has(g)) perGap.set(g, new Map());
      perGap.get(g).set(link.key, link.sy);
    }
  }
  const lanes = new Map();
  for (const [gap, keys] of perGap) {
    const ordered = [...keys].sort((p, q) => p[1] - q[1]).map(([k]) => k);
    lanes.set(gap, new Map(ordered.map((k, i) => [k, i])));
  }
  return lanes;
}

// Ширина канала под заданное число дорожек (для построения раскладки).
function gapWidth(lanes, gap) {
  const n = lanes.has(gap) ? lanes.get(gap).size : 0;
  return Math.max(MIN_GAP, GAP_PADDING * 2 + Math.max(0, n - 1) * LANE_SPACING);
}

// Свободные по вертикали интервалы, общие для набора таблиц.
function freeIntervals(obstacles) {
  const blocked = obstacles
    .map(b => [b.y - CLEARANCE, b.y + b.height + CLEARANCE])
    .sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const iv of blocked) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  }
  const free = [];
  let lo = -Infinity;
  for (const [s, e] of merged) {
    free.push([lo, s]);
    lo = e;
  }
  free.push([lo, Infinity]);
  return free;
}

function candidateTracks(free) {
  const ys = [];
  for (const [lo, hi] of free) {
    if (lo === -Infinity) {
      for (let k = 0; k < 40; k++) ys.push(hi - k * TRACK_STEP);
    } else if (hi === Infinity) {
      for (let k = 0; k < 40; k++) ys.push(lo + k * TRACK_STEP);
    } else {
      const mid = (lo + hi) / 2;
      ys.push(mid);
      for (let d = TRACK_STEP; mid - d >= lo || mid + d <= hi; d += TRACK_STEP) {
        if (mid - d >= lo) ys.push(mid - d);
        if (mid + d <= hi) ys.push(mid + d);
      }
    }
  }
  return ys;
}

// tables: [{ id, x, y, width, height }] — все таблицы (препятствия и столбцы);
// links:  [{ from, to, key, sy, ty }] — связи: таблица-родитель, таблица-ребёнок,
//         ключ источника (строка родителя) и абсолютные Y строк.
// Возвращает массив (по индексу связи): { points: [{x, y}], exit: 'left'|'right', entry: 'left'|'right' }.
function routeLinks(links, tables) {
  const { columns, columnOf } = deriveColumns(tables);
  const lanes = planLanes(links, columnOf);
  const byId = new Map(tables.map(t => [t.id, t]));

  // Дорожки размещаются в фактической ширине канала; если он узкий — плотнее.
  const laneX = (gap, key) => {
    const left = columns[gap].right;
    const right = gap + 1 < columns.length ? columns[gap + 1].left : left + gapWidth(lanes, gap);
    const width = right - left;
    const n = lanes.get(gap).size;
    const pad = Math.min(GAP_PADDING, width / 4);
    const spacing = n > 1 ? Math.min(LANE_SPACING, (width - 2 * pad) / (n - 1)) : 0;
    return left + pad + lanes.get(gap).get(key) * spacing;
  };

  const horizontals = []; // занятые горизонтальные отрезки коридоров
  const conflicts = (y, x1, x2, key) => horizontals.some(h =>
    h.key !== key && Math.abs(h.y - y) < TRACK_STEP - 1 &&
    Math.min(h.x1, h.x2) < Math.max(x1, x2) && Math.min(x1, x2) < Math.max(h.x1, h.x2));

  function corridor(fromCol, toCol, x1, x2, target, key) {
    const middle = [];
    for (let c = Math.min(fromCol, toCol) + 1; c < Math.max(fromCol, toCol); c++) middle.push(...columns[c].tables);
    const tracks = candidateTracks(freeIntervals(middle))
      .sort((p, q) => Math.abs(p - target) - Math.abs(q - target));
    const found = tracks.find(t => !conflicts(t, x1, x2, key));
    const y = found === undefined ? tracks[0] : found;
    horizontals.push({ y, x1, x2, key });
    return y;
  }

  // Сначала короткие связи — им достаются коридоры ближе к прямой линии.
  const span = l => l.from === l.to ? 0 : Math.abs(columnOf.get(l.to) - columnOf.get(l.from));
  const order = links.map((l, i) => i).sort((i, j) => span(links[i]) - span(links[j]) || i - j);

  const routes = [];
  for (const i of order) {
    const link = links[i];
    const { sy, ty, key } = link;

    if (link.from === link.to) {
      const px = byId.get(link.from).x - LOOP_OFFSET;
      routes[i] = { points: [{ x: px, y: sy }, { x: px, y: ty }], exit: 'left', entry: 'left' };
      continue;
    }

    const a = columnOf.get(link.from);
    const b = columnOf.get(link.to);

    if (a === b) {
      // Обе таблицы в одном столбце — по дорожке справа от столбца.
      const x = laneX(a, key);
      routes[i] = { points: [{ x, y: sy }, { x, y: ty }], exit: 'right', entry: 'right' };
      continue;
    }

    const forward = a < b;
    const firstGap = forward ? a : a - 1;
    const lastGap = forward ? b - 1 : b;
    const x1 = laneX(firstGap, key);
    const side = { exit: forward ? 'right' : 'left', entry: forward ? 'left' : 'right' };

    if (firstGap === lastGap) {
      routes[i] = { points: sy === ty ? [] : [{ x: x1, y: sy }, { x: x1, y: ty }], ...side };
      continue;
    }

    const x2 = laneX(lastGap, key);
    const y = corridor(a, b, x1, x2, (sy + ty) / 2, key);
    routes[i] = { points: [{ x: x1, y: sy }, { x: x1, y }, { x: x2, y }, { x: x2, y: ty }], ...side };
  }
  return routes;
}

module.exports = { routeLinks, planLanes, gapWidth, deriveColumns };

  };

  defs["placement"] = function (module, exports, require) {
'use strict';

// Куда поставить новые таблицы при обновлении диаграммы, не двигая существующие.
//
// Новая таблица встаёт:
//   - справа от своего родителя (таблицы, на которую ссылается), если он уже на странице;
//   - иначе слева от своего ребёнка (таблицы, которая ссылается на неё);
//   - иначе под всей диаграммой.
// Если место занято — сдвигается вниз, пока не найдёт свободное.
// Сначала ставятся таблицы, у которых соседи уже на странице, — от них потом цепляются остальные.

const H_GAP = 120;
const V_GAP = 40;
const STEP = 20;
const MAX_STEPS = 400;

const overlaps = (a, b) =>
  a.x < b.x + b.width + V_GAP && b.x < a.x + a.width + V_GAP &&
  a.y < b.y + b.height + V_GAP && b.y < a.y + a.height + V_GAP;

// existing: [{ name, x, y, width, height }] — таблицы, которые остаются на месте;
// incoming: [{ name, width, height }] — новые таблицы;
// relations: [{ parent, child }] — связи по именам таблиц.
// Возвращает Map: имя новой таблицы → { x, y }.
function placeNewTables(existing, incoming, relations) {
  const placed = new Map(existing.map(t => [t.name, t]));
  const occupied = existing.slice();
  const result = new Map();

  const parentsOf = name => relations.filter(r => r.child === name && r.parent !== name).map(r => r.parent);
  const childrenOf = name => relations.filter(r => r.parent === name && r.child !== name).map(r => r.child);

  const bottom = () => occupied.length ? Math.max(...occupied.map(t => t.y + t.height)) : 0;
  const left = () => occupied.length ? Math.min(...occupied.map(t => t.x)) : 0;

  function freeSpot(box) {
    for (let k = 0; k < MAX_STEPS; k++) {
      const candidate = { ...box, y: box.y + k * STEP };
      if (!occupied.some(o => overlaps(candidate, o))) return candidate;
    }
    return { ...box, y: bottom() + V_GAP * 2 };
  }

  const pending = incoming.slice();
  while (pending.length) {
    // Таблица, у которой есть уже поставленный сосед; если таких нет — первая по порядку.
    let index = pending.findIndex(t =>
      parentsOf(t.name).some(p => placed.has(p)) || childrenOf(t.name).some(c => placed.has(c)));
    if (index < 0) index = 0;
    const table = pending.splice(index, 1)[0];

    const parent = parentsOf(table.name).map(p => placed.get(p)).find(Boolean);
    const child = childrenOf(table.name).map(c => placed.get(c)).find(Boolean);

    let start;
    if (parent) start = { x: parent.x + parent.width + H_GAP, y: parent.y };
    else if (child) start = { x: child.x - table.width - H_GAP, y: child.y };
    else start = { x: left(), y: bottom() + V_GAP * 2 };

    const spot = freeSpot({ name: table.name, x: start.x, y: start.y, width: table.width, height: table.height });
    placed.set(table.name, spot);
    occupied.push(spot);
    result.set(table.name, { x: spot.x, y: spot.y });
  }
  return result;
}

module.exports = { placeNewTables };

  };

  defs["select"] = function (module, exports, require) {
'use strict';

// Выбор части таблиц схемы (для больших схем, когда на страницу нужна только часть).

// Схема только с таблицами из names; связи — только между выбранными таблицами.
// Внешние ключи на невыбранные таблицы остаются в строках колонок (REFERENCES …), но без линий.
function selectTables(schema, names) {
  const keep = new Set(names);
  return Object.assign({}, schema, {
    tables: schema.tables.filter(t => keep.has(t.name)),
    relations: schema.relations.filter(r => keep.has(r.parent) && keep.has(r.child))
  });
}

// Выбранные таблицы + их непосредственные соседи (родители и дети).
function withRelated(schema, names) {
  const selected = new Set(names);
  const result = new Set(names);
  for (const r of schema.relations) {
    if (selected.has(r.parent)) result.add(r.child);
    if (selected.has(r.child)) result.add(r.parent);
  }
  return schema.tables.map(t => t.name).filter(n => result.has(n));
}

module.exports = { selectTables, withRelated };

  };

  defs["drawio"] = function (module, exports, require) {
'use strict';

// Модель из parser.js → XML графа draw.io (mxGraphModel).
// Таблица — swimlane со стек-раскладкой, каждая колонка — отдельная строка-ячейка,
// связи соединяют строки (PK родителя → FK ребёнка) в нотации «воронья лапка».

const { planLanes, gapWidth, routeLinks } = require('./routing');

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 30;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480; // длиннее — строка переносится
const CHAR_WIDTH = 6.4;
const H_GAP = 120; // начальный промежуток между столбцами (до расчёта дорожек)
const LINE_HEIGHT = 14; // прибавка к высоте строки на каждую перенесённую строку
const V_GAP = 40;
const MARGIN = 40;

const TABLE_STYLE =
  'swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=' + HEADER_HEIGHT + ';' +
  'horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;' +
  'marginBottom=0;html=1;sqlErTable=1;';

// whiteSpace=wrap — длинные ограничения и индексы переносятся, а не обрезаются.
const ROW_STYLE =
  'text;align=left;verticalAlign=middle;spacingLeft=8;spacingRight=8;overflow=hidden;whiteSpace=wrap;' +
  'rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;html=1;';

const NOTE_STYLE = ROW_STYLE + 'fontSize=11;textOpacity=60;';
const NOTE_HEIGHT = 20;

// Разделитель между колонками и блоком индексов/ограничений (как в ER-фигурах draw.io).
const DIVIDER_STYLE =
  'line;strokeWidth=1;fillColor=none;align=left;verticalAlign=middle;spacingTop=-1;' +
  'spacingLeft=3;spacingRight=3;rotatable=0;labelPosition=right;points=[];portConstraint=eastwest;';
const DIVIDER_HEIGHT = 8;

const DEFAULTS = {
  showNullable: true,
  showIndexes: true,
  detail: 'sql',
  x: 0,
  y: 0
};

// ------------------------------------------------------------- строки таблиц

// detail: 'sql' — после типа всё, что написано у колонки в SQL (NOT NULL, DEFAULT, CHECK…);
//         'tags' — короткие метки (PK, FK, UQ, AI, NULL).
function columnLabel(col, opts) {
  if (opts.detail !== 'tags') {
    let label = (col.primaryKey ? '🔑 ' : '') + col.name;
    if (col.type) label += ' : ' + col.type;
    if (col.constraints) label += ' ' + col.constraints;
    return label;
  }

  const tags = [];
  if (col.primaryKey) tags.push('PK');
  if (col.foreignKey) tags.push('FK');
  if (col.unique && !col.primaryKey) tags.push('UQ');
  if (col.autoIncrement && !/serial/i.test(col.type)) tags.push('AI');
  if (opts.showNullable && !col.notNull) tags.push('NULL');

  let label = (col.primaryKey ? '🔑 ' : '') + col.name;
  if (col.type) label += ' : ' + col.type;
  if (tags.length) label += ' (' + tags.join(', ') + ')';
  return label;
}

function fontStyle(col) {
  // 1 — жирный (PK), 2 — курсив (FK), 3 — оба.
  return (col.primaryKey ? 1 : 0) | (col.foreignKey ? 2 : 0);
}

function indexLabel(index) {
  let label = '🔍 ' + (index.unique ? 'UNIQUE ' : '') + (index.name ? index.name + ' ' : '') +
    '(' + index.columns.join(', ') + ')';
  if (index.method && index.method.toLowerCase() !== 'btree') label += ' USING ' + index.method;
  if (index.include.length) label += ' INCLUDE (' + index.include.join(', ') + ')';
  if (index.where) label += ' WHERE ' + index.where;
  return label;
}

// Строки таблицы: колонки, затем (через разделитель) составные UNIQUE и индексы.
// y — смещение строки от верха таблицы.
function buildRows(table, opts) {
  const rows = table.columns.map(col => ({
    column: col.name,
    label: columnLabel(col, opts),
    style: ROW_STYLE + (fontStyle(col) ? 'fontStyle=' + fontStyle(col) + ';' : ''),
    height: ROW_HEIGHT
  }));

  const notes = opts.detail === 'tags'
    ? (table.compositeUniques || []).map(cols => 'UNIQUE (' + cols.join(', ') + ')')
    : (table.constraints || []).slice();
  if (opts.showIndexes) notes.push(...(table.indexes || []).map(indexLabel));
  if (notes.length) {
    rows.push({ column: null, label: '', style: DIVIDER_STYLE, height: DIVIDER_HEIGHT, divider: true });
    notes.forEach(label => rows.push({ column: null, label, style: NOTE_STYLE, height: NOTE_HEIGHT, note: true }));
  }
  return rows;
}

const TEXT_PADDING = 16; // spacingLeft + spacingRight у строки
const WIDTH_SLACK = 6;   // запас, чтобы текст не упирался в край
const WRAP_WASTE = 0.9;  // при переносе по словам строка заполняется не до конца

// Ширина текста строки: в draw.io плагин передаёт точное измерение (opts.measureText),
// без браузера (тесты) — оценка по числу символов.
function rowTextWidth(row, measure) {
  return measure(row.label, row.note ? 11 : 12, /fontStyle=[13];/.test(row.style));
}

// Ширина таблицы; строки, которые в неё не влезли, переносятся — считаем их высоту и Y.
function sizeRows(table, rows, measure) {
  const widest = Math.max(measure(table.name, 12, true) + 40,
    ...rows.map(r => rowTextWidth(r, measure) + TEXT_PADDING + WIDTH_SLACK));
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(widest / 10) * 10));
  const available = width - TEXT_PADDING;
  let y = HEADER_HEIGHT;
  for (const row of rows) {
    if (!row.divider) {
      const text = rowTextWidth(row, measure);
      const lines = text <= available ? 1 : Math.ceil(text / (available * WRAP_WASTE));
      row.height += (lines - 1) * (row.note ? LINE_HEIGHT - 2 : LINE_HEIGHT);
    }
    row.y = y;
    y += row.height;
  }
  return { width, height: y };
}

// Оценка ширины без браузера: средняя ширина символа Helvetica 12px (сверено с draw.io);
// жирный шрифт шире примерно на 10%, эмодзи — шире обычного символа.
function estimateTextWidth(text, fontSize = 12, bold = false) {
  const emoji = /^(🔑|🔍)/.test(text) ? 8 : 0;
  return (Array.from(text).length * CHAR_WIDTH * fontSize / 12 + emoji) * (bold ? 1.1 : 1);
}

// ------------------------------------------------------------------ раскладка

// Уровень таблицы = 1 + максимальный уровень её родителей (таблиц, на которые она ссылается).
// Корневые таблицы (без FK) — в первом столбце, дочерние — правее.
function computeLevels(tables, relations) {
  const parents = new Map(tables.map(t => [t.name, new Set()]));
  for (const r of relations) {
    if (r.parent !== r.child) parents.get(r.child).add(r.parent);
  }

  const level = new Map();
  const visiting = new Set();

  function visit(name) {
    if (level.has(name)) return level.get(name);
    if (visiting.has(name)) return 0; // цикл ссылок — разрываем
    visiting.add(name);
    let lvl = 0;
    for (const p of parents.get(name)) lvl = Math.max(lvl, visit(p) + 1);
    visiting.delete(name);
    level.set(name, lvl);
    return lvl;
  }

  tables.forEach(t => visit(t.name));

  // Сдвигаем таблицы вправо, насколько позволяют дети: таблица встаёт в столбец
  // прямо перед ближайшим ребёнком, чтобы связи не перескакивали через столбцы
  // (например, справочник, на который ссылается только одна «далёкая» таблица).
  const children = new Map(tables.map(t => [t.name, []]));
  for (const r of relations) {
    if (r.parent !== r.child) children.get(r.parent).push(r.child);
  }
  const byLevelDesc = tables.map(t => t.name).sort((a, b) => level.get(b) - level.get(a));
  for (const name of byLevelDesc) {
    const kids = children.get(name).filter(c => level.get(c) > level.get(name));
    if (!kids.length || kids.length !== children.get(name).length) continue;
    const target = Math.min(...kids.map(c => level.get(c))) - 1;
    if (target > level.get(name)) level.set(name, target);
  }

  return { level, parents, children };
}

function layout(model, opts) {
  const { tables, relations } = model;
  const { level, parents, children } = computeLevels(tables, relations);

  const connected = new Set();
  for (const r of relations) {
    connected.add(r.parent);
    connected.add(r.child);
  }

  const boxes = new Map();
  for (const t of tables) {
    const rows = buildRows(t, opts);
    const { width, height } = sizeRows(t, rows, opts.measureText || estimateTextWidth);
    boxes.set(t.name, { table: t, rows, width, height, x: 0, y: 0 });
  }

  // Столбцы по уровням; таблицы без связей — отдельным столбцом в конце.
  const columns = [];
  const isolated = [];
  for (const t of tables) {
    if (!connected.has(t.name)) { isolated.push(t.name); continue; }
    const lvl = level.get(t.name);
    (columns[lvl] = columns[lvl] || []).push(t.name);
  }
  const compact = columns.filter(Boolean);
  if (isolated.length) compact.push(isolated);

  const centerY = name => boxes.get(name).y + boxes.get(name).height / 2;

  function stack(names, x) {
    let y = opts.y + MARGIN;
    for (const name of names) {
      const box = boxes.get(name);
      box.x = x;
      box.y = y;
      y += box.height + V_GAP;
    }
  }

  // Сортировка столбца по среднему положению соседей (метод барицентров).
  // Таблица без соседей в нужную сторону остаётся на своём текущем месте.
  function sortBy(names, neighbours) {
    const keys = new Map(names.map(n => {
      const ys = neighbours(n).map(centerY);
      return [n, ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : centerY(n)];
    }));
    return names.slice().sort((a, b) => keys.get(a) - keys.get(b));
  }

  // Суммарная вертикальная длина связей — чем меньше, тем аккуратнее диаграмма.
  const cost = () => relations.reduce((sum, r) => sum + Math.abs(centerY(r.parent) - centerY(r.child)), 0);

  const columnX = [];
  let x = opts.x + MARGIN;
  compact.forEach((names, i) => {
    columnX[i] = x;
    stack(names, x);
    x += Math.max(...names.map(n => boxes.get(n).width)) + H_GAP;
  });

  // Несколько проходов туда-обратно: слева направо тянемся к родителям,
  // справа налево — к детям. Запоминаем лучший вариант.
  const snapshot = () => compact.map(c => c.slice());
  let best = snapshot();
  let bestCost = cost();
  const last = isolated.length ? compact.length - 1 : compact.length;

  for (let pass = 0; pass < 8; pass++) {
    const forward = pass % 2 === 0;
    for (let k = 0; k < last; k++) {
      const i = forward ? k : last - 1 - k;
      const neighbours = forward ? n => Array.from(parents.get(n)) : n => children.get(n);
      compact[i] = sortBy(compact[i], neighbours);
      stack(compact[i], columnX[i]);
    }
    const c = cost();
    if (c < bestCost) {
      bestCost = c;
      best = snapshot();
    }
  }

  best.forEach((names, i) => stack(names, columnX[i]));

  // Порядок в столбцах выбран — теперь ширина каналов между столбцами
  // под число дорожек связей и окончательные координаты X.
  const columnOf = new Map();
  best.forEach((names, i) => names.forEach(n => columnOf.set(n, i)));
  const rowCenter = (table, column) => {
    const box = boxes.get(table);
    const row = box.rows.find(r => r.column === column);
    return box.y + (row ? row.y + row.height / 2 : box.height / 2);
  };
  const lanes = planLanes(buildLinks(relations, rowCenter), columnOf);
  const columnWidth = best.map(names => Math.max(...names.map(n => boxes.get(n).width)));

  x = opts.x + MARGIN;
  best.forEach((names, i) => {
    columnX[i] = x;
    stack(names, x);
    x += columnWidth[i] + gapWidth(lanes, i);
  });

  return { boxes, rowCenter };
}

// Линии для связей: основная — по первой паре колонок внешнего ключа;
// для составного ключа остальные пары — дополнительные (пунктир без значков).
// from/to — таблицы, key — строка-источник (общий «ствол»), sy/ty — Y строк.
function buildLinks(relations, rowCenter) {
  const links = [];
  relations.forEach(rel => {
    const pairs = [{ parentColumn: rel.parentColumn, childColumn: rel.childColumn }]
      .concat(rel.extraColumns || []);
    pairs.forEach((pair, k) => links.push({
      rel,
      primary: k === 0,
      parentColumn: pair.parentColumn,
      childColumn: pair.childColumn,
      from: rel.parent,
      to: rel.child,
      key: rel.parent + '\u0000' + pair.parentColumn,
      sy: rowCenter(rel.parent, pair.parentColumn),
      ty: rowCenter(rel.child, pair.childColumn)
    }));
  });
  return links;
}

// ---------------------------------------------------------------------- XML

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function vertex(id, parent, value, style, x, y, w, h) {
  return `<mxCell id="${id}" value="${escapeXml(escapeHtml(value))}" style="${escapeXml(style)}" vertex="1" parent="${parent}">` +
    `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}

// Основная линия — значки «вороньей лапки»; дополнительная (часть составного ключа) —
// тонкий пунктир без значков. Везде — дуги-«мостики» на пересечениях.
// sqlErLink=1 — метка «наша связь» для команды «Перепроложить связи».
function linkStyle(link) {
  const common = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jumpStyle=arc;jumpSize=8;sqlErLink=1;';
  if (!link.primary) return common + 'dashed=1;dashPattern=4 3;startArrow=none;endArrow=none;opacity=70;';
  const start = link.rel.optional ? 'ERzeroToOne' : 'ERmandOne';
  const end = link.rel.oneToOne ? 'ERzeroToOne' : 'ERmany';
  return common + `startArrow=${start};endArrow=${end};startFill=0;endFill=0;`;
}

// С какой стороны строки выходит и в какую входит линия.
function sideStyle(route) {
  const exitX = route.exit === 'right' ? 1 : 0;
  const entryX = route.entry === 'right' ? 1 : 0;
  return `exitX=${exitX};exitY=0.5;exitDx=0;exitDy=0;exitPerimeter=0;` +
    `entryX=${entryX};entryY=0.5;entryDx=0;entryDy=0;entryPerimeter=0;`;
}

function pointsXml(points) {
  if (!points.length) return '';
  // Без округления до целых: центр строки бывает дробным (например, 222.5),
  // и округлённая точка дала бы косой отрезок в полпикселя.
  const n = v => Math.round(v * 100) / 100;
  return '<Array as="points">' + points.map(p => `<mxPoint x="${n(p.x)}" y="${n(p.y)}"/>`).join('') + '</Array>';
}

function toGraphModelXml(model, options) {
  const opts = Object.assign({}, DEFAULTS, options);
  const { boxes, rowCenter } = layout(model, opts);

  const links = buildLinks(model.relations, rowCenter);
  const obstacles = [...boxes.values()].map(b => ({ id: b.table.name, x: b.x, y: b.y, width: b.width, height: b.height }));
  const routes = routeLinks(links, obstacles);

  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const rowIds = new Map(); // "таблица\u0000колонка" → id строки
  const tableIds = new Map();

  let t = 0;
  for (const box of boxes.values()) {
    const tableId = 'sqler-t' + t++;
    tableIds.set(box.table.name, tableId);
    // sqlErName — имя таблицы для режима «Обновить» (подпись пользователь может поменять).
    const tableStyle = TABLE_STYLE + 'sqlErName=' + encodeURIComponent(box.table.name) + ';';
    cells.push(vertex(tableId, '1', box.table.name, tableStyle, box.x, box.y, box.width, box.height));
    box.rows.forEach((row, i) => {
      const rowId = tableId + '-r' + i;
      if (row.column) rowIds.set(box.table.name + '\u0000' + row.column, rowId);
      cells.push(vertex(rowId, tableId, row.label, row.style, 0, row.y, box.width, row.height));
    });
  }

  links.forEach((link, i) => {
    const source = rowIds.get(link.from + '\u0000' + link.parentColumn) || tableIds.get(link.from);
    const target = rowIds.get(link.to + '\u0000' + link.childColumn) || tableIds.get(link.to);
    if (!source || !target) return;
    const route = routes[i];
    const style = linkStyle(link) + sideStyle(route);
    cells.push(`<mxCell id="sqler-e${i}" style="${escapeXml(style)}" edge="1" parent="1" source="${source}" target="${target}">` +
      `<mxGeometry relative="1" as="geometry">${pointsXml(route.points)}</mxGeometry></mxCell>`);
  });

  return `<mxGraphModel><root>${cells.join('')}</root></mxGraphModel>`;
}

module.exports = { toGraphModelXml, columnLabel, indexLabel, sideStyle };

  };

  defs["page"] = function (module, exports, require) {
'use strict';

// Операции над таблицами и связями, уже стоящими на странице draw.io:
//   - «Перепроложить связи» — заново проложить линии по текущим положениям таблиц;
//   - «Обновить» — привести диаграмму к новой схеме, не двигая существующие таблицы.
// Таблицы плагина помечены в стиле sqlErTable=1 (и sqlErName=<имя>), связи — sqlErLink=1.

const { toGraphModelXml, sideStyle } = require('./drawio');
const { routeLinks } = require('./routing');
const { placeNewTables } = require('./placement');
const { selectTables } = require('./select');

const hasFlag = (style, flag) => new RegExp('(^|;)' + flag + '=1(;|$)').test(style || '');

function styleValue(style, key) {
  const m = new RegExp('(?:^|;)' + key + '=([^;]*)').exec(style || '');
  return m ? m[1] : null;
}

function helpers(graph) {
  const model = graph.getModel();
  const isTable = c => model.isVertex(c) && hasFlag(model.getStyle(c), 'sqlErTable');
  const isLink = c => model.isEdge(c) && hasFlag(model.getStyle(c), 'sqlErLink');
  const tableOf = cell => {
    let c = cell;
    while (c && !isTable(c)) c = model.getParent(c);
    return c;
  };
  // Имя таблицы: из метки sqlErName, для старых диаграмм — из подписи.
  const nameOf = c => {
    const encoded = styleValue(model.getStyle(c), 'sqlErName');
    if (encoded) {
      try { return decodeURIComponent(encoded); } catch (e) { /* ниже — подпись */ }
    }
    return String(graph.convertValueToString(c) || '');
  };
  // Все связи плагина на странице. Связь, у которой оба конца в одной таблице (ссылка
  // на себя), draw.io кладёт внутрь этой таблицы — поэтому ищем по всем потомкам слоя.
  const linksOf = layer => model.getDescendants(layer).filter(isLink);
  // Начало координат ячейки-родителя относительно слоя (точки связи задаются в нём).
  const originOf = (cell, layer) => {
    let x = 0;
    let y = 0;
    for (let c = cell; c && c !== layer; c = model.getParent(c)) {
      const g = model.getGeometry(c);
      if (g && !g.relative) {
        x += g.x;
        y += g.y;
      }
    }
    return { x, y };
  };
  return { model, isTable, isLink, tableOf, nameOf, linksOf, originOf, geo: c => model.getGeometry(c) };
}

// -------------------------------------------------- «Перепроложить связи»

// Заново прокладывает все связи плагина на текущей странице. Возвращает число связей.
function reroute(ui) {
  const graph = ui.editor.graph;
  const layer = graph.getDefaultParent();
  const { model, isTable, tableOf, linksOf, originOf, geo } = helpers(graph);

  const tables = graph.getChildVertices(layer).filter(isTable)
    .map(c => ({ id: c.id, x: geo(c).x, y: geo(c).y, width: geo(c).width, height: geo(c).height }));

  // Y середины строки (или середины таблицы, если связь к самой таблице).
  const rowY = (row, table) => {
    const t = geo(table);
    if (row === table) return t.y + t.height / 2;
    const r = geo(row);
    return t.y + r.y + r.height / 2;
  };

  const links = [];
  const edges = [];
  for (const e of linksOf(layer)) {
    const s = model.getTerminal(e, true);
    const t = model.getTerminal(e, false);
    const ts = tableOf(s);
    const tt = tableOf(t);
    if (!ts || !tt || model.getParent(ts) !== layer || model.getParent(tt) !== layer) continue;
    links.push({ from: ts.id, to: tt.id, key: s.id, sy: rowY(s, ts), ty: rowY(t, tt) });
    edges.push(e);
  }
  if (!links.length) return 0;

  const routes = routeLinks(links, tables);

  model.beginUpdate();
  try {
    edges.forEach((e, i) => {
      const route = routes[i];
      let style = model.getStyle(e);
      for (const pair of sideStyle(route).split(';').filter(Boolean)) {
        const [key, value] = pair.split('=');
        style = mxUtils.setStyle(style, key, value);
      }
      model.setStyle(e, style);
      const g = geo(e).clone();
      const o = originOf(model.getParent(e), layer);
      g.points = route.points.map(p => new mxPoint(p.x - o.x, p.y - o.y));
      model.setGeometry(e, g);
    });
  } finally {
    model.endUpdate();
  }
  return links.length;
}

// ------------------------------------------------------------- «Обновить»

// Приводит таблицы плагина на текущей странице к схеме model:
//   - существующие таблицы остаются на месте, у них заменяются строки (колонки,
//     ограничения, индексы); ручные правки стиля таблицы сохраняются;
//   - новые таблицы ставятся рядом со связанными;
//   - таблицы, которых нет в схеме, помечаются (пунктир, полупрозрачно), а не удаляются;
//   - связи пересобираются и перепрокладываются.
// selected — отмеченные в окне таблицы: какие новые добавить. Таблицы, уже стоящие
// на странице, обновляются всегда; неотмеченные таблицы схемы удалёнными не считаются.
// Всё — одна операция (один Ctrl+Z). Возвращает сводку или { error }.
function updatePage(ui, fullSchema, opts, selected) {
  const graph = ui.editor.graph;
  const layer = graph.getDefaultParent();
  const { model, isTable, nameOf, linksOf, geo } = helpers(graph);

  const pageTables = new Map();
  for (const c of graph.getChildVertices(layer)) {
    if (isTable(c)) pageTables.set(nameOf(c), c);
  }
  if (!pageTables.size) {
    return { error: 'На странице нет таблиц, вставленных плагином, — используйте «Вставить».' };
  }

  const inSchema = new Set(fullSchema.tables.map(t => t.name));
  const wanted = new Set(selected || inSchema);
  for (const name of pageTables.keys()) if (inSchema.has(name)) wanted.add(name);
  const schema = selectTables(fullSchema, [...wanted]);

  // Свежая диаграмма по новой схеме — из неё берём строки, размеры и связи.
  const doc = mxUtils.parseXml(toGraphModelXml(schema, opts));
  const fresh = new mxGraphModel();
  new mxCodec(doc).decode(doc.documentElement, fresh);
  const freshLayer = fresh.getChildAt(fresh.getRoot(), 0);
  const freshCells = fresh.getChildren(freshLayer) || [];
  const freshTables = new Map();
  for (const c of freshCells) {
    if (fresh.isVertex(c)) freshTables.set(decodeURIComponent(styleValue(fresh.getStyle(c), 'sqlErName')), c);
  }
  const freshEdges = freshCells.filter(c => fresh.isEdge(c));

  // Места для новых таблиц.
  const existing = [];
  for (const [name, cell] of pageTables) {
    if (freshTables.has(name)) {
      const g = geo(cell);
      existing.push({ name, x: g.x, y: g.y, width: g.width, height: g.height });
    }
  }
  const incoming = [...freshTables]
    .filter(([name]) => !pageTables.has(name))
    .map(([name, cell]) => ({ name, width: fresh.getGeometry(cell).width, height: fresh.getGeometry(cell).height }));
  const positions = placeNewTables(existing, incoming, schema.relations);

  const summary = { updated: 0, added: 0, removed: 0, restored: 0, links: 0 };
  const result = new Map(); // имя → таблица на странице
  const addedCells = [];

  model.beginUpdate();
  try {
    // Старые связи плагина удаляем — ниже построим по новой схеме.
    for (const e of linksOf(layer)) model.remove(e);

    for (const [name, freshTable] of freshTables) {
      const rows = fresh.getChildren(freshTable) || [];
      const fg = fresh.getGeometry(freshTable);
      let table = pageTables.get(name);

      if (table) {
        // Существующая таблица: место и стиль те же, строки — новые.
        if (hasFlag(model.getStyle(table), 'sqlErRemoved')) {
          model.setStyle(table, unmarkRemoved(model.getStyle(table)));
          summary.restored++;
        }
        let style = model.getStyle(table);
        style = mxUtils.setStyle(style, 'sqlErTable', '1');
        style = mxUtils.setStyle(style, 'sqlErName', encodeURIComponent(name));
        model.setStyle(table, style);

        for (const child of (model.getChildren(table) || []).slice()) model.remove(child);
        const g = geo(table).clone();
        g.width = Math.max(g.width, fg.width);
        g.height = fg.height;
        model.setGeometry(table, g);
        rows.forEach((row, i) => model.add(table, cloneRow(row, g.width), i));
        summary.updated++;
      } else {
        // Новая таблица — рядом со связанными.
        table = freshTable.clone();
        const g = fg.clone();
        const pos = positions.get(name);
        g.x = pos.x;
        g.y = pos.y;
        table.setGeometry(g);
        model.add(layer, table);
        rows.forEach((row, i) => model.add(table, cloneRow(row, g.width), i));
        addedCells.push(table);
        summary.added++;
      }
      result.set(name, table);
    }

    // Таблицы, которых нет в новой схеме, — пометить, не удалять.
    for (const [name, table] of pageTables) {
      if (freshTables.has(name) || hasFlag(model.getStyle(table), 'sqlErRemoved')) continue;
      model.setStyle(table, markRemoved(model.getStyle(table)));
      summary.removed++;
    }

    // Связи по новой схеме: строка на свежей диаграмме → та же строка (по порядку) на странице.
    const pageTerminal = freshCell => {
      const freshTable = fresh.isVertex(fresh.getParent(freshCell)) ? fresh.getParent(freshCell) : freshCell;
      const name = decodeURIComponent(styleValue(fresh.getStyle(freshTable), 'sqlErName'));
      const table = result.get(name);
      if (freshTable === freshCell) return table;
      return model.getChildAt(table, (fresh.getChildren(freshTable) || []).indexOf(freshCell));
    };
    for (const e of freshEdges) {
      const source = pageTerminal(fresh.getTerminal(e, true));
      const target = pageTerminal(fresh.getTerminal(e, false));
      if (!source || !target) continue;
      const edge = new mxCell('', new mxGeometry(), fresh.getStyle(e));
      edge.setEdge(true);
      edge.geometry.relative = true;
      model.add(layer, edge);
      model.setTerminal(edge, source, true);
      model.setTerminal(edge, target, false);
      summary.links++;
    }

    reroute(ui);
  } finally {
    model.endUpdate();
  }

  if (addedCells.length) graph.setSelectionCells(addedCells);
  return summary;
}

function cloneRow(row, width) {
  const copy = row.clone();
  const g = copy.getGeometry().clone();
  g.width = width;
  copy.setGeometry(g);
  return copy;
}

function markRemoved(style) {
  style = mxUtils.setStyle(style, 'dashed', '1');
  style = mxUtils.setStyle(style, 'opacity', '50');
  style = mxUtils.setStyle(style, 'textOpacity', '50');
  return mxUtils.setStyle(style, 'sqlErRemoved', '1');
}

function unmarkRemoved(style) {
  for (const key of ['dashed', 'opacity', 'textOpacity', 'sqlErRemoved']) style = mxUtils.setStyle(style, key, null);
  return style;
}

module.exports = { reroute, updatePage };

  };

  defs["plugin"] = function (module, exports, require) {
'use strict';

// Плагин draw.io: «Упорядочить → Вставить → Из SQL (ER-диаграмма)…».
// Окно: источник SQL (вставить / файл / база PostgreSQL) → поле с DDL →
// «Вставить» (новая диаграмма) или «Обновить на странице» (привести уже вставленную
// диаграмму к новой схеме, не двигая таблицы).

const { parseSql } = require('./parser');
const { toGraphModelXml } = require('./drawio');
const { reroute, updatePage } = require('./page');
const { selectTables, withRelated } = require('./select');

const ACTION = 'sqlErImport';
const REROUTE = 'sqlErReroute';

function register(ui) {
  installBridgeResponse();
  addAction(ui, ACTION, 'Из SQL (ER-диаграмма)...', () => showDialog(ui), 'insert');
  addAction(ui, REROUTE, 'Перепроложить связи (SQL ER)', () => {
    if (!reroute(ui)) mxUtils.alert('На странице нет связей, построенных плагином «Из SQL (ER-диаграмма)».');
  }, 'arrange');
}

// Добавляет действие и пункт меню. При повторной загрузке плагина (обновлённая сборка)
// меню уже дополнено — только подменяем обработчик.
function addAction(ui, name, label, funct, menuName) {
  const existing = ui.actions.get && ui.actions.get(name);
  if (existing) {
    existing.funct = funct;
    return;
  }
  mxResources.parse(name + '=' + label);
  ui.actions.addAction(name, funct);

  const menu = ui.menus.get(menuName);
  if (menu) {
    const original = menu.funct;
    menu.funct = function (m, parent) {
      original.apply(this, arguments);
      ui.menus.addMenuItems(m, ['-', name], parent);
    };
  }
}

// ------------------------------------------------------------- мост к базе
//
// Сама страница draw.io не может подключиться к PostgreSQL (нет сокетов, а CSP
// запрещает запросы даже к localhost). Скрипт запуска (npm start) регистрирует
// в окне функцию window.sqlErDbRequest (Runtime.addBinding): плагин передаёт в неё
// запрос, скрипт читает схему из базы и возвращает ответ через __sqlErDbResponse.

const BRIDGE = 'sqlErDbRequest';
const DB_TIMEOUT_MS = 30000;
const pending = new Map();
let requestSeq = 0;

// Функция sqlErDbRequest остаётся в окне и после остановки скрипта запуска, поэтому
// одной её мало: скрипт каждые ~1,5 с отмечается в window.__sqlErBridgeSeen.
const BRIDGE_ALIVE_MS = 5000;

function bridgeAvailable() {
  return typeof window !== 'undefined' && typeof window[BRIDGE] === 'function' &&
    Date.now() - (window.__sqlErBridgeSeen || 0) < BRIDGE_ALIVE_MS;
}

function installBridgeResponse() {
  if (typeof window === 'undefined') return;
  window.__sqlErDbResponse = json => {
    const res = JSON.parse(json);
    const p = pending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(res.id);
    if (res.error) p.reject(new Error(res.error));
    else p.resolve(res);
  };
}

function requestSchema(url, schemas) {
  return new Promise((resolve, reject) => {
    const id = ++requestSeq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Нет ответа от скрипта запуска за 30 секунд'));
    }, DB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    window[BRIDGE](JSON.stringify({ id, url, schemas }));
  });
}

// ---------------------------------------------------------- настройки окна
// Запоминаем способ и подключение (без пароля) — только для удобства.

const SETTINGS_KEY = 'sql-er-plugin';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSettings(patch) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign(loadSettings(), patch)));
  } catch (e) { /* хранилище недоступно — не страшно */ }
}

function withoutPassword(url) {
  try {
    const u = new URL(url);
    u.password = '';
    return u.toString();
  } catch (e) {
    return '';
  }
}

function withPassword(url, password) {
  try {
    const u = new URL(url);
    u.password = password; // URL сам экранирует спецсимволы
    return u.toString();
  } catch (e) {
    return url;
  }
}

// ---------------------------------------------------------------------- окно

const MODES = [
  { id: 'paste', label: 'Вставить SQL' },
  { id: 'file', label: 'Файл .sql' },
  { id: 'db', label: 'База PostgreSQL' }
];

const PLACEHOLDERS = {
  paste: 'CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE\n);\n\n' +
    'CREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  user_id INTEGER NOT NULL REFERENCES users(id)\n);',
  file: 'Здесь появится содержимое файла — его можно поправить перед вставкой.',
  db: 'Здесь появится схема из базы (CREATE TABLE / CREATE INDEX) — её можно поправить перед вставкой.'
};

function el(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text) node.textContent = text;
  return node;
}

function showDialog(ui) {
  const settings = loadSettings();
  const div = el('div', 'display:flex;flex-direction:column;height:100%;box-sizing:border-box;gap:8px;');

  // --- выбор способа
  const modeRow = el('div', 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;');
  modeRow.appendChild(el('span', 'font-weight:bold;', 'Источник:'));
  const radios = {};
  const group = 'sql-er-mode-' + Date.now();
  for (const mode of MODES) {
    const label = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer;');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = mode.id;
    label.appendChild(input);
    label.appendChild(document.createTextNode(mode.label));
    modeRow.appendChild(label);
    radios[mode.id] = input;
  }
  div.appendChild(modeRow);

  // --- панель «Файл»
  const filePanel = el('div', 'display:flex;gap:8px;align-items:center;');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.sql,.ddl,.txt,text/plain';
  fileInput.style.display = 'none';
  const pickBtn = mxUtils.button('Выбрать файл…', () => fileInput.click());
  pickBtn.className = 'geBtn';
  pickBtn.style.margin = '0';
  const fileName = el('span', 'opacity:0.8;', 'файл не выбран — можно и перетащить его в поле ниже');
  filePanel.appendChild(pickBtn);
  filePanel.appendChild(fileName);
  filePanel.appendChild(fileInput);
  div.appendChild(filePanel);

  // --- панель «База»
  const dbPanel = el('div', 'display:flex;flex-direction:column;gap:6px;');
  const dbRow = el('div', 'display:flex;gap:8px;align-items:center;');
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'postgres://user@localhost:5432/dbname';
  urlInput.value = settings.url || '';
  urlInput.setAttribute('spellcheck', 'false');
  urlInput.style.cssText = 'flex:1;min-width:0;box-sizing:border-box;padding:4px;' +
    'font-family:Consolas,Menlo,monospace;font-size:12px;';
  // Пароль — отдельно и скрыто; не сохраняется.
  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.placeholder = 'пароль';
  passwordInput.autocomplete = 'off';
  passwordInput.style.cssText = 'width:110px;box-sizing:border-box;padding:4px;font-size:12px;';
  passwordInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadFromDb(); });
  const schemaInput = document.createElement('input');
  schemaInput.type = 'text';
  schemaInput.value = settings.schemas || 'public';
  schemaInput.title = 'Схемы через запятую';
  schemaInput.style.cssText = 'width:120px;box-sizing:border-box;padding:4px;font-size:12px;';
  const connectBtn = mxUtils.button('Подключиться', () => loadFromDb());
  connectBtn.className = 'geBtn';
  connectBtn.style.margin = '0';
  dbRow.appendChild(urlInput);
  dbRow.appendChild(passwordInput);
  dbRow.appendChild(el('span', '', 'схемы:'));
  dbRow.appendChild(schemaInput);
  dbRow.appendChild(connectBtn);
  dbPanel.appendChild(dbRow);
  const dbNote = el('div', 'font-size:12px;opacity:0.8;');
  dbPanel.appendChild(dbNote);
  div.appendChild(dbPanel);

  // --- общее поле SQL
  const textarea = document.createElement('textarea');
  textarea.setAttribute('spellcheck', 'false');
  textarea.setAttribute('wrap', 'off');
  textarea.style.cssText =
    'flex:1;min-width:0;min-height:0;box-sizing:border-box;resize:none;' +
    'font-family:Consolas,Menlo,monospace;font-size:12px;padding:6px;';

  // Поле SQL слева, список таблиц справа.
  const workArea = el('div', 'flex:1;min-height:0;display:flex;gap:8px;');
  workArea.appendChild(textarea);
  const picker = tablePicker();
  workArea.appendChild(picker.node);
  div.appendChild(workArea);

  const status = el('div', 'min-height:16px;font-size:12px;opacity:0.8;white-space:pre-wrap;max-height:72px;overflow:auto;');
  div.appendChild(status);

  // Предупреждения, пришедшие вместе со схемой из базы (например, дубли ограничений), —
  // показываются в общем блоке под полем вместе с предупреждениями разбора.
  let sourceWarnings = [];

  const updateStatus = () => {
    if (!textarea.value.trim()) {
      status.textContent = '';
      picker.setSchema(null);
      return;
    }
    const model = parseSql(textarea.value);
    picker.setSchema(model);
    const indexes = model.tables.reduce((n, t) => n + t.indexes.length, 0);
    let text = `Таблиц: ${model.tables.length}, связей: ${model.relations.length}, индексов: ${indexes}`;
    const warnings = sourceWarnings.concat(model.warnings);
    if (warnings.length) text += '\n⚠ ' + warnings.join('\n⚠ ');
    status.textContent = text;
  };
  let timer = null;
  textarea.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(updateStatus, 300);
  });

  const loadFile = file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      sourceWarnings = [];
      textarea.value = reader.result;
      fileName.textContent = file.name;
      updateStatus();
    };
    reader.readAsText(file);
  };
  fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
  textarea.addEventListener('dragover', e => e.preventDefault());
  textarea.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      e.preventDefault();
      setMode('file');
      loadFile(e.dataTransfer.files[0]);
    }
  });

  async function loadFromDb() {
    let url = urlInput.value.trim();
    if (!url) { dbNote.textContent = 'Укажите строку подключения'; return; }
    const schemas = schemaInput.value.split(',').map(s => s.trim()).filter(Boolean);
    saveSettings({ url: withoutPassword(url), schemas: schemas.join(', ') });
    if (passwordInput.value) url = withPassword(url, passwordInput.value);
    connectBtn.disabled = true;
    dbNote.textContent = 'Подключаюсь…';
    try {
      const res = await requestSchema(url, schemas.length ? schemas : ['public']);
      textarea.value = res.sql;
      sourceWarnings = res.warnings || [];
      dbNote.textContent = res.message || `Прочитано таблиц: ${res.tables}. Проверьте SQL ниже и нажмите «Вставить».`;
      updateStatus();
    } catch (err) {
      dbNote.textContent = '✖ ' + err.message;
    } finally {
      connectBtn.disabled = !bridgeAvailable();
    }
  }

  let currentMode = null;
  function setMode(mode) {
    // Сменили источник — предупреждения прежнего источника больше не относятся к делу.
    if (currentMode && mode !== currentMode && sourceWarnings.length) {
      sourceWarnings = [];
      updateStatus();
    }
    currentMode = mode;
    radios[mode].checked = true;
    filePanel.style.display = mode === 'file' ? 'flex' : 'none';
    dbPanel.style.display = mode === 'db' ? 'flex' : 'none';
    textarea.placeholder = PLACEHOLDERS[mode];
    if (mode === 'db') {
      const ok = bridgeAvailable();
      connectBtn.disabled = !ok;
      dbNote.textContent = ok
        ? 'Только чтение: берётся структура (таблицы, ключи, CHECK, индексы), данные не читаются.'
        : '✖ Подключение к базе работает, только если draw.io запущен через «npm start» в папке плагина.';
    }
    saveSettings({ mode });
  }
  for (const mode of MODES) radios[mode.id].addEventListener('change', () => setMode(mode.id));
  setMode(radios[settings.mode] ? settings.mode : 'paste');

  // --- параметры и кнопки
  const options = el('div', 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;');
  const replaceBox = checkbox(options, 'Заменить содержимое страницы', false);
  const detailBox = checkbox(options, 'Ограничения как в SQL', true);
  const nullableBox = checkbox(options, 'Показывать NULL', true);
  const indexesBox = checkbox(options, 'Показывать индексы', true);
  // «NULL» — метка короткого режима; в режиме SQL видно, есть ли NOT NULL.
  const syncNullable = () => {
    nullableBox.disabled = detailBox.checked;
    nullableBox.parentNode.style.opacity = detailBox.checked ? '0.5' : '';
  };
  detailBox.addEventListener('change', syncNullable);
  syncNullable();
  div.appendChild(options);

  const buttons = el('div', 'display:flex;justify-content:flex-end;gap:8px;');

  const cancelBtn = mxUtils.button(mxResources.get('cancel') || 'Отмена', () => ui.hideDialog());
  cancelBtn.className = 'geBtn';

  const parsed = () => {
    const model = parseSql(textarea.value);
    if (!model.tables.length) {
      status.textContent = 'В SQL не найдено ни одного CREATE TABLE';
      return null;
    }
    if (model.warnings.length && typeof console !== 'undefined') {
      console.warn('[sql-er] ' + model.warnings.join('\n[sql-er] '));
    }
    picker.setSchema(model); // на случай, если «Вставить» нажали раньше, чем обновился список
    return model;
  };
  const renderOptions = () => ({
    detail: detailBox.checked ? 'sql' : 'tags',
    showNullable: nullableBox.checked,
    showIndexes: indexesBox.checked,
    measureText
  });

  const insertBtn = mxUtils.button('Вставить', () => {
    const model = parsed();
    if (!model) return;
    const selected = picker.selected();
    if (!selected.length) {
      status.textContent = 'Не отмечено ни одной таблицы';
      return;
    }
    insertXml(ui, toGraphModelXml(selectTables(model, selected), renderOptions()), replaceBox.checked);
    ui.hideDialog();
  });
  insertBtn.className = 'geBtn gePrimaryBtn';

  // Обновить уже вставленную диаграмму: таблицы остаются на местах, меняется содержимое.
  const updateBtn = mxUtils.button('Обновить на странице', () => {
    const model = parsed();
    if (!model) return;
    // Таблицы на странице обновляются всегда; отметки решают, какие новые добавить.
    const res = updatePage(ui, model, renderOptions(), picker.selected());
    if (res.error) {
      status.textContent = '✖ ' + res.error;
      return;
    }
    ui.hideDialog();
    const parts = [`обновлено таблиц: ${res.updated}`];
    if (res.added) parts.push(`добавлено: ${res.added} (выделены)`);
    if (res.restored) parts.push(`вернулось в схему: ${res.restored}`);
    if (res.removed) parts.push(`нет в схеме: ${res.removed} — помечены пунктиром, удалите сами, если не нужны`);
    parts.push(`связей: ${res.links}`);
    mxUtils.alert('Диаграмма обновлена: ' + parts.join(', ') + '.');
  });
  updateBtn.className = 'geBtn';
  updateBtn.title = 'Привести уже вставленную диаграмму к этой схеме, не двигая таблицы (одна операция, Ctrl+Z)';

  buttons.appendChild(cancelBtn);
  buttons.appendChild(updateBtn);
  buttons.appendChild(insertBtn);
  div.appendChild(buttons);

  ui.showDialog(div, 900, 560, true, true);
  (radios.db.checked ? urlInput : textarea).focus();
}

// ------------------------------------------------------------ список таблиц
//
// Галочки у таблиц схемы, поиск по имени, «Все» / «Ни одной» (для видимых по поиску)
// и «+ связанные». Отметки хранятся по имени и переживают правку SQL; новые таблицы
// появляются отмеченными.

function tablePicker() {
  const node = el('div', 'width:230px;flex:none;display:flex;flex-direction:column;gap:4px;min-height:0;');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'поиск таблицы';
  search.style.cssText = 'box-sizing:border-box;width:100%;padding:3px 4px;font-size:12px;';
  node.appendChild(search);

  const tools = el('div', 'display:flex;gap:4px;flex-wrap:wrap;');
  const smallButton = (text, title, fn) => {
    const b = mxUtils.button(text, fn);
    b.className = 'geBtn';
    b.title = title;
    b.style.cssText = 'margin:0;padding:0 6px;min-width:0;height:22px;font-size:11px;';
    tools.appendChild(b);
  };
  node.appendChild(tools);

  const list = el('div', 'flex:1;min-height:0;overflow:auto;border:1px solid rgba(128,128,128,0.4);padding:2px 4px;font-size:12px;');
  node.appendChild(list);
  const counter = el('div', 'font-size:11px;opacity:0.8;');
  node.appendChild(counter);

  const checked = new Map(); // имя → отмечена ли
  let schema = null;

  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return schema ? schema.tables.map(t => t.name).filter(n => !q || n.toLowerCase().includes(q)) : [];
  };

  function render() {
    list.textContent = '';
    const names = visible();
    for (const name of names) {
      const label = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked.get(name);
      box.addEventListener('change', () => {
        checked.set(name, box.checked);
        updateCounter();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(name));
      label.title = name;
      list.appendChild(label);
    }
    if (schema && !names.length) list.appendChild(el('div', 'opacity:0.6;', 'ничего не найдено'));
    if (!schema) list.appendChild(el('div', 'opacity:0.6;', 'здесь появятся таблицы из SQL'));
    updateCounter();
  }

  function updateCounter() {
    const total = schema ? schema.tables.length : 0;
    counter.textContent = total ? `выбрано ${selected().length} из ${total}` : '';
  }

  function selected() {
    return schema ? schema.tables.map(t => t.name).filter(n => checked.get(n)) : [];
  }

  smallButton('Все', 'Отметить все (видимые по поиску)', () => {
    visible().forEach(n => checked.set(n, true));
    render();
  });
  smallButton('Ни одной', 'Снять отметки (с видимых по поиску)', () => {
    visible().forEach(n => checked.set(n, false));
    render();
  });
  smallButton('+ связанные', 'Добавить таблицы, связанные с отмеченными', () => {
    if (!schema) return;
    withRelated(schema, selected()).forEach(n => checked.set(n, true));
    render();
  });
  search.addEventListener('input', render);

  render();
  return {
    node,
    selected,
    setSchema(next) {
      schema = next && next.tables.length ? next : null;
      if (schema) for (const t of schema.tables) if (!checked.has(t.name)) checked.set(t.name, true);
      render();
    }
  };
}

// Ширина текста так, как её нарисует draw.io (шрифт по умолчанию, html-подпись):
// по ней считается ширина таблиц и какие строки переносить.
function measureText(text, fontSize, bold) {
  return mxUtils.getSizeForString(mxUtils.htmlEntities(text), fontSize,
    mxConstants.DEFAULT_FONTFAMILY, null, bold ? mxConstants.FONT_BOLD : 0).width;
}

function checkbox(parent, text, checked) {
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  label.appendChild(input);
  label.appendChild(document.createTextNode(text));
  parent.appendChild(label);
  return input;
}

// ------------------------------------------------------------------- вставка

function insertXml(ui, xml, replace) {
  const graph = ui.editor.graph;
  const doc = mxUtils.parseXml(xml);
  const imported = new mxGraphModel();
  new mxCodec(doc).decode(doc.documentElement, imported);
  const cells = imported.getChildren(imported.getChildAt(imported.getRoot(), 0)) || [];

  const model = graph.getModel();
  let inserted = [];

  // Одна транзакция — отменяется одним Ctrl+Z.
  model.beginUpdate();
  try {
    if (replace) {
      graph.removeCells(graph.getChildCells(graph.getDefaultParent(), true, true), true);
    }
    const pt = replace || graph.getChildCells(graph.getDefaultParent()).length === 0
      ? { x: 0, y: 0 }
      : freePoint(graph);
    inserted = graph.importCells(cells.slice(), pt.x, pt.y, graph.getDefaultParent());
  } finally {
    model.endUpdate();
  }

  if (inserted && inserted.length) {
    graph.setSelectionCells(inserted.filter(c => model.isVertex(c)));
    graph.scrollCellToVisible(inserted[0]);
  }
}

// Ставим новую диаграмму под существующим содержимым страницы.
function freePoint(graph) {
  const bounds = graph.getBoundingBoxFromGeometry(graph.getChildCells(graph.getDefaultParent()), true);
  return bounds ? { x: bounds.x, y: bounds.y + bounds.height + 40 } : { x: 0, y: 0 };
}

module.exports = { register, insertXml };

if (typeof Draw !== 'undefined' && Draw.loadPlugin) {
  Draw.loadPlugin(register);
}

  };

  require("plugin");
})();
