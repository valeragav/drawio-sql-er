'use strict';

// Экспорт диаграммы в SQL: CREATE TYPE / CREATE TABLE / CREATE INDEX / ALTER TABLE / COMMENT ON
// из того, что сейчас нарисовано на странице (с правками пользователя).
//
// Вход — «снимок» ячеек страницы в простом виде (без mxGraph), чтобы логику можно было
// проверить в Node: [{ id, parent, vertex, edge, style, value, tooltip, y, source, target }].
// value — видимый текст (без HTML).

const hasFlag = (style, flag) => new RegExp('(^|;)' + flag + '=1(;|$)').test(style || '');
const styleValue = (style, key) => {
  const m = new RegExp('(?:^|;)' + key + '=([^;]*)').exec(style || '');
  return m ? m[1] : null;
};

// ------------------------------------------------------------- снимок → модель

// Таблицы плагина со строками и связи между строками.
function readDiagram(cells) {

  const children = new Map();
  for (const c of cells) {
    if (!children.has(c.parent)) children.set(c.parent, []);
    children.get(c.parent).push(c);
  }

  const nodes = [];
  const nodeOfRow = new Map(); // id строки/таблицы → { node, row }
  for (const c of cells) {
    if (!c.vertex || !hasFlag(c.style, 'sqlErTable')) continue;
    const key = decodeURIComponent(styleValue(c.style, 'sqlErName') || '');
    const title = (c.value || '').trim();
    let kind = 'table';
    let name = title;
    if (key.startsWith('enum:') || title.startsWith('«enum»')) {
      kind = 'enum';
      name = title.replace(/^«enum»\s*/, '');
    } else {
      const m = /^(.*?)\s+\((view|materialized view)\)$/.exec(title);
      if (m) {
        kind = m[2];
        name = m[1];
      }
    }
    const rows = [];
    for (const r of (children.get(c.id) || []).filter(x => x.vertex).sort((a, b) => a.y - b.y)) {
      // Компактный режим: «⋯ ещё N колонок» — разворачиваем обратно в строки колонок.
      if (r.hidden) {
        let list = [];
        try { list = JSON.parse(r.hidden); } catch (e) { /* повреждено — пропускаем */ }
        // Скрытые колонки встают на свои исходные места (index) среди видимых.
        const head = rows.filter(x => rowKind(x) !== 'column');
        const visible = rows.filter(x => rowKind(x) === 'column');
        const merged = new Array(visible.length + list.length);
        list.forEach((h, k) => {
          const at = Number.isInteger(h.index) && h.index < merged.length && !merged[h.index] ? h.index : null;
          const row = { id: r.id + '#' + k, text: String(h.label || '').trim(), style: h.style || '', tooltip: h.tooltip || null };
          if (at !== null) merged[at] = row;
          else visible.push(row);
        });
        for (let i = 0; i < merged.length && visible.length; i++) if (!merged[i]) merged[i] = visible.shift();
        rows.length = 0;
        rows.push(...head, ...merged.filter(Boolean), ...visible);
        continue;
      }
      rows.push({ id: r.id, text: (r.value || '').trim(), style: r.style || '', tooltip: r.tooltip || null });
    }
    // key — исходное имя (скрытая метка), name — текущая подпись (могли переименовать).
    const node = { id: c.id, kind, name, key: key.replace(/^enum:/, ''), rows, removed: hasFlag(c.style, 'sqlErRemoved') };
    nodes.push(node);
    nodeOfRow.set(c.id, { node, row: null });
    rows.forEach(row => nodeOfRow.set(row.id, { node, row }));
  }

  const links = [];
  for (const e of cells) {
    if (!e.edge) continue;
    const s = nodeOfRow.get(e.source);
    const t = nodeOfRow.get(e.target);
    if (!s || !t) continue;
    let kind = 'fk';
    if (hasFlag(e.style, 'sqlErLink')) {
      if (/dashPattern=2 3/.test(e.style)) kind = 'enum';
      else if (/endArrow=open/.test(e.style)) kind = 'view';
      else if (/startArrow=none/.test(e.style) && /endArrow=none/.test(e.style)) kind = 'fk-part';
    }
    links.push({ kind, parent: s.node, parentRow: s.row, child: t.node, childRow: t.row });
  }
  return { nodes, links };
}

