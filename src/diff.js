'use strict';

// Сравнение двух схем (моделей parser.js): диаграммы на странице и схемы из базы или файла.
//
// Сравнивается смысл, а не запись: обе стороны приводятся к одному виду —
// синонимы типов (INT = integer, TIMESTAMPTZ = timestamp with time zone, SERIAL = integer
// с автоинкрементом), ограничения без имён и без разницы «у колонки / у таблицы»,
// выражения через simplifyExpr. Если выражения CHECK всё же различаются по тексту,
// это «возможно отличается», а не явное различие.

const { simplifyExpr } = require('./sqltext');

// ------------------------------------------------------------- нормализация

const TYPE_SYNONYMS = [
  [/^(int|int4|integer|serial|serial4)$/, 'integer'],
  [/^(int8|bigint|bigserial|serial8)$/, 'bigint'],
  [/^(int2|smallint|smallserial|serial2)$/, 'smallint'],
  [/^(bool|boolean)$/, 'boolean'],
  [/^(float8|double precision|float)$/, 'double precision'],
  [/^(float4|real)$/, 'real'],
  [/^(timestamptz|timestamp with time zone)$/, 'timestamptz'],
  [/^(timestamp|timestamp without time zone)$/, 'timestamp'],
  [/^(timetz|time with time zone)$/, 'timetz'],
  [/^(time|time without time zone)$/, 'time']
];

// «VARCHAR(255)» → «varchar(255)», «NUMERIC(10, 2)» → «numeric(10,2)», «public.status[]» → «status[]».
function normalizeType(type) {
  let t = String(type || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let array = '';
  const arr = /(\[\])+$/.exec(t);
  if (arr) {
    array = arr[0];
    t = t.slice(0, -array.length).trim();
  }
  t = t.replace(/^public\./, '').replace(/"/g, '');
  t = t.replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')');
  t = t.replace(/^character varying/, 'varchar').replace(/^(character|bpchar)(?=\(|$)/, 'char')
    .replace(/^decimal/, 'numeric');
  const base = t.replace(/\(.*$/, '');
  const params = t.slice(base.length);
  for (const [re, canonical] of TYPE_SYNONYMS) {
    if (re.test(base)) return canonical + params + array;
  }
  return t + array;
}

// Выражение для сравнения: упрощённое, без регистра ключевых слов, пробелов и внешних скобок.
function normalizeExpr(expr) {
  if (expr == null) return null;
  let s = simplifyExpr(String(expr)).trim();
  s = s.replace(/'(?:[^']|'')*'|[^']+/g, part => (part.startsWith("'") ? part : part.toLowerCase().replace(/\s+/g, '')));
  while (/^\(.*\)$/.test(s) && balanced(s.slice(1, -1))) s = s.slice(1, -1);
  return s;
}

