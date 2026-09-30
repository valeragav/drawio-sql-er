'use strict';

// Модель из parser.js → XML графа draw.io (mxGraphModel).
// Таблица — swimlane со стек-раскладкой, каждая колонка — отдельная строка-ячейка,
// связи соединяют строки (PK родителя → FK ребёнка) в нотации «воронья лапка».
// Представления — такие же блоки с пунктирной рамкой (стрелки от таблиц из FROM/JOIN),
// перечисления (ENUM) — блоки со значениями (пунктир к колонкам этого типа).

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
const COMMENT_STYLE = NOTE_STYLE + 'fontStyle=2;';

const VIEW_STYLE = TABLE_STYLE + 'dashed=1;dashPattern=8 4;';
const ENUM_STYLE = TABLE_STYLE.replace('fontStyle=1;', 'fontStyle=3;') + 'rounded=1;arcSize=6;';
const NODE_STYLES = { table: TABLE_STYLE, view: VIEW_STYLE, 'materialized view': VIEW_STYLE, enum: ENUM_STYLE };
const NOTE_HEIGHT = 20;

// Разделитель между колонками и блоком индексов/ограничений (как в ER-фигурах draw.io).
const DIVIDER_STYLE =
  'line;strokeWidth=1;fillColor=none;align=left;verticalAlign=middle;spacingTop=-1;' +
  'spacingLeft=3;spacingRight=3;rotatable=0;labelPosition=right;points=[];portConstraint=eastwest;';
const DIVIDER_HEIGHT = 8;