// Вид строки таблицы по её стилю.
function rowKind(row) {
  if (/^line;/.test(row.style)) return 'divider';
  if (/sqlErHidden=1/.test(row.style)) return 'hidden';
  if (/textOpacity=60/.test(row.style)) return /fontStyle=2;/.test(row.style) ? 'comment' : 'note';
  return 'column';
}

const TAGS = ['PK', 'FK', 'UQ', 'AI', 'NULL'];

// «🔑 id : BIGINT … PRIMARY KEY 💬» → { name, rest, primaryKey } (rest — тип и ограничения).
function parseColumnText(text) {
  let t = text.replace(/\s*💬$/, '').trim();
  const primaryKey = t.startsWith('🔑');
  t = t.replace(/^🔑\s*/, '');
  const i = t.indexOf(' : ');
  if (i < 0) return { name: t.trim(), rest: '', primaryKey };
  const name = t.slice(0, i).trim();
  let rest = t.slice(i + 3).trim();
  // Короткие метки: «TEXT (PK, NULL)».
  const m = new RegExp(`^(.*?)\\s*\\(((?:${TAGS.join('|')})(?:\\s*,\\s*(?:${TAGS.join('|')}))*)\\)$`).exec(rest);
  const tags = m ? m[2].split(',').map(s => s.trim()) : null;
  if (m) rest = m[1];
  return { name, rest, primaryKey, tags };
}

// «🔍 UNIQUE idx (a, lower(b)) USING gin INCLUDE (c) WHERE x» → части индекса.
function parseIndexText(text) {
  let s = text.replace(/^🔍\s*/, '').trim();
  const unique = /^UNIQUE\s/.test(s);
  if (unique) s = s.replace(/^UNIQUE\s+/, '');
  let name = null;
  if (!s.startsWith('(')) {
    const sp = s.indexOf(' ');
    name = sp < 0 ? s : s.slice(0, sp);
    s = sp < 0 ? '' : s.slice(sp + 1).trim();
  }
  if (!s.startsWith('(')) return null;
  let depth = 0;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    if (s[i] === ')' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return null;
  const columns = s.slice(1, end);
  let tail = s.slice(end + 1).trim();
  let method = null;
  let include = null;
  let where = null;
  const w = /\bWHERE\s+(.*)$/.exec(tail);
  if (w) {
    where = w[1];
    tail = tail.slice(0, w.index).trim();
  }
  const u = /USING\s+(\w+)/.exec(tail);
  if (u) method = u[1];
  const inc = /INCLUDE\s+\((.*)\)/.exec(tail);
  if (inc) include = inc[1];
  return { unique, name, columns, method, include, where };
}

// ---------------------------------------------------------------- модель → SQL

const quoteIdent = name => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : '"' + name.replace(/"/g, '""') + '"');
const quoteName = name => name.split('.').map(quoteIdent).join('.');
const sqlString = s => "'" + String(s).replace(/'/g, "''") + "'";

function referencedTables(text) {
  const out = [];
  const re = /REFERENCES\s+("(?:[^"]|"")+"|[\w$]+)(?:\s*\.\s*("(?:[^"]|"")+"|[\w$]+))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const parts = [m[1], m[2]].filter(Boolean).map(p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase()));
    out.push(parts.join('.'));
  }
  return out;
}

