'use strict';

// Модель из parser.js → XML графа draw.io (mxGraphModel).
// Таблица — swimlane со стек-раскладкой, каждая колонка — отдельная строка-ячейка,
// связи соединяют строки (PK родителя → FK ребёнка) в нотации «воронья лапка».

const { planLanes, gapWidth, routeRelations } = require('./routing');

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 30;
const MIN_WIDTH = 180;
const MAX_WIDTH = 640;
const CHAR_WIDTH = 6.6;
const H_GAP = 120; // место под стрелки между столбцами
const V_GAP = 40;
const MARGIN = 40;

const TABLE_STYLE =
  'swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=' + HEADER_HEIGHT + ';' +
  'horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;' +
  'marginBottom=0;html=1;';

const ROW_STYLE =
  'text;align=left;verticalAlign=middle;spacingLeft=8;spacingRight=8;overflow=hidden;' +
  'rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;html=1;';

const NOTE_STYLE = ROW_STYLE + 'fontSize=11;textOpacity=60;';
const NOTE_HEIGHT = 24;

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
    rows.push({ column: null, label: '', style: DIVIDER_STYLE, height: DIVIDER_HEIGHT });
    notes.forEach(label => rows.push({ column: null, label, style: NOTE_STYLE, height: NOTE_HEIGHT }));
  }

  let y = HEADER_HEIGHT;
  for (const row of rows) {
    row.y = y;
    y += row.height;
  }
  return rows;
}

function textWidth(text, fontSize = 12) {
  // Грубая оценка ширины; эмодзи шире обычного символа.
  const emoji = /^(🔑|🔍)/.test(text) ? 8 : 0;
  return Array.from(text).length * CHAR_WIDTH * fontSize / 12 + emoji;
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
    // Жирный текст (PK) шире обычного примерно на 10%.
    const rowWidth = r => textWidth(r.label, r.height === NOTE_HEIGHT ? 11 : 12) *
      (/fontStyle=[13];/.test(r.style) ? 1.1 : 1) + 24;
    const widest = Math.max(textWidth(t.name) * 1.1 + 40, ...rows.map(rowWidth));
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(widest / 10) * 10));
    const height = rows.reduce((h, r) => h + r.height, HEADER_HEIGHT);
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
  const lanes = planLanes(relations, columnOf, rowCenter);
  const columnWidth = best.map(names => Math.max(...names.map(n => boxes.get(n).width)));

  x = opts.x + MARGIN;
  best.forEach((names, i) => {
    columnX[i] = x;
    stack(names, x);
    x += columnWidth[i] + gapWidth(lanes, i);
  });

  return { boxes, columns: best, columnX, columnWidth, columnOf, rowCenter, lanes };
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

// Значки «вороньей лапки» + дуги-«мостики» там, где линии пересекаются.
function markers(rel) {
  const start = rel.optional ? 'ERzeroToOne' : 'ERmandOne';
  const end = rel.oneToOne ? 'ERzeroToOne' : 'ERmany';
  return `html=1;startArrow=${start};endArrow=${end};startFill=0;endFill=0;jumpStyle=arc;jumpSize=8;`;
}

// Прямоугольная линия по заданным точкам: из правого края строки родителя в левый край строки ребёнка.
const ROUTED_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;' +
  'exitX=1;exitY=0.5;exitDx=0;exitDy=0;exitPerimeter=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;entryPerimeter=0;';

function pointsXml(points) {
  if (!points.length) return '';
  return '<Array as="points">' + points.map(p => `<mxPoint x="${Math.round(p.x)}" y="${Math.round(p.y)}"/>`).join('') + '</Array>';
}

function toGraphModelXml(model, options) {
  const opts = Object.assign({}, DEFAULTS, options);
  const geometry = layout(model, opts);
  const { boxes } = geometry;
  const routes = routeRelations(model.relations, geometry);

  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const rowIds = new Map(); // "таблица\u0000колонка" → id строки
  const tableIds = new Map();

  let t = 0;
  for (const box of boxes.values()) {
    const tableId = 'sqler-t' + t++;
    tableIds.set(box.table.name, tableId);
    cells.push(vertex(tableId, '1', box.table.name, TABLE_STYLE, box.x, box.y, box.width, box.height));
    box.rows.forEach((row, i) => {
      const rowId = tableId + '-r' + i;
      if (row.column) rowIds.set(box.table.name + '\u0000' + row.column, rowId);
      cells.push(vertex(rowId, tableId, row.label, row.style, 0, row.y, box.width, row.height));
    });
  }

  model.relations.forEach((rel, i) => {
    const source = rowIds.get(rel.parent + '\u0000' + rel.parentColumn) || tableIds.get(rel.parent);
    const target = rowIds.get(rel.child + '\u0000' + rel.childColumn) || tableIds.get(rel.child);
    if (!source || !target) return;

    let style;
    let points = '';
    if (routes.has(i)) {
      style = ROUTED_STYLE + markers(rel);
      points = pointsXml(routes.get(i));
    } else if (rel.parent === rel.child) {
      // Ссылка на себя — петля слева: справа от PK уходят связи к дочерним таблицам.
      const box = boxes.get(rel.parent);
      const px = box.x - 30;
      style = 'edgeStyle=orthogonalEdgeStyle;rounded=0;exitX=0;exitY=0.5;entryX=0;entryY=0.5;' + markers(rel);
      points = pointsXml([
        { x: px, y: geometry.rowCenter(rel.parent, rel.parentColumn) },
        { x: px, y: geometry.rowCenter(rel.child, rel.childColumn) }
      ]);
    } else {
      // Редкий случай (цикл ссылок): ребёнок не правее родителя — стандартная ER-линия.
      style = 'edgeStyle=entityRelationEdgeStyle;' + markers(rel);
    }

    cells.push(`<mxCell id="sqler-e${i}" style="${escapeXml(style)}" edge="1" parent="1" source="${source}" target="${target}">` +
      `<mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`);
  });

  return `<mxGraphModel><root>${cells.join('')}</root></mxGraphModel>`;
}

module.exports = { toGraphModelXml, columnLabel, indexLabel };