const DEFAULTS = {
  showNullable: true,
  showIndexes: true,
  showEnums: true,
  showViews: true,
  showComments: true,
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
  const rows = [];
  // COMMENT ON TABLE — мелкой строкой сразу под заголовком.
  if (opts.showComments && table.comment) rows.push(commentRow(table.comment));

  for (const col of table.columns) {
    // COMMENT ON COLUMN — всплывающей подсказкой; значок 💬 показывает, что она есть.
    const comment = opts.showComments && col.comment ? col.comment : null;
    rows.push({
      column: col.name,
      label: columnLabel(col, opts) + (comment ? ' 💬' : ''),
      tooltip: comment,
      style: ROW_STYLE + (fontStyle(col) ? 'fontStyle=' + fontStyle(col) + ';' : ''),
      height: ROW_HEIGHT
    });
  }

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

function commentRow(text) {
  return { column: null, label: text, style: COMMENT_STYLE, height: NOTE_HEIGHT, note: true };
}

// Значения перечисления — по строке; комментарий типа — под заголовком.
function enumRows(en, opts) {
  const rows = [];
  if (opts.showComments && en.comment) rows.push(commentRow(en.comment));
  for (const value of en.values) rows.push({ column: null, label: value, style: ROW_STYLE, height: ROW_HEIGHT });
  return rows;
}

// ------------------------------------------------------ узлы и связи схемы
//
// Узлы диаграммы: таблицы, представления и перечисления. Ключ узла (name) — имя таблицы
// или представления, для перечисления — «enum:имя» (у типов своё пространство имён).
// Связи для раскладки и трассировки: внешние ключи (kind 'fk'), колонка → её ENUM
// ('enum', от блока перечисления к строке колонки) и таблица → представление ('view').

const enumKey = name => 'enum:' + name;

function schemaGraph(model, opts) {
  const nodes = [];
  for (const t of model.tables) {
    const kind = t.kind || 'table';
    if (kind !== 'table' && !opts.showViews) continue;
    nodes.push({
      name: t.name,
      kind,
      title: kind === 'table' ? t.name : `${t.name} (${kind})`,
      table: t,
      rows: buildRows(t, opts)
    });
  }
  if (opts.showEnums) {
    for (const en of model.enums || []) {
      nodes.push({ name: enumKey(en.name), kind: 'enum', title: '«enum» ' + en.name, table: en, rows: enumRows(en, opts) });
    }
  }

  const has = new Set(nodes.map(n => n.name));
  const relations = model.relations
    .filter(r => has.has(r.parent) && has.has(r.child))
    .map(r => Object.assign({ kind: 'fk' }, r));
  for (const l of model.enumLinks || []) {
    const key = enumKey(l.enum);
    if (has.has(key) && has.has(l.table)) {
      relations.push({ kind: 'enum', parent: key, parentColumn: null, child: l.table, childColumn: l.column });
    }
  }
  for (const d of model.viewDeps || []) {
    if (has.has(d.table) && has.has(d.view)) {
      relations.push({ kind: 'view', parent: d.table, parentColumn: null, child: d.view, childColumn: null });
    }
  }
  return { nodes, relations };
}

const TEXT_PADDING = 20; // spacingLeft + spacingRight у строки + внутренний отступ текста draw.io (2 + 2)
const WIDTH_SLACK = 8;   // запас: курсив и жирный рисуются чуть шире, чем измеряются
const WRAP_WASTE = 0.9;  // при переносе по словам строка заполняется не до конца

// Ширина текста строки: в draw.io плагин передаёт точное измерение (opts.measureText),
// без браузера (тесты) — оценка по числу символов.
function rowTextWidth(row, measure) {
  return measure(row.label, row.note ? 11 : 12, /fontStyle=[13];/.test(row.style));
}

// Ширина таблицы; строки, которые в неё не влезли, переносятся — считаем их высоту и Y.
function sizeRows(title, rows, measure) {
  const widest = Math.max(measure(title, 12, true) + 40,
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

function layout(graph, opts) {
  const { nodes: tables, relations } = graph;
  const { level, parents, children } = computeLevels(tables, relations);

  const connected = new Set();
  for (const r of relations) {
    connected.add(r.parent);
    connected.add(r.child);
  }

  const boxes = new Map();
  for (const t of tables) {
    const { width, height } = sizeRows(t.title, t.rows, opts.measureText || estimateTextWidth);
    boxes.set(t.name, { node: t, rows: t.rows, width, height, x: 0, y: 0 });
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
    const row = column == null ? null : box.rows.find(r => r.column === column);
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
      kind: rel.kind || 'fk',
      key: rel.parent + '\u0000' + (pair.parentColumn == null ? '' : pair.parentColumn),
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

function vertex(id, parent, value, style, x, y, w, h, tooltip) {
  const geometry = `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`;
  const label = escapeXml(escapeHtml(value));
  if (tooltip) {
    // Подсказка при наведении — атрибут tooltip у UserObject (так её хранит draw.io).
    return `<UserObject label="${label}" tooltip="${escapeXml(tooltip)}" id="${id}">` +
      `<mxCell style="${escapeXml(style)}" vertex="1" parent="${parent}">${geometry}</mxCell></UserObject>`;
  }
  return `<mxCell id="${id}" value="${label}" style="${escapeXml(style)}" vertex="1" parent="${parent}">${geometry}</mxCell>`;
}

// Основная линия — значки «вороньей лапки»; дополнительная (часть составного ключа) —
// тонкий пунктир без значков. Везде — дуги-«мостики» на пересечениях.
// sqlErLink=1 — метка «наша связь» для команды «Перепроложить связи».
function linkStyle(link) {
  const common = 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;jumpStyle=arc;jumpSize=8;sqlErLink=1;';
  // Колонка → её ENUM: тонкий пунктир без значков.
  if (link.kind === 'enum') return common + 'dashed=1;dashPattern=2 3;startArrow=none;endArrow=none;opacity=60;';
  // Таблица → представление: пунктир со стрелкой «данные идут сюда».
  if (link.kind === 'view') return common + 'dashed=1;dashPattern=6 4;startArrow=none;endArrow=open;endSize=8;opacity=70;';
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
  const graph = schemaGraph(model, opts);
  const { boxes, rowCenter } = layout(graph, opts);

  const links = buildLinks(graph.relations, rowCenter);
  const obstacles = [...boxes.values()].map(b => ({ id: b.node.name, x: b.x, y: b.y, width: b.width, height: b.height }));
  const routes = routeLinks(links, obstacles);

  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const rowIds = new Map(); // "таблица\u0000колонка" → id строки
  const tableIds = new Map();

  let t = 0;
  for (const box of boxes.values()) {
    const tableId = 'sqler-t' + t++;
    const node = box.node;
    tableIds.set(node.name, tableId);
    // sqlErName — ключ узла для режима «Обновить» (подпись пользователь может поменять).
    const nodeStyle = NODE_STYLES[node.kind] + 'sqlErName=' + encodeURIComponent(node.name) + ';';
    cells.push(vertex(tableId, '1', node.title, nodeStyle, box.x, box.y, box.width, box.height));
    box.rows.forEach((row, i) => {
      const rowId = tableId + '-r' + i;
      if (row.column) rowIds.set(node.name + '\u0000' + row.column, rowId);
      cells.push(vertex(rowId, tableId, row.label, row.style, 0, row.y, box.width, row.height, row.tooltip));
    });
  }

  links.forEach((link, i) => {
    const source = (link.parentColumn != null && rowIds.get(link.from + '\u0000' + link.parentColumn)) || tableIds.get(link.from);
    const target = (link.childColumn != null && rowIds.get(link.to + '\u0000' + link.childColumn)) || tableIds.get(link.to);
    if (!source || !target) return;
    const route = routes[i];
    const style = linkStyle(link) + sideStyle(route);
    cells.push(`<mxCell id="sqler-e${i}" style="${escapeXml(style)}" edge="1" parent="1" source="${source}" target="${target}">` +
      `<mxGeometry relative="1" as="geometry">${pointsXml(route.points)}</mxGeometry></mxCell>`);
  });

  return `<mxGraphModel><root>${cells.join('')}</root></mxGraphModel>`;
}

module.exports = { toGraphModelXml, columnLabel, indexLabel, sideStyle, schemaGraph, DEFAULTS };