function balanced(s) {
  let depth = 0;
  let quote = false;
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

// Все CHECK (…) из текста ограничений (с балансом скобок).
function checksIn(text) {
  const out = [];
  const re = /CHECK\s*\(/gi;
  let m;
  while ((m = re.exec(text || ''))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      if (text[i] === ')' && --depth === 0) break;
    }
    out.push(normalizeExpr(text.slice(m.index + m[0].length, i)));
    re.lastIndex = i;
  }
  return out;
}

const isNextval = d => d != null && /^nextval\(/i.test(String(d));

// «'new'::status» у колонки типа status — то же, что «'new'»: приведение к своему типу лишнее.
function withoutOwnCast(expr, type) {
  if (expr == null) return expr;
  const m = /^('(?:[^']|'')*')::(.+)$/.exec(String(expr).trim());
  return m && normalizeType(m[2]) === normalizeType(type) ? m[1] : expr;
}

// Нормализованная таблица: всё, что сравниваем, в виде простых значений и множеств.
function normalizeTable(t, relations) {
  const columns = new Map();
  for (const c of t.columns) {
    columns.set(c.name, {
      name: c.name,
      type: normalizeType(c.type),
      notNull: !!(c.notNull || c.primaryKey),
      autoIncrement: !!c.autoIncrement,
      default: isNextval(c.default) ? null : normalizeExpr(withoutOwnCast(c.default, c.type)),
      comment: c.comment || null
    });
  }
  const uniques = new Set(t.columns.filter(c => c.unique && !c.primaryKey).map(c => c.name));
  for (const u of t.compositeUniques || []) uniques.add([...u].sort().join(','));
  const checks = new Set([
    ...t.columns.flatMap(c => checksIn(c.constraints)),
    ...(t.constraints || []).flatMap(checksIn)
  ]);
  const indexes = new Map();
  for (const ix of t.indexes || []) {
    const key = [
      ix.unique ? 'UNIQUE' : '',
      (ix.method || 'btree').toLowerCase(),
      ix.columns.map(normalizeExpr).join(','),
      ix.include && ix.include.length ? 'INCLUDE ' + ix.include.join(',') : '',
      ix.where ? 'WHERE ' + normalizeExpr(ix.where) : ''
    ].join('|');
    indexes.set(key, ix);
  }
  const fks = new Set();
  for (const r of relations.filter(r => r.child === t.name)) {
    const pairs = [[r.childColumn, r.parentColumn]].concat((r.extraColumns || []).map(p => [p.childColumn, p.parentColumn]));
    fks.add(pairs.map(([c, p]) => `${c}→${r.parent}.${p}`).join(' + '));
  }
  return {
    name: t.name,
    comment: t.comment || null,
    columns,
    primaryKey: [...(t.primaryKey || [])].sort().join(','),
    uniques,
    checks,
    indexes,
    fks
  };
}

// ------------------------------------------------------------------ сравнение

// left — диаграмма, right — база/файл. Возвращает { same, tables, enums, views, hints, count }.
// opts.comments — сравнивать ли комментарии.
function diffSchemas(left, right, opts = {}) {
  const tablesOf = m => m.tables.filter(t => (t.kind || 'table') === 'table');
  const L = new Map(tablesOf(left).map(t => [t.name, normalizeTable(t, left.relations)]));
  const R = new Map(tablesOf(right).map(t => [t.name, normalizeTable(t, right.relations)]));

  const result = { onlyLeft: [], onlyRight: [], changed: [], same: [], enums: [], views: [], hints: [] };

  for (const name of L.keys()) if (!R.has(name)) result.onlyLeft.push(name);
  for (const name of R.keys()) if (!L.has(name)) result.onlyRight.push(name);

  for (const [name, a] of L) {
    const b = R.get(name);
    if (!b) continue;
    const changes = compareTables(a, b, opts);
    if (changes.length) result.changed.push({ name, changes });
    else result.same.push(name);
  }

  // Возможные переименования: таблица только на диаграмме ~ таблица только в базе.
  for (const l of result.onlyLeft) {
    for (const r of result.onlyRight) {
      const a = [...L.get(l).columns.keys()];
      const b = new Set(R.get(r).columns.keys());
      const common = a.filter(c => b.has(c)).length;
      if (common / Math.max(a.length, b.size) >= 0.7) result.hints.push(`возможно, таблица переименована: ${r} → ${l}`);
    }
  }

  // ENUM: набор и порядок значений.
  const enumMap = m => new Map((m.enums || []).map(e => [e.name, e]));
  const EL = enumMap(left);
  const ER = enumMap(right);
  for (const [name, e] of EL) {
    if (!ER.has(name)) result.enums.push({ name, text: `ENUM ${name}: только на диаграмме`, side: 'left' });
    else if (e.values.join('\u0000') !== ER.get(name).values.join('\u0000')) {
      result.enums.push({ name, text: `ENUM ${name}: значения — на диаграмме (${e.values.join(', ')}), в схеме (${ER.get(name).values.join(', ')})` });
    }
  }
  for (const name of ER.keys()) if (!EL.has(name)) result.enums.push({ name, text: `ENUM ${name}: только в схеме`, side: 'right' });

  // Представления: есть ли и список колонок (текста запроса на диаграмме нет).
  const viewMap = m => new Map(m.tables.filter(t => t.kind && t.kind !== 'table').map(t => [t.name, t]));
  const VL = viewMap(left);
  const VR = viewMap(right);
  for (const [name, v] of VL) {
    if (!VR.has(name)) result.views.push({ name, text: `${v.kind} ${name}: только на диаграмме`, side: 'left' });
    else {
      const a = v.columns.map(c => c.name).join(', ');
      const b = VR.get(name).columns.map(c => c.name).join(', ');
      if (a !== b) result.views.push({ name, text: `${v.kind} ${name}: колонки — на диаграмме (${a}), в схеме (${b})` });
    }
  }
  for (const [name, v] of VR) if (!VL.has(name)) result.views.push({ name, text: `${v.kind} ${name}: только в схеме`, side: 'right' });

  result.count = result.onlyLeft.length + result.onlyRight.length +
    result.changed.reduce((n, t) => n + t.changes.length, 0) + result.enums.length + result.views.length;
  return result;
}

// Различия двух одноимённых таблиц: [{ column?, text, maybe? }].
function compareTables(a, b, opts) {
  const changes = [];
  const add = (text, column, maybe) => changes.push({ text, column: column || null, maybe: !!maybe });

  for (const [name, ca] of a.columns) {
    const cb = b.columns.get(name);
    if (!cb) {
      add(`колонка ${name}: только на диаграмме`, name);
      continue;
    }
    if (ca.type !== cb.type) add(`${name}: тип — на диаграмме ${ca.type}, в схеме ${cb.type}`, name);
    if (ca.notNull !== cb.notNull) add(`${name}: ${ca.notNull ? 'на диаграмме NOT NULL, в схеме нет' : 'в схеме NOT NULL, на диаграмме нет'}`, name);
    if (ca.autoIncrement !== cb.autoIncrement) add(`${name}: автоинкремент ${ca.autoIncrement ? 'только на диаграмме' : 'только в схеме'}`, name);
    if (ca.default !== cb.default) add(`${name}: DEFAULT — на диаграмме ${ca.default ?? 'нет'}, в схеме ${cb.default ?? 'нет'}`, name);
    if (opts.comments && (ca.comment || null) !== (cb.comment || null)) add(`${name}: комментарий отличается`, name, true);
  }
  for (const name of b.columns.keys()) if (!a.columns.has(name)) add(`колонка ${name}: только в схеме`, name);

  if (a.primaryKey !== b.primaryKey) add(`первичный ключ — на диаграмме (${a.primaryKey || 'нет'}), в схеме (${b.primaryKey || 'нет'})`);

  const setDiff = (x, y) => [...x].filter(v => !y.has(v));
  for (const u of setDiff(a.uniques, b.uniques)) add(`UNIQUE (${u}): только на диаграмме`, u.includes(',') ? null : u);
  for (const u of setDiff(b.uniques, a.uniques)) add(`UNIQUE (${u}): только в схеме`, u.includes(',') ? null : u);
  for (const f of setDiff(a.fks, b.fks)) add(`внешний ключ ${f}: только на диаграмме`, f.split('→')[0]);
  for (const f of setDiff(b.fks, a.fks)) add(`внешний ключ ${f}: только в схеме`, f.split('→')[0]);
  // CHECK: текст выражений мог разойтись только записью — «возможно отличается».
  for (const c of setDiff(a.checks, b.checks)) add(`CHECK (${c}): на диаграмме, в схеме такого текста нет`, null, true);
  for (const c of setDiff(b.checks, a.checks)) add(`CHECK (${c}): в схеме, на диаграмме такого текста нет`, null, true);

  for (const [key, ix] of a.indexes) {
    if (!b.indexes.has(key)) add(`индекс ${ix.name || '(без имени)'} (${ix.columns.join(', ')}): только на диаграмме`);
    else if ((ix.name || null) !== (b.indexes.get(key).name || null)) {
      add(`индекс (${ix.columns.join(', ')}): имя — на диаграмме ${ix.name}, в схеме ${b.indexes.get(key).name}`, null, true);
    }
  }
  for (const [key, ix] of b.indexes) {
    if (!a.indexes.has(key)) add(`индекс ${ix.name || '(без имени)'} (${ix.columns.join(', ')}): только в схеме`);
  }

  if (opts.comments && (a.comment || null) !== (b.comment || null)) add('комментарий таблицы отличается', null, true);
  return changes;
}

// Отчёт текстом.
function formatDiff(d, title) {
  const lines = [title || 'Сравнение: диаграмма ↔ схема'];
  lines.push(`Совпадает таблиц: ${d.same.length}. Различий: ${d.count}.`, '');
  if (d.onlyRight.length) lines.push('➕ Только в схеме (нет на диаграмме)', ...d.onlyRight.map(n => '   ' + n), '');
  if (d.onlyLeft.length) lines.push('➖ Только на диаграмме (нет в схеме)', ...d.onlyLeft.map(n => '   ' + n), '');
  for (const t of d.changed) {
    lines.push(`✎ ${t.name}`, ...t.changes.map(c => `   ${c.maybe ? '~ ' : ''}${c.text}`), '');
  }
  if (d.enums.length) lines.push('ENUM', ...d.enums.map(e => '   ' + e.text), '');
  if (d.views.length) lines.push('Представления', ...d.views.map(v => '   ' + v.text), '');
  if (d.hints.length) lines.push('Подсказки', ...d.hints.map(h => '   ' + h), '');
  if (!d.count) lines.push('Различий нет — диаграмма совпадает со схемой.');
  if (d.changed.some(t => t.changes.some(c => c.maybe))) lines.push('~ — возможно отличается (различие в записи выражения или имени).');
  return lines.join('\n').trim() + '\n';
}

module.exports = { diffSchemas, formatDiff, normalizeType, normalizeExpr };