function exportSql(cells) {
  const { nodes, links } = readDiagram(cells);
  const warnings = [];
  const out = ['-- Экспорт диаграммы draw.io (drawio-sql-er)', ''];

  const live = nodes.filter(n => !n.removed);
  for (const n of nodes.filter(n => n.removed)) {
    out.push(`-- ${n.name}: пропущена — помечена на диаграмме как отсутствующая в схеме`);
  }
  if (nodes.some(n => n.removed)) out.push('');

  // ENUM
  const enums = live.filter(n => n.kind === 'enum');
  for (const en of enums) {
    const values = en.rows.filter(r => rowKind(r) === 'column').map(r => sqlString(r.text));
    out.push(`CREATE TYPE ${quoteName(en.name)} AS ENUM (${values.join(', ')});`);
  }
  if (enums.length) out.push('');

  // Таблицы: колонки, ограничения, индексы, комментарии.
  // Короткие метки: была ли включена «Показывать NULL» — если хоть у одной колонки на всей
  // диаграмме есть метка NULL, значит у колонок без неё — NOT NULL.
  const nullableShown = live.some(n => n.kind === 'table' && n.rows.some(r =>
    rowKind(r) === 'column' && (parseColumnText(r.text).tags || []).includes('NULL')));
  // Таблицы, переименованные на диаграмме: ссылки REFERENCES на старое имя → новое.
  const renames = nodes.filter(n => n.kind === 'table' && n.key && n.key !== n.name);
  const tables = live.filter(n => n.kind === 'table').map(n => buildTable(n, warnings, nullableShown, renames));

  // Порядок: сначала таблицы, на которые ссылаются (иначе CREATE TABLE с REFERENCES не выполнится).
  const byName = new Map(tables.map(t => [t.name.toLowerCase(), t]));
  const ordered = [];
  const state = new Map();
  const visit = t => {
    if (state.get(t) === 'done') return;
    if (state.get(t) === 'visiting') {
      warnings.push(`${t.name}: циклические ссылки REFERENCES — порядок таблиц может потребовать правки`);
      return;
    }
    state.set(t, 'visiting');
    for (const ref of t.refs) {
      const parent = byName.get(ref) || byName.get(ref.split('.').pop());
      if (parent && parent !== t) visit(parent);
    }
    state.set(t, 'done');
    ordered.push(t);
  };
  tables.forEach(visit);

  for (const t of ordered) {
    out.push(`CREATE TABLE ${quoteName(t.name)} (\n${t.lines.map(l => '    ' + l).join(',\n')}\n);`);
    out.push(...t.indexes);
    out.push('');
  }

  // Связи, нарисованные на диаграмме, которых нет в SQL колонок (например, добавлены вручную
  // или подписи в режиме коротких меток), — отдельными ALTER TABLE … FOREIGN KEY.
  const alters = [];
  for (const l of links) {
    if (l.kind !== 'fk' || l.parent.kind !== 'table' || l.child.kind !== 'table' || l.parent.removed || l.child.removed) continue;
    if (!l.childRow || rowKind(l.childRow) !== 'column') continue;
    const childCol = parseColumnText(l.childRow.text).name;
    const parentCol = l.parentRow && rowKind(l.parentRow) === 'column' ? parseColumnText(l.parentRow.text).name : null;
    const child = tables.find(t => t.node === l.child);
    if (!child || child.hasReference(childCol)) continue;
    alters.push(`ALTER TABLE ${quoteName(l.child.name)} ADD FOREIGN KEY (${quoteIdent(childCol)}) ` +
      `REFERENCES ${quoteName(l.parent.name)}${parentCol ? ` (${quoteIdent(parentCol)})` : ''};`);
  }
  if (alters.length) out.push(...alters, '');

  // Представления: запрос на диаграмме не хранится — только описание.
  for (const v of live.filter(n => n.kind !== 'table' && n.kind !== 'enum')) {
    const cols = v.rows.filter(r => rowKind(r) === 'column').map(r => r.text);
    const deps = links.filter(l => l.kind === 'view' && l.child === v).map(l => l.parent.name);
    out.push(`-- ${v.kind.toUpperCase()} ${quoteName(v.name)} (${cols.join(', ')})` +
      (deps.length ? ` — из ${deps.join(', ')}` : '') + ': текст запроса на диаграмме не хранится');
  }
  if (live.some(n => n.kind === 'view' || n.kind === 'materialized view')) out.push('');

  // Комментарии.
  const comments = [];
  for (const n of live) {
    const commentRow = n.rows.find(r => rowKind(r) === 'comment');
    if (commentRow) {
      const what = n.kind === 'enum' ? 'TYPE' : n.kind === 'table' ? 'TABLE' : n.kind.toUpperCase();
      comments.push(`COMMENT ON ${what} ${quoteName(n.name)} IS ${sqlString(commentRow.text)};`);
    }
    if (n.kind === 'table') {
      for (const r of n.rows) {
        if (rowKind(r) === 'column' && r.tooltip) {
          comments.push(`COMMENT ON COLUMN ${quoteName(n.name)}.${quoteIdent(parseColumnText(r.text).name)} IS ${sqlString(r.tooltip)};`);
        }
      }
    }
  }
  out.push(...comments);

  return { sql: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', warnings };
}

// Строки CREATE TABLE для одной таблицы + её индексы.
function buildTable(node, warnings, nullableShown, renames = []) {
  const columns = [];
  const notes = [];
  let afterDivider = false;
  for (const r of node.rows) {
    const kind = rowKind(r);
    if (kind === 'divider') { afterDivider = true; continue; }
    if (kind === 'comment') continue;
    if (kind === 'note' || afterDivider) notes.push(r.text);
    else columns.push(parseColumnText(r.text));
  }

  const tagMode = columns.some(c => c.tags);
  const pkColumns = columns.filter(c => c.primaryKey).map(c => c.name);
  const compositePk = pkColumns.length > 1;

  const lines = [];
  for (const c of columns) {
    let rest = c.rest;
    if (!rest) {
      warnings.push(`${node.name}.${c.name}: у колонки нет типа — подставлен text`);
      rest = 'text';
    }
    // Режим коротких меток. Колонка без меток подписана просто «имя : тип» — к ней
    // тоже относится правило «нет метки NULL (при включённом показе NULL) → NOT NULL».
    if (c.tags || nullableShown) {
      const t = c.tags || [];
      if (t.includes('AI')) rest += ' GENERATED BY DEFAULT AS IDENTITY';
      if (t.includes('PK') && !compositePk) rest += ' PRIMARY KEY';
      else if (t.includes('PK') || (nullableShown && !t.includes('NULL'))) rest += ' NOT NULL';
      if (t.includes('UQ')) rest += ' UNIQUE';
    }
    lines.push(`${quoteIdent(c.name)} ${rest}`);
  }

  const indexes = [];
  let hasTablePk = false;
  for (const text of notes) {
    if (text.startsWith('🔍')) {
      const ix = parseIndexText(text);
      if (!ix) {
        warnings.push(`${node.name}: не удалось разобрать индекс «${text}»`);
        continue;
      }
      indexes.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${ix.name ? quoteIdent(ix.name) + ' ' : ''}ON ${quoteName(node.name)}` +
        `${ix.method ? ' USING ' + ix.method : ''} (${ix.columns})` +
        `${ix.include ? ` INCLUDE (${ix.include})` : ''}${ix.where ? ' WHERE ' + ix.where : ''};`);
    } else {
      if (/^(CONSTRAINT\s+\S+\s+)?PRIMARY KEY/i.test(text)) hasTablePk = true;
      lines.push(text);
    }
  }
  if (tagMode && compositePk && !hasTablePk) lines.push(`PRIMARY KEY (${pkColumns.map(quoteIdent).join(', ')})`);

  for (const r of renames) {
    const old = r.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(REFERENCES\\s+)(?:"${old}"|${old})(?=\\s*\\(|\\s|,|$)`, 'gi');
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(re, (m, p) => p + quoteName(r.name));
  }

  const refs = [...new Set(lines.flatMap(referencedTables))];
  const hasReference = col => lines.some(l =>
    (l.startsWith(quoteIdent(col) + ' ') && /REFERENCES/i.test(l)) ||
    new RegExp(`FOREIGN KEY\\s*\\(\\s*"?${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*[,)]`, 'i').test(l));

  return { node, name: node.name, lines, indexes, refs, hasReference };
}

module.exports = { exportSql, readDiagram, parseColumnText, parseIndexText };
